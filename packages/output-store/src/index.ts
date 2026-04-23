import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";

import {
  createJobOutput,
  getJobOutput,
  listExpiredJobOutputs,
  markJobOutputDeleted,
  type StoredJobOutput,
} from "@telegram-local-ingest/db";

export const DEFAULT_OUTPUT_TTL_MS = 24 * 60 * 60 * 1000;

export type OutputResolveStatus = "active" | "not_found" | "expired" | "deleted";

export interface CreateRuntimeOutputInput {
  db: DatabaseSync;
  jobId: string;
  runtimeDir: string;
  sourcePath: string;
  kind: string;
  fileName?: string;
  mimeType?: string;
  now?: string;
  ttlMs?: number;
  outputId?: string;
}

export interface ResolvedOutput {
  status: OutputResolveStatus;
  output?: StoredJobOutput;
}

export interface CleanupExpiredOutputsOptions {
  now?: string;
  limit?: number;
}

export interface CleanupExpiredOutputsResult {
  deletedOutputs: StoredJobOutput[];
  failedOutputs: Array<{ output: StoredJobOutput; error: Error }>;
}

export async function createRuntimeOutput(input: CreateRuntimeOutputInput): Promise<StoredJobOutput> {
  const createdAt = input.now ?? new Date().toISOString();
  const ttlMs = input.ttlMs ?? DEFAULT_OUTPUT_TTL_MS;
  if (ttlMs < 1) {
    throw new Error("Output TTL must be at least 1ms");
  }

  const outputId = input.outputId ?? createOutputId();
  const fileName = safeFileName(input.fileName ?? path.basename(input.sourcePath));
  const outputDir = path.resolve(input.runtimeDir, "outputs", safePathSegment(input.jobId), outputId);
  const outputPath = path.join(outputDir, fileName);

  await fs.mkdir(outputDir, { recursive: true });
  await fs.copyFile(input.sourcePath, outputPath);
  const [stat, sha256] = await Promise.all([
    fs.stat(outputPath),
    sha256File(outputPath),
  ]);

  return createJobOutput(input.db, {
    id: outputId,
    jobId: input.jobId,
    kind: input.kind,
    filePath: outputPath,
    fileName,
    ...(input.mimeType ? { mimeType: input.mimeType } : {}),
    sizeBytes: stat.size,
    sha256,
    createdAt,
    expiresAt: new Date(Date.parse(createdAt) + ttlMs).toISOString(),
  });
}

export function resolveDownloadableOutput(db: DatabaseSync, outputId: string, now = new Date().toISOString()): ResolvedOutput {
  const output = getJobOutput(db, outputId);
  if (!output) {
    return { status: "not_found" };
  }
  if (output.deletedAt) {
    return { status: "deleted", output };
  }
  if (output.expiresAt <= now) {
    return { status: "expired", output };
  }
  return { status: "active", output };
}

export async function cleanupExpiredOutputs(
  db: DatabaseSync,
  options: CleanupExpiredOutputsOptions = {},
): Promise<CleanupExpiredOutputsResult> {
  const expired = listExpiredJobOutputs(db, options.now, options.limit ?? 100);
  const deletedOutputs: StoredJobOutput[] = [];
  const failedOutputs: Array<{ output: StoredJobOutput; error: Error }> = [];

  for (const output of expired) {
    try {
      await fs.rm(output.filePath, { force: true });
      await removeEmptyDirectory(path.dirname(output.filePath));
      deletedOutputs.push(markJobOutputDeleted(db, output.id, options.now));
    } catch (error) {
      failedOutputs.push({ output, error: error instanceof Error ? error : new Error(String(error)) });
    }
  }

  return { deletedOutputs, failedOutputs };
}

function createOutputId(): string {
  return `out_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

function safeFileName(value: string): string {
  const baseName = path.basename(value).replace(/[<>:"/\\|?*\x00-\x1f]+/g, "_").trim();
  return baseName.length > 0 ? baseName.slice(0, 160) : "output";
}

function safePathSegment(value: string): string {
  const segment = value.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^\.+$/, "_").slice(0, 160);
  return segment.length > 0 ? segment : "job";
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}

async function removeEmptyDirectory(directory: string): Promise<void> {
  try {
    await fs.rmdir(directory);
  } catch {
    // Directory can remain when multiple files share the same output folder.
  }
}
