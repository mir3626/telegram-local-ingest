import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

export interface WikiIngestAdapterInput {
  command: string;
  bundlePath: string;
  rawRoot: string;
  wikiRoot: string;
  lockPath: string;
  jobId: string;
  project?: string;
  tags?: string[];
  instructions?: string;
}

export interface WikiIngestAdapterResult {
  command: string;
  args: string[];
  stdout: string;
  stderr: string;
}

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type CommandRunner = (command: string, args: string[]) => Promise<CommandResult>;

export class WikiAdapterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WikiAdapterError";
  }
}

export async function runWikiIngestAdapter(
  input: WikiIngestAdapterInput,
  runner: CommandRunner = runCommand,
): Promise<WikiIngestAdapterResult> {
  validateAdapterPaths(input);
  return withWikiWriteLock(input.lockPath, async () => {
    const beforeRaw = await snapshotTree(input.rawRoot);
    const command = buildWikiIngestCommand(input);
    const result = await runner(command.command, command.args);
    const afterRaw = await snapshotTree(input.rawRoot);
    const rawDiff = diffSnapshots(beforeRaw, afterRaw);
    if (rawDiff.length > 0) {
      throw new WikiAdapterError(`Wiki ingest adapter modified raw bundle files: ${rawDiff.join(", ")}`);
    }
    if (result.exitCode !== 0) {
      throw new WikiAdapterError(`Wiki ingest adapter failed: ${result.stderr || result.stdout}`);
    }
    return {
      command: command.command,
      args: command.args,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  });
}

export function buildWikiIngestCommand(input: WikiIngestAdapterInput): { command: string; args: string[] } {
  const [command, ...baseArgs] = parseCommandLine(input.command);
  if (!command) {
    throw new WikiAdapterError("WIKI_INGEST_COMMAND is required");
  }
  const args = [
    ...baseArgs,
    "--bundle",
    path.resolve(input.bundlePath),
    "--wiki-root",
    path.resolve(input.wikiRoot),
    "--raw-root",
    path.resolve(input.rawRoot),
    "--job-id",
    input.jobId,
  ];
  if (input.project) {
    args.push("--project", input.project);
  }
  for (const tag of input.tags ?? []) {
    args.push("--tag", tag);
  }
  if (input.instructions) {
    args.push("--instructions", input.instructions);
  }
  return { command, args };
}

export async function withWikiWriteLock<T>(lockPath: string, fn: () => Promise<T>): Promise<T> {
  await fs.mkdir(path.dirname(path.resolve(lockPath)), { recursive: true });
  const handle = await fs.open(lockPath, "wx").catch((error) => {
    if (isNodeError(error) && error.code === "EEXIST") {
      throw new WikiAdapterError(`Wiki write lock is already held: ${lockPath}`);
    }
    throw error;
  });
  try {
    await handle.writeFile(`${process.pid}\n`, "utf8");
    return await fn();
  } finally {
    await handle.close();
    await fs.rm(lockPath, { force: true });
  }
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
    throw new WikiAdapterError("Unclosed quote in WIKI_INGEST_COMMAND");
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

function validateAdapterPaths(input: WikiIngestAdapterInput): void {
  const rawRoot = path.resolve(input.rawRoot);
  const bundlePath = path.resolve(input.bundlePath);
  const wikiRoot = path.resolve(input.wikiRoot);
  if (!isPathInside(rawRoot, bundlePath)) {
    throw new WikiAdapterError(`Bundle path must be inside rawRoot: ${input.bundlePath}`);
  }
  if (isPathInside(rawRoot, wikiRoot) || isPathInside(wikiRoot, rawRoot)) {
    throw new WikiAdapterError("wikiRoot and rawRoot must not overlap");
  }
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

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function runCommand(command: string, args: string[]): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (exitCode) => {
      resolve({ exitCode: exitCode ?? 1, stdout, stderr });
    });
  });
}
