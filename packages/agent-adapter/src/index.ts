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
  structurePath?: string;
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
  const workDir = path.join(path.dirname(path.resolve(input.outputDir)), ".agent-work", safePathSegment(input.jobId));
  await fs.mkdir(workDir, { recursive: true });
  const promptInput = await stageAgentArtifacts(input, workDir);
  const prompt = buildAgentPrompt(promptInput);
  const promptPath = path.join(workDir, "prompt.md");
  await fs.writeFile(promptPath, prompt, "utf8");

  const beforeRaw = await snapshotTree(input.rawRoot, input.bundlePath);
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
  const afterRaw = await snapshotTree(input.rawRoot, input.bundlePath);
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
  const outputFormat = ".md" as const;
  const structuredArtifacts = input.artifacts.filter((artifact) => artifact.structurePath);
  const hasStructuredArtifacts = structuredArtifacts.length > 0;
  const hasImageOcrStructure = structuredArtifacts.some((artifact) => artifact.kind === "image_ocr_text");
  const hasDocxStructure = structuredArtifacts.some((artifact) => artifact.kind === "docx_text");
  const artifactLines = input.artifacts.length === 0
    ? ["- None"]
    : input.artifacts.map((artifact) => [
        `- ${artifact.fileName}`,
        `  - kind: ${artifact.kind}`,
        `  - path: ${artifact.sourcePath}`,
        ...(artifact.structurePath ? [`  - structure path: ${artifact.structurePath}`] : []),
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
    "Use the fixed business document translation preset below whenever translation is needed.",
    "Run the translator/reviewer methodology internally; do not write separate draft files unless they are needed for the final deliverable.",
    hasStructuredArtifacts
      ? "Create text output files only: `translated.md` and `translations.json`. Do not use DOCX/PDF/HWP/HWPX/ZIP/binary document generation tools or skills."
      : "Create Markdown only. Do not use DOCX/PDF/HWP/HWPX/ZIP/binary document generation tools or skills.",
    "Use Markdown headings, numbering, tables, and lists to preserve the source structure clearly for the worker renderer.",
    "Do not flatten paragraphs, tables, numbered clauses, or lists into one pasted block.",
    ...(hasStructuredArtifacts
      ? [
          "For artifacts with a structure path, also create `translations.json` using the exact block ids from that structure file.",
          "The JSON schema is: `{ \"schemaVersion\": 1, \"blocks\": [{ \"id\": \"b0001\", \"text\": \"translated block text\" }] }`.",
          "Do not omit, rename, merge, split, or reorder block ids in `translations.json`; leave uncertain blocks translated as faithfully as possible.",
          "Translate every natural-language phrase inside each block into the target language, including mixed English/Chinese/Korean/Japanese/Latin-script text; preserve only true names, product codes, URLs, units, and formulas where translation would change their identity.",
          ...(hasDocxStructure
            ? ["For DOCX structure artifacts, the worker uses `translations.json` to preserve the original DOCX package/template while replacing body text."]
            : []),
          ...(hasImageOcrStructure
            ? ["For image OCR structure artifacts, the worker uses `translations.json` to draw translated text back over the original image at the recorded bounding boxes."]
            : []),
          "Keep translation metadata, glossary, and translator notes in `translated.md`; the worker preserves those support sections around structured DOCX/image rendering when possible.",
          "The job is incomplete unless both `translated.md` and `translations.json` exist directly in the output directory.",
        ]
      : []),
    "Do not append the original/source section yourself unless the operator explicitly asks for agent-side source reproduction. The worker composes the final deliverable and appends the source section separately.",
    "Do not create DOCX, PDF, HWP, HWPX, ZIP, or other binary output yourself. The worker renders and validates the final Telegram-deliverable file.",
    "",
    "## Prepared Artifacts",
    "",
    ...artifactLines,
    "",
    "## Required Output",
    "",
    hasStructuredArtifacts
      ? "- Create exactly these two text files directly in the output directory: `translated.md` for human review and `translations.json` for worker-owned structured rendering."
      : "- Create exactly one final translated Markdown file named `translated.md` in the output directory.",
    "- Do not create `.docx`, `.pdf`, `.hwp`, `.hwpx`, `.zip`, or any other binary document file.",
    "- Put translation metadata, glossary, translated document, and translator notes into `translated.md`. Put only block id translations in `translations.json` when that file is required. Do not append a duplicate original/source section unless explicitly requested, because the worker may append `[원문]` itself.",
    "- Keep any temporary reasoning or scratch files out of the output directory.",
    "",
    buildBusinessDocumentTranslationPreset(input, outputFormat),
    "",
  ].join("\n");
}

async function stageAgentArtifacts(input: AgentPostprocessInput, workDir: string): Promise<AgentPostprocessInput> {
  if (input.artifacts.length === 0) {
    return input;
  }
  const artifactsDir = path.join(workDir, "artifacts");
  await fs.rm(artifactsDir, { recursive: true, force: true });
  await fs.mkdir(artifactsDir, { recursive: true });
  const artifacts = await Promise.all(input.artifacts.map(async (artifact, index) => {
    const artifactDir = path.join(
      artifactsDir,
      `${String(index + 1).padStart(3, "0")}-${safePathSegment(artifact.id || artifact.fileName)}`,
    );
    await fs.mkdir(artifactDir, { recursive: true });
    const stagedSourcePath = path.join(artifactDir, path.basename(artifact.sourcePath));
    await fs.copyFile(artifact.sourcePath, stagedSourcePath);
    let stagedStructurePath: string | undefined;
    if (artifact.structurePath) {
      stagedStructurePath = path.join(artifactDir, path.basename(artifact.structurePath));
      await fs.copyFile(artifact.structurePath, stagedStructurePath);
    }
    return {
      ...artifact,
      sourcePath: stagedSourcePath,
      ...(stagedStructurePath ? { structurePath: stagedStructurePath } : {}),
    };
  }));
  return {
    ...input,
    artifacts,
  };
}

function safePathSegment(value: string): string {
  const sanitized = value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return sanitized.length > 0 ? sanitized.slice(0, 80) : "artifact";
}

function buildBusinessDocumentTranslationPreset(input: AgentPostprocessInput, outputFormat: ".md"): string {
  const sourceLanguage = input.language.primaryLanguage || "unknown";
  const targetLanguage = input.targetLanguage || input.language.targetLanguage || "ko";
  const documentType = input.instructions
    ? "business/legal/administrative document; refine from operator instructions when specified"
    : "business/legal/administrative document";
  const scope = "full uploaded document represented by the finalized raw bundle and prepared artifacts";

  return [
    "# Business Document Translation Preset",
    "",
    "## ROLE",
    "You are a senior translator with 20+ years of experience specializing in legal, administrative, and business documents. You orchestrate a multi-agent workflow (2 translators + 1 reviewer) to produce publication-quality translations.",
    "",
    "## TASK",
    "Translate the uploaded document package using the three-agent methodology defined below.",
    "",
    "## INPUT PARAMETERS",
    `- SOURCE_LANG: ${sourceLanguage}`,
    `- TARGET_LANG: ${targetLanguage}`,
    `- DOCUMENT_TYPE: ${documentType}`,
    `- SCOPE: ${scope}`,
    `- OUTPUT_FORMAT: ${outputFormat} (worker-rendered to the final Telegram document format)`,
    "- PRIORITY: balanced",
    "",
    "## AGENT WORKFLOW",
    "",
    "### Phase 1 - Input Analysis (Orchestrator)",
    "Before translation, produce:",
    "1. **Document profile**: type, domain, total length, page range in scope",
    "2. **Structural map**: chapters, sections, subsections, tables, footnotes",
    "3. **Terminology inventory**: extract 20-50 recurring domain-specific terms (legal, financial, technical) that must remain consistent",
    "4. **Style determination**: formality register to apply in TARGET_LANG",
    "",
    "Output: A brief analysis summary + Glossary v1 (SOURCE -> TARGET term table) before proceeding.",
    "",
    "### Phase 2 - Parallel Translation",
    "",
    "**Translator A - Literal-Faithful Strategy**",
    "- Prioritize structural and semantic fidelity to source",
    "- Preserve sentence boundaries and logical connectors",
    "- Conservative with restructuring; keep source emphasis order",
    "- When ambiguous: choose the reading that minimizes interpretive leap",
    "",
    "**Translator B - Natural-Idiomatic Strategy**",
    "- Prioritize naturalness and readability in TARGET_LANG",
    "- Restructure sentences when source grammar is awkward in TARGET_LANG",
    "- Use idiomatic expressions of the target language's formal register",
    "- Optimize for the reader's cognitive flow while preserving all information",
    "",
    "Both translators MUST:",
    "- Apply Glossary v1 consistently",
    "- Translate mixed-language source passages completely into TARGET_LANG, including embedded English or Latin-script phrases when they are ordinary natural-language content rather than proper names/codes",
    "- Preserve all numbers, dates, proper nouns, code references verbatim",
    "- Retain source document's layout: headings, numbering, tables, lists",
    "- Flag uncertain terms with `[?term]` for reviewer attention",
    "",
    "### Phase 3 - Review & Synthesis (Reviewer)",
    "The reviewer produces the final version by:",
    "1. **Accuracy check**: compare both translations against source; flag mistranslations",
    "2. **Consistency check**: enforce glossary uniformity across entire document",
    "3. **Register check**: verify formal/official tone appropriate for DOCUMENT_TYPE",
    "4. **Synthesis**: merge the stronger choice from A or B at each passage",
    "   - Default to B's phrasing when both are accurate",
    "   - Default to A's phrasing when precision is legally material (e.g., contract clauses, regulatory language, financial figures)",
    "5. **Resolve flags**: resolve all `[?term]` markers with explicit justification",
    "6. **Final polish**: eliminate awkwardness, ensure terminology consistency",
    "",
    "## HARD CONSTRAINTS",
    "",
    "1. **Accuracy** - No omissions, no hallucinations. Every clause of the source must be represented. If a passage is ambiguous, choose the most defensible reading and note the alternative in a translator's note.",
    "",
    "2. **Formal register** - Use TARGET_LANG's official/business document register (e.g., Korean: `~합니다`, `~아니합니다`, `~에 해당합니다`).",
    "",
    "3. **Terminology consistency** - Each source term maps to ONE target term across the document. Glossary is authoritative.",
    "",
    "4. **Layout preservation** - Retain original document structure exactly: chapter/section/subsection numbering, table structure, list hierarchy, footnote references.",
    "",
    "5. **Cultural adaptation for format** - Follow the target country's standard conventions for official documents (Korean: 제1절, 제2절; English: Article I, Section 1; etc.).",
    "",
    "6. **Verbatim elements** - Never translate: proper nouns of companies/persons (transliterate + original in parentheses on first mention), legal code numbers, stock tickers, chemical formulas, product codes, URLs.",
    "",
    "## OUTPUT SPECIFICATION",
    "",
    "Deliver in this order:",
    "",
    "1. **Translation metadata block**",
    "",
    "Document: [title]",
    "Scope: [pages/sections translated]",
    "Source -> Target: [langs]",
    "Glossary version: [v1/v2]",
    "",
    "2. **Glossary**: SOURCE term | TARGET term | Notes",
    "",
    "3. **Translated document** in requested OUTPUT_FORMAT, preserving all structure",
    "",
    "4. **Translator's notes** (if any): ambiguities, deliberate interpretation choices, untranslatable elements",
    "",
    "For long documents (>50 pages):",
    "- Translate in section-sized chunks",
    "- Confirm glossary adherence after each chunk",
    "- Produce a consolidated final deliverable",
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

export async function snapshotTree(root: string, scopeRoot = root): Promise<Map<string, string>> {
  const resolvedRoot = path.resolve(root);
  const resolvedScopeRoot = path.resolve(scopeRoot);
  if (!isPathInside(resolvedRoot, resolvedScopeRoot)) {
    throw new AgentAdapterError(`Snapshot scope must be inside root: ${scopeRoot}`);
  }
  const entries = new Map<string, string>();
  try {
    await fs.access(resolvedScopeRoot);
  } catch {
    return entries;
  }
  await snapshotDirectory(resolvedRoot, resolvedScopeRoot, entries);
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
