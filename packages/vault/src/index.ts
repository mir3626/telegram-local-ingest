import fs from "node:fs/promises";
import path from "node:path";

import type { StoredJob, StoredJobEvent, StoredJobFile } from "@telegram-local-ingest/db";

export interface RawBundlePaths {
  root: string;
  manifest: string;
  sourceMarkdown: string;
  logMarkdown: string;
  originalDir: string;
  normalizedDir: string;
  extractedDir: string;
  finalizedMarker: string;
}

export interface RawBundlePathInput {
  vaultPath: string;
  rawRoot: string;
  date: string;
  sourceId: string;
}

export interface RawBundleArtifactInput {
  sourcePath: string;
  name?: string;
  sha256?: string;
  mimeType?: string;
  sizeBytes?: number;
}

export interface RawBundleWriteInput {
  vaultPath: string;
  rawRoot: string;
  job: StoredJob;
  files: StoredJobFile[];
  events?: StoredJobEvent[];
  normalizedArtifacts?: RawBundleArtifactInput[];
  extractedArtifacts?: RawBundleArtifactInput[];
  now?: string;
}

export interface RawBundleWriteResult {
  id: string;
  paths: RawBundlePaths;
  originalFiles: BundleFileRecord[];
  normalizedFiles: BundleFileRecord[];
  extractedFiles: BundleFileRecord[];
  finalizedAt: string;
}

export interface BundleFileRecord {
  id?: string;
  name: string;
  relativePath: string;
  sha256?: string;
  mimeType?: string;
  sizeBytes?: number;
}

export class RawBundleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RawBundleError";
  }
}

export async function writeRawBundle(input: RawBundleWriteInput): Promise<RawBundleWriteResult> {
  const finalizedAt = input.now ?? new Date().toISOString();
  const sourceId = sanitizePathSegment(input.job.id);
  const date = datePart(input.job.createdAt);
  const paths = buildRawBundlePaths({
    vaultPath: input.vaultPath,
    rawRoot: input.rawRoot,
    date,
    sourceId,
  });

  await assertBundleWritable(paths);
  await fs.mkdir(paths.originalDir, { recursive: true });
  await fs.mkdir(paths.normalizedDir, { recursive: true });
  await fs.mkdir(paths.extractedDir, { recursive: true });

  const originalFiles = await copyJobFiles(input.files, paths.originalDir, "original");
  const normalizedFiles = await copyArtifacts(input.normalizedArtifacts ?? [], paths.normalizedDir, "normalized");
  const extractedFiles = await copyArtifacts(input.extractedArtifacts ?? [], paths.extractedDir, "extracted");

  await fs.writeFile(paths.manifest, renderManifest(input, {
    id: sourceId,
    paths,
    originalFiles,
    normalizedFiles,
    extractedFiles,
    finalizedAt,
  }), "utf8");
  await fs.writeFile(paths.sourceMarkdown, renderSourceMarkdown(input.job, sourceId, originalFiles, normalizedFiles, extractedFiles), "utf8");
  await fs.writeFile(paths.logMarkdown, renderLogMarkdown(input.events ?? []), "utf8");
  await fs.writeFile(paths.finalizedMarker, `finalized_at=${finalizedAt}\n`, "utf8");

  return {
    id: sourceId,
    paths,
    originalFiles,
    normalizedFiles,
    extractedFiles,
    finalizedAt,
  };
}

export function buildRawBundlePaths(input: RawBundlePathInput): RawBundlePaths {
  const date = sanitizePathSegment(input.date);
  const sourceId = sanitizePathSegment(input.sourceId);
  if (path.isAbsolute(input.rawRoot) || input.rawRoot.split(/[\\/]+/).some((part) => part === "..")) {
    throw new RawBundleError(`rawRoot must be relative to the vault: ${input.rawRoot}`);
  }

  const root = resolveUnder(input.vaultPath, input.rawRoot, date, sourceId);
  return {
    root,
    manifest: resolveUnder(input.vaultPath, input.rawRoot, date, sourceId, "manifest.yaml"),
    sourceMarkdown: resolveUnder(input.vaultPath, input.rawRoot, date, sourceId, "source.md"),
    logMarkdown: resolveUnder(input.vaultPath, input.rawRoot, date, sourceId, "log.md"),
    originalDir: resolveUnder(input.vaultPath, input.rawRoot, date, sourceId, "original"),
    normalizedDir: resolveUnder(input.vaultPath, input.rawRoot, date, sourceId, "normalized"),
    extractedDir: resolveUnder(input.vaultPath, input.rawRoot, date, sourceId, "extracted"),
    finalizedMarker: resolveUnder(input.vaultPath, input.rawRoot, date, sourceId, ".finalized"),
  };
}

export function sanitizePathSegment(value: string): string {
  const sanitized = value.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^\.+$/, "_").slice(0, 120);
  return sanitized.length > 0 ? sanitized : "unknown";
}

export function sanitizeFileName(value: string): string {
  const sanitized = path.basename(value).replace(/[<>:"/\\|?*\x00-\x1f]+/g, "_").trim();
  return sanitized.length > 0 ? sanitized.slice(0, 200) : "file";
}

async function assertBundleWritable(paths: RawBundlePaths): Promise<void> {
  for (const markerPath of [paths.finalizedMarker, paths.manifest]) {
    try {
      await fs.access(markerPath);
      throw new RawBundleError(`Raw bundle already exists and will not be overwritten: ${paths.root}`);
    } catch (error) {
      if (error instanceof RawBundleError) {
        throw error;
      }
    }
  }
}

async function copyJobFiles(files: StoredJobFile[], destinationDir: string, relativeDir: string): Promise<BundleFileRecord[]> {
  const records: BundleFileRecord[] = [];
  for (const file of files) {
    const sourcePath = file.archivePath ?? file.localPath;
    if (!sourcePath) {
      continue;
    }
    const name = sanitizeFileName(file.originalName ?? path.basename(sourcePath));
    const destinationPath = uniqueDestinationPath(destinationDir, name, records.map((record) => record.name));
    await fs.copyFile(sourcePath, destinationPath);
    const record: BundleFileRecord = {
      id: file.id,
      name: path.basename(destinationPath),
      relativePath: `${relativeDir}/${path.basename(destinationPath)}`,
    };
    assignDefined(record, "sha256", file.sha256);
    assignDefined(record, "mimeType", file.mimeType);
    assignDefined(record, "sizeBytes", file.sizeBytes);
    records.push(record);
  }
  return records;
}

async function copyArtifacts(
  artifacts: RawBundleArtifactInput[],
  destinationDir: string,
  relativeDir: string,
): Promise<BundleFileRecord[]> {
  const records: BundleFileRecord[] = [];
  for (const artifact of artifacts) {
    const name = sanitizeFileName(artifact.name ?? path.basename(artifact.sourcePath));
    const destinationPath = uniqueDestinationPath(destinationDir, name, records.map((record) => record.name));
    await fs.copyFile(artifact.sourcePath, destinationPath);
    const record: BundleFileRecord = {
      name: path.basename(destinationPath),
      relativePath: `${relativeDir}/${path.basename(destinationPath)}`,
    };
    assignDefined(record, "sha256", artifact.sha256);
    assignDefined(record, "mimeType", artifact.mimeType);
    assignDefined(record, "sizeBytes", artifact.sizeBytes);
    records.push(record);
  }
  return records;
}

function uniqueDestinationPath(destinationDir: string, name: string, usedNames: string[]): string {
  let candidate = name;
  let counter = 2;
  const extension = path.extname(name);
  const stem = extension ? name.slice(0, -extension.length) : name;
  while (usedNames.includes(candidate)) {
    candidate = `${stem}-${counter}${extension}`;
    counter += 1;
  }
  return path.join(destinationDir, candidate);
}

function renderManifest(input: RawBundleWriteInput, result: RawBundleWriteResult): string {
  const lines = [
    "schema_version: 1",
    `bundle_id: ${yamlScalar(result.id)}`,
    `job_id: ${yamlScalar(input.job.id)}`,
    `source: ${yamlScalar(input.job.source)}`,
    `created_at: ${yamlScalar(input.job.createdAt)}`,
    `finalized_at: ${yamlScalar(result.finalizedAt)}`,
    `project: ${yamlScalar(input.job.project ?? "")}`,
    "tags:",
    ...yamlList(input.job.tags),
    `instructions: ${yamlScalar(input.job.instructions ?? "")}`,
    "files:",
    ...yamlFileRecords(result.originalFiles, "original"),
    "normalized:",
    ...yamlFileRecords(result.normalizedFiles, "normalized"),
    "extracted:",
    ...yamlFileRecords(result.extractedFiles, "extracted"),
  ];
  return `${lines.join("\n")}\n`;
}

function renderSourceMarkdown(
  job: StoredJob,
  bundleId: string,
  originalFiles: BundleFileRecord[],
  normalizedFiles: BundleFileRecord[],
  extractedFiles: BundleFileRecord[],
): string {
  const lines = [
    "---",
    `bundle_id: ${bundleId}`,
    `job_id: ${job.id}`,
    `source: ${job.source}`,
    `project: ${job.project ?? ""}`,
    `tags: [${job.tags.map((tag) => yamlScalar(tag)).join(", ")}]`,
    "---",
    "",
    `# Source ${job.id}`,
    "",
    "## Instructions",
    "",
    job.instructions ?? "",
    "",
    "## Original Files",
    "",
    ...markdownFileList(originalFiles),
    "",
    "## Normalized Artifacts",
    "",
    ...markdownFileList(normalizedFiles),
    "",
    "## Extracted Artifacts",
    "",
    ...markdownFileList(extractedFiles),
    "",
  ];
  return `${lines.join("\n")}\n`;
}

function renderLogMarkdown(events: StoredJobEvent[]): string {
  const lines = ["# Processing Log", ""];
  for (const event of events) {
    lines.push(`- ${event.createdAt} ${event.type}${event.message ? `: ${event.message}` : ""}`);
  }
  return `${lines.join("\n")}\n`;
}

function yamlList(values: string[]): string[] {
  if (values.length === 0) {
    return ["  []"];
  }
  return values.map((value) => `  - ${yamlScalar(value)}`);
}

function yamlFileRecords(records: BundleFileRecord[], kind: string): string[] {
  if (records.length === 0) {
    return ["  []"];
  }
  return records.flatMap((record) => {
    const lines = [
      `  - kind: ${yamlScalar(kind)}`,
      `    name: ${yamlScalar(record.name)}`,
      `    path: ${yamlScalar(record.relativePath)}`,
    ];
    if (record.id) {
      lines.push(`    id: ${yamlScalar(record.id)}`);
    }
    if (record.sha256) {
      lines.push(`    sha256: ${yamlScalar(record.sha256)}`);
    }
    if (record.mimeType) {
      lines.push(`    mime_type: ${yamlScalar(record.mimeType)}`);
    }
    if (record.sizeBytes !== undefined) {
      lines.push(`    size_bytes: ${record.sizeBytes}`);
    }
    return lines;
  });
}

function markdownFileList(records: BundleFileRecord[]): string[] {
  if (records.length === 0) {
    return ["- None"];
  }
  return records.map((record) => `- [${record.name}](${record.relativePath.replace(/\\/g, "/")})`);
}

function yamlScalar(value: string): string {
  return JSON.stringify(value);
}

function datePart(value: string): string {
  return value.split("T")[0] ?? value;
}

function resolveUnder(root: string, ...segments: string[]): string {
  const resolvedRoot = path.resolve(root);
  const candidate = path.resolve(resolvedRoot, ...segments);
  if (!isPathInside(resolvedRoot, candidate)) {
    throw new RawBundleError(`Resolved bundle path is outside vault: ${candidate}`);
  }
  return candidate;
}

function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function assignDefined<T extends object, K extends keyof T>(target: T, key: K, value: T[K] | undefined): void {
  if (value !== undefined) {
    target[key] = value;
  }
}
