import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";

import {
  appendJobEvent,
  findJobFileBySha256,
  listJobFiles,
  mustGetJob,
  transitionJob,
  updateJobFileImport,
  type StoredJobFile,
} from "@telegram-local-ingest/db";
import {
  resolveTelegramFileLocation,
  type TelegramBotApiClient,
  type TelegramLocalFile,
} from "@telegram-local-ingest/telegram";

export interface FileImportOptions {
  runtimeDir: string;
  maxFileSizeBytes: number;
  now?: string;
}

export interface ImportedFileResult {
  fileId: string;
  sha256: string;
  sizeBytes: number;
  localPath: string;
  archivePath: string;
  duplicateOfFileId?: string;
}

export interface ImportJobFilesResult {
  jobId: string;
  importedFiles: ImportedFileResult[];
}

export class FileImportError extends Error {
  readonly fileId?: string;

  constructor(message: string, fileId?: string) {
    super(message);
    this.name = "FileImportError";
    if (fileId !== undefined) {
      this.fileId = fileId;
    }
  }
}

export async function importTelegramJobFiles(
  db: DatabaseSync,
  client: TelegramBotApiClient,
  jobId: string,
  options: FileImportOptions,
): Promise<ImportJobFilesResult> {
  const job = mustGetJob(db, jobId);
  if (job.status !== "QUEUED") {
    throw new FileImportError(`Job must be QUEUED before file import: ${job.status}`);
  }

  transitionJob(db, jobId, "IMPORTING", {
    message: "Importing Telegram files into runtime storage",
    ...(options.now ? { now: options.now } : {}),
  });

  try {
    const importedFiles: ImportedFileResult[] = [];
    for (const file of listJobFiles(db, jobId)) {
      importedFiles.push(await importTelegramJobFile(db, client, file, options));
    }

    transitionJob(db, jobId, "NORMALIZING", {
      message: "Imported Telegram files into runtime storage",
      ...(options.now ? { now: options.now } : {}),
    });
    return { jobId, importedFiles };
  } catch (error) {
    transitionJob(db, jobId, "FAILED", {
      message: "Telegram file import failed",
      error: error instanceof Error ? error.message : String(error),
      ...(options.now ? { now: options.now } : {}),
    });
    throw error;
  }
}

export async function importTelegramJobFile(
  db: DatabaseSync,
  client: TelegramBotApiClient,
  file: StoredJobFile,
  options: FileImportOptions,
): Promise<ImportedFileResult> {
  if (!file.sourceFileId) {
    throw new FileImportError(`Job file does not include a Telegram source file id: ${file.id}`, file.id);
  }

  const telegramFile = await client.getFile(file.sourceFileId);
  enforceTelegramReportedSize(file.id, telegramFile, options.maxFileSizeBytes);
  const sourcePath = resolveLocalTelegramFilePath(telegramFile, client, file.id);
  const stats = await statImportSource(sourcePath, file.id, options.maxFileSizeBytes);
  const sha256 = await sha256File(sourcePath);
  const duplicate = findJobFileBySha256(db, sha256, file.id);

  if (duplicate?.archivePath) {
    const imported = updateJobFileImport(db, {
      id: file.id,
      sha256,
      sizeBytes: stats.size,
      localPath: duplicate.localPath ?? duplicate.archivePath,
      archivePath: duplicate.archivePath,
      ...(options.now ? { now: options.now } : {}),
    });
    appendJobEvent(db, file.jobId, "file.duplicate", imported.originalName ?? imported.id, {
      fileId: file.id,
      duplicateOfFileId: duplicate.id,
      sha256,
    }, options.now);
    return {
      fileId: imported.id,
      sha256,
      sizeBytes: stats.size,
      localPath: imported.localPath!,
      archivePath: imported.archivePath!,
      duplicateOfFileId: duplicate.id,
    };
  }

  const originalName = file.originalName ?? path.basename(sourcePath);
  const safeName = sanitizeFileName(originalName);
  const stagingPath = resolveRuntimePath(options.runtimeDir, "staging", file.jobId, file.id, safeName);
  const archivePath = resolveRuntimePath(options.runtimeDir, "archive", "originals", sha256.slice(0, 2), sha256, safeName);

  await copyIntoRuntime(sourcePath, stagingPath);
  await copyIntoRuntime(sourcePath, archivePath, { skipIfExists: true });

  const imported = updateJobFileImport(db, {
    id: file.id,
    sha256,
    sizeBytes: stats.size,
    localPath: stagingPath,
    archivePath,
    ...(options.now ? { now: options.now } : {}),
  });

  return {
    fileId: imported.id,
    sha256,
    sizeBytes: stats.size,
    localPath: stagingPath,
    archivePath,
  };
}

export function resolveRuntimePath(runtimeDir: string, ...segments: string[]): string {
  const root = path.resolve(runtimeDir);
  const resolved = path.resolve(root, ...segments);
  if (!isPathInside(root, resolved)) {
    throw new FileImportError(`Resolved runtime path is outside runtime dir: ${resolved}`);
  }
  return resolved;
}

export function sanitizeFileName(value: string): string {
  const sanitized = path.basename(value).replace(/[<>:"/\\|?*\x00-\x1f]+/g, "_").trim();
  return sanitized.length > 0 ? sanitized.slice(0, 200) : "file";
}

function resolveLocalTelegramFilePath(
  file: TelegramLocalFile,
  client: TelegramBotApiClient,
  fileId: string,
): string {
  const location = resolveTelegramFileLocation(file, client.config);
  if (location.kind !== "local-path") {
    throw new FileImportError("Telegram file did not resolve to a local path; check TELEGRAM_LOCAL_FILES_ROOT/local server mode", fileId);
  }
  return location.path;
}

function enforceTelegramReportedSize(fileId: string, file: TelegramLocalFile, maxFileSizeBytes: number): void {
  if (file.fileSize !== undefined && file.fileSize > maxFileSizeBytes) {
    throw new FileImportError(
      `Telegram file exceeds max size policy: ${file.fileSize} > ${maxFileSizeBytes}`,
      fileId,
    );
  }
}

async function statImportSource(filePath: string, fileId: string, maxFileSizeBytes: number): Promise<{ size: number }> {
  let stats;
  try {
    stats = await fs.stat(filePath);
  } catch (error) {
    throw new FileImportError(
      `Telegram local file is not readable: ${error instanceof Error ? error.message : String(error)}`,
      fileId,
    );
  }
  if (!stats.isFile()) {
    throw new FileImportError(`Telegram local path is not a file: ${filePath}`, fileId);
  }
  if (stats.size > maxFileSizeBytes) {
    throw new FileImportError(`Local file exceeds max size policy: ${stats.size} > ${maxFileSizeBytes}`, fileId);
  }
  return { size: stats.size };
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

async function copyIntoRuntime(sourcePath: string, destinationPath: string, options: { skipIfExists?: boolean } = {}): Promise<void> {
  await fs.mkdir(path.dirname(destinationPath), { recursive: true });
  if (options.skipIfExists) {
    try {
      await fs.access(destinationPath);
      return;
    } catch {
      // Destination does not exist yet.
    }
  }
  await fs.copyFile(sourcePath, destinationPath);
}

function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
