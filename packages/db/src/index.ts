import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { IngestSource, JobStatus } from "@telegram-local-ingest/core";

export const SCHEMA_VERSION = 1;

export interface DbHandle {
  db: DatabaseSync;
  close(): void;
}

export interface CreateJobInput {
  id: string;
  source: IngestSource;
  chatId?: string;
  userId?: string;
  command?: string;
  project?: string;
  tags?: string[];
  instructions?: string;
  now?: string;
}

export interface StoredJob {
  id: string;
  source: IngestSource;
  status: JobStatus;
  chatId?: string;
  userId?: string;
  command?: string;
  project?: string;
  tags: string[];
  instructions?: string;
  error?: string;
  retryCount: number;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface AddJobFileInput {
  id: string;
  jobId: string;
  sourceFileId?: string;
  fileUniqueId?: string;
  originalName?: string;
  mimeType?: string;
  sizeBytes?: number;
  sha256?: string;
  localPath?: string;
  archivePath?: string;
  now?: string;
}

export interface StoredJobFile {
  id: string;
  jobId: string;
  sourceFileId?: string;
  fileUniqueId?: string;
  originalName?: string;
  mimeType?: string;
  sizeBytes?: number;
  sha256?: string;
  localPath?: string;
  archivePath?: string;
  createdAt: string;
}

export interface StoredJobEvent {
  id: number;
  jobId: string;
  type: string;
  message?: string;
  data?: unknown;
  createdAt: string;
}

export interface SourceBundleInput {
  id: string;
  jobId: string;
  bundlePath: string;
  manifestPath: string;
  sourceMarkdownPath: string;
  finalizedAt?: string;
  now?: string;
}

export interface StoredSourceBundle extends Required<Omit<SourceBundleInput, "now">> {
  createdAt: string;
}

const ACTIVE_STATUSES: JobStatus[] = [
  "RECEIVED",
  "QUEUED",
  "IMPORTING",
  "NORMALIZING",
  "BUNDLE_WRITING",
  "INGESTING",
  "NOTIFYING",
  "RETRY_REQUESTED",
];

const FORWARD_TRANSITIONS: Record<JobStatus, JobStatus[]> = {
  RECEIVED: ["QUEUED"],
  QUEUED: ["IMPORTING"],
  IMPORTING: ["NORMALIZING"],
  NORMALIZING: ["BUNDLE_WRITING"],
  BUNDLE_WRITING: ["INGESTING"],
  INGESTING: ["NOTIFYING"],
  NOTIFYING: ["COMPLETED"],
  COMPLETED: [],
  FAILED: ["RETRY_REQUESTED"],
  RETRY_REQUESTED: ["QUEUED"],
  CANCELLED: [],
};

export function openIngestDatabase(filePath: string): DbHandle {
  if (filePath !== ":memory:") {
    fs.mkdirSync(path.dirname(path.resolve(filePath)), { recursive: true });
  }
  const db = new DatabaseSync(filePath);
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA busy_timeout = 5000;");
  return {
    db,
    close: () => db.close(),
  };
}

export function migrate(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);

  const current = getCurrentSchemaVersion(db);
  if (current >= SCHEMA_VERSION) {
    return;
  }

  db.exec("BEGIN;");
  try {
    applyV1(db);
    db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(
      SCHEMA_VERSION,
      nowIso(),
    );
    db.exec("COMMIT;");
  } catch (error) {
    db.exec("ROLLBACK;");
    throw error;
  }
}

export function getCurrentSchemaVersion(db: DatabaseSync): number {
  const table = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get();
  if (!table) {
    return 0;
  }
  const row = db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as { version: number | null } | undefined;
  return row?.version ?? 0;
}

export function createJob(db: DatabaseSync, input: CreateJobInput): StoredJob {
  const timestamp = input.now ?? nowIso();
  db.prepare(`
    INSERT INTO jobs (
      id, source, status, chat_id, user_id, command, project, tags_json, instructions,
      retry_count, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
  `).run(
    input.id,
    input.source,
    "RECEIVED",
    input.chatId ?? null,
    input.userId ?? null,
    input.command ?? null,
    input.project ?? null,
    JSON.stringify(input.tags ?? []),
    input.instructions ?? null,
    timestamp,
    timestamp,
  );
  appendJobEvent(db, input.id, "job.created", "Job received", { source: input.source }, timestamp);
  return mustGetJob(db, input.id);
}

export function getJob(db: DatabaseSync, jobId: string): StoredJob | null {
  const row = db.prepare("SELECT * FROM jobs WHERE id = ?").get(jobId) as JobRow | undefined;
  return row ? mapJob(row) : null;
}

export function mustGetJob(db: DatabaseSync, jobId: string): StoredJob {
  const job = getJob(db, jobId);
  if (!job) {
    throw new Error(`Job not found: ${jobId}`);
  }
  return job;
}

export function listJobs(db: DatabaseSync, limit = 100): StoredJob[] {
  return db
    .prepare("SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?")
    .all(limit)
    .map((row) => mapJob(row as unknown as JobRow));
}

export function transitionJob(
  db: DatabaseSync,
  jobId: string,
  nextStatus: JobStatus,
  options: { now?: string; message?: string; error?: string } = {},
): StoredJob {
  const current = mustGetJob(db, jobId);
  if (!isValidTransition(current.status, nextStatus)) {
    throw new Error(`Invalid job transition: ${current.status} -> ${nextStatus}`);
  }

  const timestamp = options.now ?? nowIso();
  db.prepare(`
    UPDATE jobs
    SET status = ?, updated_at = ?, completed_at = ?, error = ?
    WHERE id = ?
  `).run(
    nextStatus,
    timestamp,
    nextStatus === "COMPLETED" || nextStatus === "CANCELLED" ? timestamp : current.completedAt ?? null,
    options.error ?? (nextStatus === "FAILED" ? current.error ?? null : null),
    jobId,
  );
  appendJobEvent(db, jobId, "job.transition", options.message ?? `${current.status} -> ${nextStatus}`, {
    from: current.status,
    to: nextStatus,
    error: options.error,
  }, timestamp);
  return mustGetJob(db, jobId);
}

export function requestRetry(db: DatabaseSync, jobId: string, options: { now?: string; message?: string } = {}): StoredJob {
  const current = mustGetJob(db, jobId);
  if (!canRetry(current.status)) {
    throw new Error(`Job is not retryable from ${current.status}`);
  }
  const timestamp = options.now ?? nowIso();
  db.prepare(`
    UPDATE jobs
    SET status = 'RETRY_REQUESTED', retry_count = retry_count + 1, error = NULL, updated_at = ?, completed_at = NULL
    WHERE id = ?
  `).run(timestamp, jobId);
  appendJobEvent(db, jobId, "job.retry_requested", options.message ?? "Retry requested", {
    from: current.status,
    retryCount: current.retryCount + 1,
  }, timestamp);
  return mustGetJob(db, jobId);
}

export function canRetry(status: JobStatus): boolean {
  return status === "FAILED";
}

export function isValidTransition(from: JobStatus, to: JobStatus): boolean {
  if (FORWARD_TRANSITIONS[from].includes(to)) {
    return true;
  }
  if (to === "FAILED" && ACTIVE_STATUSES.includes(from)) {
    return true;
  }
  if (to === "CANCELLED" && ACTIVE_STATUSES.includes(from)) {
    return true;
  }
  return false;
}

export function addJobFile(db: DatabaseSync, input: AddJobFileInput): StoredJobFile {
  const timestamp = input.now ?? nowIso();
  db.prepare(`
    INSERT INTO job_files (
      id, job_id, source_file_id, file_unique_id, original_name, mime_type, size_bytes,
      sha256, local_path, archive_path, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.id,
    input.jobId,
    input.sourceFileId ?? null,
    input.fileUniqueId ?? null,
    input.originalName ?? null,
    input.mimeType ?? null,
    input.sizeBytes ?? null,
    input.sha256 ?? null,
    input.localPath ?? null,
    input.archivePath ?? null,
    timestamp,
  );
  appendJobEvent(db, input.jobId, "file.added", input.originalName ?? input.id, {
    fileId: input.id,
    sha256: input.sha256,
  }, timestamp);
  return mustGetJobFile(db, input.id);
}

export function listJobFiles(db: DatabaseSync, jobId: string): StoredJobFile[] {
  return db
    .prepare("SELECT * FROM job_files WHERE job_id = ? ORDER BY created_at ASC")
    .all(jobId)
    .map((row) => mapJobFile(row as unknown as JobFileRow));
}

export function mustGetJobFile(db: DatabaseSync, id: string): StoredJobFile {
  const row = db.prepare("SELECT * FROM job_files WHERE id = ?").get(id) as JobFileRow | undefined;
  if (!row) {
    throw new Error(`Job file not found: ${id}`);
  }
  return mapJobFile(row);
}

export function appendJobEvent(
  db: DatabaseSync,
  jobId: string,
  type: string,
  message?: string,
  data?: unknown,
  createdAt = nowIso(),
): StoredJobEvent {
  const result = db.prepare(`
    INSERT INTO job_events (job_id, type, message, data_json, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(jobId, type, message ?? null, data === undefined ? null : JSON.stringify(data), createdAt);
  return mustGetJobEvent(db, Number(result.lastInsertRowid));
}

export function listJobEvents(db: DatabaseSync, jobId: string): StoredJobEvent[] {
  return db
    .prepare("SELECT * FROM job_events WHERE job_id = ? ORDER BY id ASC")
    .all(jobId)
    .map((row) => mapJobEvent(row as unknown as JobEventRow));
}

export function mustGetJobEvent(db: DatabaseSync, id: number): StoredJobEvent {
  const row = db.prepare("SELECT * FROM job_events WHERE id = ?").get(id) as JobEventRow | undefined;
  if (!row) {
    throw new Error(`Job event not found: ${id}`);
  }
  return mapJobEvent(row);
}

export function getTelegramOffset(db: DatabaseSync, botKey: string): number | null {
  const row = db.prepare("SELECT update_id FROM telegram_offsets WHERE bot_key = ?").get(botKey) as { update_id: number } | undefined;
  return row?.update_id ?? null;
}

export function setTelegramOffset(db: DatabaseSync, botKey: string, updateId: number, updatedAt = nowIso()): void {
  db.prepare(`
    INSERT INTO telegram_offsets (bot_key, update_id, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(bot_key) DO UPDATE SET update_id = excluded.update_id, updated_at = excluded.updated_at
  `).run(botKey, updateId, updatedAt);
}

export function createSourceBundle(db: DatabaseSync, input: SourceBundleInput): StoredSourceBundle {
  const timestamp = input.now ?? nowIso();
  const finalizedAt = input.finalizedAt ?? timestamp;
  db.prepare(`
    INSERT INTO source_bundles (
      id, job_id, bundle_path, manifest_path, source_markdown_path, finalized_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.id,
    input.jobId,
    input.bundlePath,
    input.manifestPath,
    input.sourceMarkdownPath,
    finalizedAt,
    timestamp,
  );
  appendJobEvent(db, input.jobId, "bundle.created", input.bundlePath, { bundleId: input.id }, timestamp);
  return mustGetSourceBundle(db, input.id);
}

export function mustGetSourceBundle(db: DatabaseSync, id: string): StoredSourceBundle {
  const row = db.prepare("SELECT * FROM source_bundles WHERE id = ?").get(id) as SourceBundleRow | undefined;
  if (!row) {
    throw new Error(`Source bundle not found: ${id}`);
  }
  return mapSourceBundle(row);
}

function applyV1(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE jobs (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      status TEXT NOT NULL,
      chat_id TEXT,
      user_id TEXT,
      command TEXT,
      project TEXT,
      tags_json TEXT NOT NULL DEFAULT '[]',
      instructions TEXT,
      error TEXT,
      retry_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT
    );

    CREATE INDEX idx_jobs_status_created_at ON jobs(status, created_at);
    CREATE INDEX idx_jobs_updated_at ON jobs(updated_at);

    CREATE TABLE job_files (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      source_file_id TEXT,
      file_unique_id TEXT,
      original_name TEXT,
      mime_type TEXT,
      size_bytes INTEGER,
      sha256 TEXT,
      local_path TEXT,
      archive_path TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX idx_job_files_job_id ON job_files(job_id);
    CREATE INDEX idx_job_files_sha256 ON job_files(sha256);

    CREATE TABLE job_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      message TEXT,
      data_json TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX idx_job_events_job_id_id ON job_events(job_id, id);
    CREATE INDEX idx_job_events_type_created_at ON job_events(type, created_at);

    CREATE TABLE telegram_offsets (
      bot_key TEXT PRIMARY KEY,
      update_id INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE source_bundles (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL UNIQUE REFERENCES jobs(id) ON DELETE CASCADE,
      bundle_path TEXT NOT NULL,
      manifest_path TEXT NOT NULL,
      source_markdown_path TEXT NOT NULL,
      finalized_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX idx_source_bundles_finalized_at ON source_bundles(finalized_at);
  `);
}

function nowIso(): string {
  return new Date().toISOString();
}

function parseJsonArray(value: string): string[] {
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
    return [];
  }
  return parsed;
}

function parseOptionalJson(value: string | null): unknown {
  return value === null ? undefined : JSON.parse(value);
}

function definedString(value: string | null): string | undefined {
  return value === null ? undefined : value;
}

function definedNumber(value: number | null): number | undefined {
  return value === null ? undefined : value;
}

function mapJob(row: JobRow): StoredJob {
  const job: StoredJob = {
    id: row.id,
    source: row.source as IngestSource,
    status: row.status as JobStatus,
    tags: parseJsonArray(row.tags_json),
    retryCount: row.retry_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  assignDefined(job, "chatId", definedString(row.chat_id));
  assignDefined(job, "userId", definedString(row.user_id));
  assignDefined(job, "command", definedString(row.command));
  assignDefined(job, "project", definedString(row.project));
  assignDefined(job, "instructions", definedString(row.instructions));
  assignDefined(job, "error", definedString(row.error));
  assignDefined(job, "completedAt", definedString(row.completed_at));
  return job;
}

function mapJobFile(row: JobFileRow): StoredJobFile {
  const file = {
    id: row.id,
    jobId: row.job_id,
    createdAt: row.created_at,
  } as StoredJobFile;
  assignDefined(file, "sourceFileId", definedString(row.source_file_id));
  assignDefined(file, "fileUniqueId", definedString(row.file_unique_id));
  assignDefined(file, "originalName", definedString(row.original_name));
  assignDefined(file, "mimeType", definedString(row.mime_type));
  assignDefined(file, "sizeBytes", definedNumber(row.size_bytes));
  assignDefined(file, "sha256", definedString(row.sha256));
  assignDefined(file, "localPath", definedString(row.local_path));
  assignDefined(file, "archivePath", definedString(row.archive_path));
  return file;
}

function mapJobEvent(row: JobEventRow): StoredJobEvent {
  const event: StoredJobEvent = {
    id: row.id,
    jobId: row.job_id,
    type: row.type,
    createdAt: row.created_at,
  };
  assignDefined(event, "message", definedString(row.message));
  assignDefined(event, "data", parseOptionalJson(row.data_json));
  return event;
}

function mapSourceBundle(row: SourceBundleRow): StoredSourceBundle {
  return {
    id: row.id,
    jobId: row.job_id,
    bundlePath: row.bundle_path,
    manifestPath: row.manifest_path,
    sourceMarkdownPath: row.source_markdown_path,
    finalizedAt: row.finalized_at,
    createdAt: row.created_at,
  };
}

function assignDefined<T extends object, K extends keyof T>(target: T, key: K, value: T[K] | undefined): void {
  if (value !== undefined) {
    target[key] = value;
  }
}

interface JobRow {
  id: string;
  source: string;
  status: string;
  chat_id: string | null;
  user_id: string | null;
  command: string | null;
  project: string | null;
  tags_json: string;
  instructions: string | null;
  error: string | null;
  retry_count: number;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

interface JobFileRow {
  id: string;
  job_id: string;
  source_file_id: string | null;
  file_unique_id: string | null;
  original_name: string | null;
  mime_type: string | null;
  size_bytes: number | null;
  sha256: string | null;
  local_path: string | null;
  archive_path: string | null;
  created_at: string;
}

interface JobEventRow {
  id: number;
  job_id: string;
  type: string;
  message: string | null;
  data_json: string | null;
  created_at: string;
}

interface SourceBundleRow {
  id: string;
  job_id: string;
  bundle_path: string;
  manifest_path: string;
  source_markdown_path: string;
  finalized_at: string;
  created_at: string;
}
