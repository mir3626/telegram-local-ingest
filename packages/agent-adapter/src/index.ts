import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

export interface AgentLanguageContext {
  primaryLanguage: string;
  confidence: number;
  translationNeeded: boolean;
  targetLanguage: string;
  reason?: string;
}

export interface AgentTextArtifact {
  id: string;
  kind: string;
  fileName: string;
  sourcePath: string;
  charCount: number;
  truncated: boolean;
}

export interface AgentPostprocessInput {
  command: string;
  jobId: string;
  bundlePath: string;
  rawRoot: string;
  outputDir: string;
  projectRoot?: string;
  targetLanguage: string;
  defaultRelation: string;
  language: AgentLanguageContext;
  artifacts: AgentTextArtifact[];
  instructions?: string;
  timeoutMs?: number;
}

export interface AgentPostprocessResult {
  command: string;
  args: string[];
  promptPath: string;
  outputDir: string;
  stdout: string;
  stderr: string;
}

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface CommandOptions {
  cwd: string;
  stdin: string;
  timeoutMs: number;
}

export type CommandRunner = (command: string, args: string[], options: CommandOptions) => Promise<CommandResult>;

export class AgentAdapterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentAdapterError";
  }
}

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

export async function runAgentPostprocess(
  input: AgentPostprocessInput,
  runner: CommandRunner = runCommand,
): Promise<AgentPostprocessResult> {
  validateAgentPaths(input);
  await fs.mkdir(input.outputDir, { recursive: true });
  const workDir = path.join(path.dirname(path.resolve(input.outputDir)), ".agent-work", path.basename(input.outputDir));
  await fs.mkdir(workDir, { recursive: true });
  const prompt = buildAgentPrompt(input);
  const promptPath = path.join(workDir, "prompt.md");
  await fs.writeFile(promptPath, prompt, "utf8");

  const beforeRaw = await snapshotTree(input.rawRoot);
  const command = buildAgentCommand(input.command, {
    bundlePath: path.resolve(input.bundlePath),
    jobId: input.jobId,
    outputDir: path.resolve(input.outputDir),
    projectRoot: path.resolve(input.projectRoot ?? process.cwd()),
    promptFile: promptPath,
  });
  const result = await runner(command.command, command.args, {
    cwd: workDir,
    stdin: command.usesPromptPlaceholder ? "" : prompt,
    timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  });
  const afterRaw = await snapshotTree(input.rawRoot);
  const rawDiff = diffSnapshots(beforeRaw, afterRaw);
  if (rawDiff.length > 0) {
    throw new AgentAdapterError(`Agent postprocess modified raw files: ${rawDiff.join(", ")}`);
  }
  if (result.exitCode !== 0) {
    throw new AgentAdapterError(`Agent postprocess failed: ${result.stderr || result.stdout}`);
  }

  return {
    command: command.command,
    args: command.args,
    promptPath,
    outputDir: path.resolve(input.outputDir),
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

export function buildAgentPrompt(input: AgentPostprocessInput): string {
  const artifactLines = input.artifacts.length === 0
    ? ["- None"]
    : input.artifacts.map((artifact) => [
        `- ${artifact.fileName}`,
        `  - kind: ${artifact.kind}`,
        `  - path: ${artifact.sourcePath}`,
        `  - chars: ${artifact.charCount}${artifact.truncated ? " (truncated preview)" : ""}`,
      ].join("\n"));

  return [
    "# Telegram Local Ingest Post-Processing",
    "",
    "You are running as a local, operator-only document post-processing agent.",
    "",
    "## Hard Boundaries",
    "",
    `- Read the finalized raw bundle at: ${path.resolve(input.bundlePath)}`,
    `- Write generated deliverables only under: ${path.resolve(input.outputDir)}`,
    "- Do not modify, delete, rename, or create files under raw/**.",
    "- Do not read .env, bot tokens, OAuth credential stores, SQLite databases, or unrelated workspace files.",
    "- Preserve factual content. Do not invent missing details.",
    "",
    "## Task",
    "",
    `- Target language: ${input.targetLanguage}`,
    `- Relationship/tone preset: ${input.defaultRelation}`,
    `- Detected source language: ${input.language.primaryLanguage}`,
    `- Detection confidence: ${input.language.confidence}`,
    `- Translation needed: ${input.language.translationNeeded}`,
    input.instructions ? `- Operator instructions: ${input.instructions}` : "- Operator instructions: none",
    "",
    "Translate when needed, keep terminology consistent, preserve a professional business tone, and format the result as clean Markdown unless the source format requires a different practical output.",
    "",
    "## Prepared Artifacts",
    "",
    ...artifactLines,
    "",
    "## Required Output",
    "",
    "- Create at least one operator-downloadable file in the output directory.",
    "- Prefer `translated.md` for translated or reformatted Markdown output.",
    "- Keep any temporary reasoning or scratch files out of the output directory.",
    "",
  ].join("\n");
}

export function buildAgentCommand(
  commandLine: string,
  replacements: { bundlePath: string; jobId: string; outputDir: string; projectRoot?: string; promptFile: string },
): { command: string; args: string[]; usesPromptPlaceholder: boolean } {
  const [command, ...args] = parseCommandLine(commandLine).map((token) => replaceToken(token, replacements));
  if (!command) {
    throw new AgentAdapterError("Agent postprocess command is required");
  }
  return {
    command,
    args,
    usesPromptPlaceholder: commandLine.includes("{promptFile}"),
  };
}

export function parseCommandLine(value: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if ((char === '"' || char === "'") && quote === null) {
      quote = char;
      continue;
    }
    if (char === quote) {
      quote = null;
      continue;
    }
    if (/\s/.test(char ?? "") && quote === null) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (quote !== null) {
    throw new AgentAdapterError("Unclosed quote in agent command");
  }
  if (current.length > 0) {
    tokens.push(current);
  }
  return tokens;
}

export async function snapshotTree(root: string): Promise<Map<string, string>> {
  const resolvedRoot = path.resolve(root);
  const entries = new Map<string, string>();
  try {
    await fs.access(resolvedRoot);
  } catch {
    return entries;
  }
  await snapshotDirectory(resolvedRoot, resolvedRoot, entries);
  return entries;
}

function validateAgentPaths(input: AgentPostprocessInput): void {
  const rawRoot = path.resolve(input.rawRoot);
  const bundlePath = path.resolve(input.bundlePath);
  const outputDir = path.resolve(input.outputDir);
  if (!isPathInside(rawRoot, bundlePath)) {
    throw new AgentAdapterError(`Bundle path must be inside rawRoot: ${input.bundlePath}`);
  }
  if (isPathInside(rawRoot, outputDir)) {
    throw new AgentAdapterError("Agent outputDir must not be inside rawRoot");
  }
}

function replaceToken(
  token: string,
  replacements: { bundlePath: string; jobId: string; outputDir: string; projectRoot?: string; promptFile: string },
): string {
  return token
    .replaceAll("{bundlePath}", replacements.bundlePath)
    .replaceAll("{jobId}", replacements.jobId)
    .replaceAll("{outputDir}", replacements.outputDir)
    .replaceAll("{projectRoot}", replacements.projectRoot ?? process.cwd())
    .replaceAll("{promptFile}", replacements.promptFile);
}

function diffSnapshots(before: Map<string, string>, after: Map<string, string>): string[] {
  const diffs: string[] = [];
  for (const [key, hash] of before) {
    if (!after.has(key)) {
      diffs.push(`deleted:${key}`);
      continue;
    }
    if (after.get(key) !== hash) {
      diffs.push(`modified:${key}`);
    }
  }
  for (const key of after.keys()) {
    if (!before.has(key)) {
      diffs.push(`added:${key}`);
    }
  }
  return diffs.sort();
}

async function snapshotDirectory(root: string, current: string, entries: Map<string, string>): Promise<void> {
  for (const entry of await fs.readdir(current, { withFileTypes: true })) {
    const fullPath = path.join(current, entry.name);
    if (entry.isDirectory()) {
      await snapshotDirectory(root, fullPath, entries);
      continue;
    }
    if (entry.isFile()) {
      const relative = path.relative(root, fullPath).replace(/\\/g, "/");
      entries.set(relative, await sha256File(fullPath));
    }
  }
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  hash.update(await fs.readFile(filePath));
  return hash.digest("hex");
}

function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function runCommand(command: string, args: string[], options: CommandOptions): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, windowsHide: true });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      resolve({ exitCode: 124, stdout, stderr: `${stderr}\nTimed out after ${options.timeoutMs}ms`.trim() });
    }, options.timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (exitCode) => {
      clearTimeout(timeout);
      resolve({ exitCode: exitCode ?? 1, stdout, stderr });
    });
    child.stdin.end(options.stdin);
  });
}
