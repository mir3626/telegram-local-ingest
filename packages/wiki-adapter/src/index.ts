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

export type WikiInputRole = "canonical_text" | "translation_aid" | "evidence_original" | "structure";

export interface WikiIngestContractInput {
  id: string;
  role: WikiInputRole;
  relativePath: string;
  absolutePath: string;
  name: string;
  sourceKind?: string;
  readByDefault: boolean;
}

export interface WikiIngestContract {
  version: "telegram-local-ingest.llmwiki.v1";
  manifestPath: string;
  sourceMarkdownPath: string;
  inputs: WikiIngestContractInput[];
  defaultInputs: WikiIngestContractInput[];
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
    const contract = await loadWikiIngestContract(input.bundlePath);
    const beforeRaw = await snapshotTree(input.rawRoot, input.bundlePath);
    const command = buildWikiIngestCommand(input, contract);
    const result = await runner(command.command, command.args);
    const afterRaw = await snapshotTree(input.rawRoot, input.bundlePath);
    const rawDiff = diffSnapshots(beforeRaw, afterRaw);
    if (rawDiff.length > 0) {
      throw new WikiAdapterError(`Wiki ingest adapter modified raw bundle files: ${rawDiff.join(", ")}`);
    }
    if (result.exitCode !== 0) {
      throw new WikiAdapterError(`Wiki ingest adapter failed: ${result.stderr || result.stdout}`);
    }
    await assertRequiredWikiOutputs(input.wikiRoot);
    return {
      command: command.command,
      args: command.args,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  });
}

export function buildWikiIngestCommand(input: WikiIngestAdapterInput, contract?: WikiIngestContract): { command: string; args: string[] } {
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
  if (contract) {
    args.push(
      "--contract-version",
      contract.version,
      "--source",
      contract.sourceMarkdownPath,
      "--manifest",
      contract.manifestPath,
      "--require-citations",
      "canonical_input_id_or_path",
      "--index",
      path.join(path.resolve(input.wikiRoot), "index.md"),
      "--log",
      path.join(path.resolve(input.wikiRoot), "log.md"),
    );
    for (const wikiInput of contract.inputs) {
      args.push("--wiki-input", JSON.stringify({
        id: wikiInput.id,
        role: wikiInput.role,
        path: wikiInput.relativePath,
        relativePath: wikiInput.relativePath,
        name: wikiInput.name,
        readByDefault: wikiInput.readByDefault,
        ...(wikiInput.sourceKind ? { sourceKind: wikiInput.sourceKind } : {}),
      }));
    }
  }
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

export async function loadWikiIngestContract(bundlePath: string): Promise<WikiIngestContract> {
  const resolvedBundle = path.resolve(bundlePath);
  const manifestPath = path.join(resolvedBundle, "manifest.yaml");
  const sourceMarkdownPath = path.join(resolvedBundle, "source.md");
  const [manifest] = await Promise.all([
    fs.readFile(manifestPath, "utf8"),
    fs.access(sourceMarkdownPath),
  ]);
  if (!/^schema_version:\s*2\s*$/m.test(manifest)) {
    throw new WikiAdapterError(`Raw bundle manifest must use schema_version: 2: ${manifestPath}`);
  }

  const inputs = parseWikiInputs(manifest).map((record) => resolveWikiInputRecord(resolvedBundle, record));
  const defaultInputs = inputs.filter((record) => record.readByDefault);
  return {
    version: "telegram-local-ingest.llmwiki.v1",
    manifestPath,
    sourceMarkdownPath,
    inputs,
    defaultInputs,
  };
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

interface RawWikiInputRecord {
  id?: string;
  role?: string;
  path?: string;
  name?: string;
  source_kind?: string;
  read_by_default?: string;
}

function parseWikiInputs(manifest: string): RawWikiInputRecord[] {
  const lines = manifest.split(/\r?\n/);
  const startIndex = lines.findIndex((line) => line.trim() === "wiki_inputs:");
  if (startIndex === -1) {
    return [];
  }

  const records: RawWikiInputRecord[] = [];
  let current: RawWikiInputRecord | null = null;
  for (const line of lines.slice(startIndex + 1)) {
    if (/^\S/.test(line) && line.trim().length > 0) {
      break;
    }
    const itemMatch = line.match(/^\s*-\s+([a-z_]+):\s*(.+)$/);
    if (itemMatch) {
      current = { [itemMatch[1] ?? ""]: parseYamlScalar(itemMatch[2] ?? "") };
      records.push(current);
      continue;
    }
    const fieldMatch = line.match(/^\s{4}([a-z_]+):\s*(.+)$/);
    if (fieldMatch && current) {
      current[fieldMatch[1] as keyof RawWikiInputRecord] = parseYamlScalar(fieldMatch[2] ?? "");
    }
  }
  return records;
}

function resolveWikiInputRecord(bundlePath: string, record: RawWikiInputRecord): WikiIngestContractInput {
  if (!record.id || !record.role || !record.path || !record.name) {
    throw new WikiAdapterError("Malformed wiki_inputs record in manifest.yaml");
  }
  if (!isWikiInputRole(record.role)) {
    throw new WikiAdapterError(`Unsupported wiki input role: ${record.role}`);
  }
  if (path.isAbsolute(record.path) || record.path.split(/[\\/]+/).includes("..")) {
    throw new WikiAdapterError(`Wiki input path must be bundle-relative: ${record.path}`);
  }
  if (isRenderedOutputPath(record.path) || isRenderedOutputPath(record.name)) {
    throw new WikiAdapterError(`Rendered output cannot be a wiki source input: ${record.path}`);
  }

  const absolutePath = path.resolve(bundlePath, record.path);
  if (!isPathInside(bundlePath, absolutePath)) {
    throw new WikiAdapterError(`Wiki input path escapes bundle: ${record.path}`);
  }

  const readByDefault = record.read_by_default === "true";
  if (readByDefault && record.role !== "canonical_text") {
    throw new WikiAdapterError(`Only canonical_text inputs may be read by default: ${record.id}`);
  }

  return {
    id: record.id,
    role: record.role,
    relativePath: record.path.replace(/\\/g, "/"),
    absolutePath,
    name: record.name,
    ...(record.source_kind ? { sourceKind: record.source_kind } : {}),
    readByDefault,
  };
}

export async function snapshotTree(root: string, scopeRoot = root): Promise<Map<string, string>> {
  const resolvedRoot = path.resolve(root);
  const resolvedScopeRoot = path.resolve(scopeRoot);
  if (!isPathInside(resolvedRoot, resolvedScopeRoot)) {
    throw new WikiAdapterError(`Snapshot scope must be inside root: ${scopeRoot}`);
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

async function assertRequiredWikiOutputs(wikiRoot: string): Promise<void> {
  const root = path.resolve(wikiRoot);
  const missing: string[] = [];
  for (const name of ["index.md", "log.md"]) {
    try {
      await fs.access(path.join(root, name));
    } catch {
      missing.push(name);
    }
  }
  if (missing.length > 0) {
    throw new WikiAdapterError(`Wiki ingest adapter did not update required wiki files: ${missing.join(", ")}`);
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

function isWikiInputRole(value: string): value is WikiInputRole {
  return value === "canonical_text" || value === "translation_aid" || value === "evidence_original" || value === "structure";
}

function isRenderedOutputPath(value: string): boolean {
  const normalized = value.replace(/\\/g, "/").toLowerCase();
  return normalized.includes("runtime/outputs/")
    || normalized.includes("_translated.")
    || normalized.endsWith(".transcript.docx")
    || normalized.endsWith("_transcript.docx");
}

function parseYamlScalar(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('"')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      return typeof parsed === "string" ? parsed : String(parsed);
    } catch {
      return trimmed.slice(1, trimmed.endsWith('"') ? -1 : undefined);
    }
  }
  return trimmed;
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
