import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { IngestSource, JobStatus } from "@telegram-local-ingest/core";

export const SCHEMA_VERSION = 9;

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

export interface UpdateJobFileImportInput {
  id: string;
  sha256: string;
  sizeBytes: number;
  localPath: string;
  archivePath: string;
  now?: string;
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

export interface CreateJobOutputInput {
  id: string;
  jobId: string;
  kind: string;
  filePath: string;
  fileName: string;
  mimeType?: string;
  sizeBytes?: number;
  sha256?: string;
  createdAt?: string;
  expiresAt: string;
}

export interface StoredJobOutput {
  id: string;
  jobId: string;
  kind: string;
  filePath: string;
  fileName: string;
  mimeType?: string;
  sizeBytes?: number;
  sha256?: string;
  createdAt: string;
  expiresAt: string;
  deletedAt?: string;
}

export interface JobClaim {
  jobId: string;
  workerId: string;
  claimedAt: string;
  heartbeatAt: string;
  expiresAt: string;
}

export type AutomationRunStatus = "RUNNING" | "SUCCEEDED" | "FAILED" | "SKIPPED";

export interface AutomationModuleInput {
  id: string;
  manifest: unknown;
  enabled: boolean;
  now?: string;
}

export interface StoredAutomationModule {
  id: string;
  manifest: unknown;
  enabled: boolean;
  available: boolean;
  installedAt: string;
  updatedAt: string;
}

export interface CreateAutomationRunInput {
  id: string;
  moduleId: string;
  trigger: string;
  idempotencyKey?: string;
  stdoutPath: string;
  stderrPath: string;
  resultPath: string;
  now?: string;
}

export interface CompleteAutomationRunInput {
  id: string;
  status: Exclude<AutomationRunStatus, "RUNNING">;
  exitCode?: number;
  error?: string;
  endedAt?: string;
}

export interface StoredAutomationRun {
  id: string;
  moduleId: string;
  trigger: string;
  status: AutomationRunStatus;
  idempotencyKey?: string;
  startedAt: string;
  endedAt?: string;
  exitCode?: number;
  stdoutPath: string;
  stderrPath: string;
  resultPath: string;
  error?: string;
}

export interface StoredAutomationEvent {
  id: number;
  runId: string;
  level: string;
  message: string;
  data?: unknown;
  createdAt: string;
}

export interface UpsertAutomationScheduleStateInput {
  moduleId: string;
  lastDueKey?: string;
  lastDueAt?: string;
  nextDueAt?: string;
  consecutiveFailures?: number;
  retryAfter?: string;
  updatedAt?: string;
}

export interface StoredAutomationScheduleState {
  moduleId: string;
  lastDueKey?: string;
  lastDueAt?: string;
  nextDueAt?: string;
  consecutiveFailures: number;
  retryAfter?: string;
  updatedAt: string;
}

export type ArtifactRendererRunStatus = "RUNNING" | "SUCCEEDED" | "FAILED";

export interface CreateArtifactRendererRunInput {
  id: string;
  artifactId: string;
  artifactKind: string;
  rendererMode: string;
  rendererId?: string;
  rendererLanguage?: string;
  sourcePrompt: string;
  request: unknown;
  runDir: string;
  outputDir: string;
  stdoutPath: string;
  stderrPath: string;
  resultPath: string;
  now?: string;
}

export interface CompleteArtifactRendererRunInput {
  id: string;
  status: Exclude<ArtifactRendererRunStatus, "RUNNING">;
  derivedBundlePath?: string;
  wikiPagePath?: string;
  error?: string;
  errorDiagnostic?: unknown;
  endedAt?: string;
}

export interface StoredArtifactRendererRun {
  id: string;
  artifactId: string;
  artifactKind: string;
  rendererMode: string;
  rendererId?: string;
  rendererLanguage?: string;
  status: ArtifactRendererRunStatus;
  sourcePrompt: string;
  request: unknown;
  runDir: string;
  outputDir: string;
  stdoutPath: string;
  stderrPath: string;
  resultPath: string;
  derivedBundlePath?: string;
  wikiPagePath?: string;
  promotedAt?: string;
  promotedRendererId?: string;
  createdAt: string;
  endedAt?: string;
  error?: string;
  errorDiagnostic?: unknown;
}

export type VaultTombstoneTargetType = "source_bundle" | "automation_run" | "derived_artifact" | "job_output" | "path";

export interface CreateVaultTombstoneInput {
  id: string;
  targetType: VaultTombstoneTargetType;
  targetId: string;
  jobId?: string;
  reason: string;
  paths?: string[];
  metadata?: unknown;
  createdBy?: string;
  now?: string;
}

export interface StoredVaultTombstone {
  id: string;
  targetType: VaultTombstoneTargetType;
  targetId: string;
  jobId?: string;
  reason: string;
  paths: string[];
  metadata?: unknown;
  createdBy?: string;
  createdAt: string;
}

export interface ClaimRunnableJobsInput {
  workerId: string;
  limit: number;
  leaseMs: number;
  statuses?: JobStatus[];
  excludeJobIds?: string[];
  now?: string;
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

export const RUNNABLE_JOB_STATUSES: JobStatus[] = [
  "QUEUED",
  "NORMALIZING",
  "BUNDLE_WRITING",
  "INGESTING",
  "NOTIFYING",
];

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
    if (current < 1) {
      applyV1(db);
      recordMigration(db, 1);
    }
    if (current < 2) {
      applyV2(db);
      recordMigration(db, 2);
    }
    if (current < 3) {
      applyV3(db);
      recordMigration(db, 3);
    }
    if (current < 4) {
      applyV4(db);
      recordMigration(db, 4);
    }
    if (current < 5) {
      applyV5(db);
      recordMigration(db, 5);
    }
    if (current < 6) {
      applyV6(db);
      recordMigration(db, 6);
    }
    if (current < 7) {
      applyV7(db);
      recordMigration(db, 7);
    }
    if (current < 8) {
      applyV8(db);
      recordMigration(db, 8);
    }
    if (current < 9) {
      applyV9(db);
      recordMigration(db, 9);
    }
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

export function claimRunnableJobs(db: DatabaseSync, input: ClaimRunnableJobsInput): StoredJob[] {
  if (input.limit < 1) {
    return [];
  }
  if (input.leaseMs < 1) {
    throw new Error("Job claim leaseMs must be at least 1");
  }

  const timestamp = input.now ?? nowIso();
  const expiresAt = addMsIso(timestamp, input.leaseMs);
  const statuses = input.statuses ?? RUNNABLE_JOB_STATUSES;
  if (statuses.length === 0) {
    return [];
  }

  const statusPlaceholders = statuses.map(() => '?').join(", ");
  const excludeJobIds = input.excludeJobIds ?? [];
  const excludeClause = excludeJobIds.length > 0
    ? `AND jobs.id NOT IN (${excludeJobIds.map(() => '?').join(", ")})`
    : "";
  const rows = db.prepare(`
    SELECT jobs.*
    FROM jobs
    LEFT JOIN job_claims ON job_claims.job_id = jobs.id
    WHERE jobs.status IN (${statusPlaceholders})
      ${excludeClause}
      AND (
        job_claims.job_id IS NULL
        OR job_claims.expires_at <= ?
        OR job_claims.worker_id = ?
      )
    ORDER BY jobs.created_at ASC
    LIMIT ?
  `).all(...statuses, ...excludeJobIds, timestamp, input.workerId, input.limit) as unknown as JobRow[];

  const claimed: StoredJob[] = [];
  for (const row of rows) {
    const result = db.prepare(`
      INSERT INTO job_claims (job_id, worker_id, claimed_at, heartbeat_at, expires_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(job_id) DO UPDATE SET
        worker_id = excluded.worker_id,
        claimed_at = excluded.claimed_at,
        heartbeat_at = excluded.heartbeat_at,
        expires_at = excluded.expires_at
      WHERE job_claims.expires_at <= ? OR job_claims.worker_id = ?
    `).run(row.id, input.workerId, timestamp, timestamp, expiresAt, timestamp, input.workerId);
    if (result.changes === 0) {
      continue;
    }
    appendJobEvent(db, row.id, "job.claimed", "Job claimed for processing", {
      workerId: input.workerId,
      expiresAt,
    }, timestamp);
    claimed.push(mustGetJob(db, row.id));
  }

  return claimed;
}

export function getJobClaim(db: DatabaseSync, jobId: string): JobClaim | null {
  const row = db.prepare("SELECT * FROM job_claims WHERE job_id = ?").get(jobId) as JobClaimRow | undefined;
  return row ? mapJobClaim(row) : null;
}

export function renewJobClaim(
  db: DatabaseSync,
  jobId: string,
  workerId: string,
  leaseMs: number,
  now = nowIso(),
): boolean {
  if (leaseMs < 1) {
    throw new Error("Job claim leaseMs must be at least 1");
  }
  const result = db.prepare(`
    UPDATE job_claims
    SET heartbeat_at = ?, expires_at = ?
    WHERE job_id = ? AND worker_id = ?
  `).run(now, addMsIso(now, leaseMs), jobId, workerId);
  return result.changes > 0;
}

export function releaseJobClaim(db: DatabaseSync, jobId: string, workerId: string): boolean {
  const result = db.prepare("DELETE FROM job_claims WHERE job_id = ? AND worker_id = ?").run(jobId, workerId);
  return result.changes > 0;
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

export function findJobFileBySha256(
  db: DatabaseSync,
  sha256: string,
  excludingId?: string,
): StoredJobFile | null {
  const row = db
    .prepare(`
      SELECT * FROM job_files
      WHERE sha256 = ? AND (? IS NULL OR id != ?)
      ORDER BY created_at ASC
      LIMIT 1
    `)
    .get(sha256, excludingId ?? null, excludingId ?? null) as JobFileRow | undefined;
  return row ? mapJobFile(row) : null;
}

export function mustGetJobFile(db: DatabaseSync, id: string): StoredJobFile {
  const row = db.prepare("SELECT * FROM job_files WHERE id = ?").get(id) as JobFileRow | undefined;
  if (!row) {
    throw new Error(`Job file not found: ${id}`);
  }
  return mapJobFile(row);
}

export function updateJobFileImport(db: DatabaseSync, input: UpdateJobFileImportInput): StoredJobFile {
  const current = mustGetJobFile(db, input.id);
  const timestamp = input.now ?? nowIso();
  db.prepare(`
    UPDATE job_files
    SET sha256 = ?, size_bytes = ?, local_path = ?, archive_path = ?
    WHERE id = ?
  `).run(input.sha256, input.sizeBytes, input.localPath, input.archivePath, input.id);
  appendJobEvent(db, current.jobId, "file.imported", current.originalName ?? current.id, {
    fileId: current.id,
    sha256: input.sha256,
    sizeBytes: input.sizeBytes,
    localPath: input.localPath,
    archivePath: input.archivePath,
  }, timestamp);
  return mustGetJobFile(db, input.id);
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

export function listJobEventsByType(db: DatabaseSync, type: string, limit = 50): StoredJobEvent[] {
  return db
    .prepare("SELECT * FROM job_events WHERE type = ? ORDER BY created_at DESC, id DESC LIMIT ?")
    .all(type, limit)
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

export function listSourceBundles(db: DatabaseSync, limit = 1000): StoredSourceBundle[] {
  return db
    .prepare("SELECT * FROM source_bundles ORDER BY finalized_at DESC LIMIT ?")
    .all(limit)
    .map((row) => mapSourceBundle(row as unknown as SourceBundleRow));
}

export function getSourceBundleForJob(db: DatabaseSync, jobId: string): StoredSourceBundle | null {
  const row = db.prepare("SELECT * FROM source_bundles WHERE job_id = ?").get(jobId) as SourceBundleRow | undefined;
  return row ? mapSourceBundle(row) : null;
}

export function mustGetSourceBundleForJob(db: DatabaseSync, jobId: string): StoredSourceBundle {
  const bundle = getSourceBundleForJob(db, jobId);
  if (!bundle) {
    throw new Error(`Source bundle not found for job: ${jobId}`);
  }
  return bundle;
}

export function createJobOutput(db: DatabaseSync, input: CreateJobOutputInput): StoredJobOutput {
  const timestamp = input.createdAt ?? nowIso();
  db.prepare(`
    INSERT INTO job_outputs (
      id, job_id, kind, file_path, file_name, mime_type, size_bytes, sha256,
      created_at, expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.id,
    input.jobId,
    input.kind,
    input.filePath,
    input.fileName,
    input.mimeType ?? null,
    input.sizeBytes ?? null,
    input.sha256 ?? null,
    timestamp,
    input.expiresAt,
  );
  appendJobEvent(db, input.jobId, "output.created", input.fileName, {
    outputId: input.id,
    kind: input.kind,
    fileName: input.fileName,
    expiresAt: input.expiresAt,
  }, timestamp);
  return mustGetJobOutput(db, input.id);
}

export function getJobOutput(db: DatabaseSync, outputId: string): StoredJobOutput | null {
  const row = db.prepare("SELECT * FROM job_outputs WHERE id = ?").get(outputId) as JobOutputRow | undefined;
  return row ? mapJobOutput(row) : null;
}

export function mustGetJobOutput(db: DatabaseSync, outputId: string): StoredJobOutput {
  const output = getJobOutput(db, outputId);
  if (!output) {
    throw new Error(`Job output not found: ${outputId}`);
  }
  return output;
}

export function listJobOutputs(db: DatabaseSync, jobId: string): StoredJobOutput[] {
  return db
    .prepare("SELECT * FROM job_outputs WHERE job_id = ? ORDER BY created_at ASC")
    .all(jobId)
    .map((row) => mapJobOutput(row as unknown as JobOutputRow));
}

export function listAllJobOutputs(db: DatabaseSync, limit = 5000): StoredJobOutput[] {
  return db
    .prepare("SELECT * FROM job_outputs ORDER BY created_at DESC LIMIT ?")
    .all(limit)
    .map((row) => mapJobOutput(row as unknown as JobOutputRow));
}

export function listExpiredJobOutputs(db: DatabaseSync, now = nowIso(), limit = 100): StoredJobOutput[] {
  return db
    .prepare(`
      SELECT * FROM job_outputs
      WHERE deleted_at IS NULL AND expires_at <= ?
      ORDER BY expires_at ASC
      LIMIT ?
    `)
    .all(now, limit)
    .map((row) => mapJobOutput(row as unknown as JobOutputRow));
}

export function markJobOutputDeleted(db: DatabaseSync, outputId: string, deletedAt = nowIso()): StoredJobOutput {
  const current = mustGetJobOutput(db, outputId);
  if (current.deletedAt) {
    return current;
  }
  db.prepare("UPDATE job_outputs SET deleted_at = ? WHERE id = ?").run(deletedAt, outputId);
  appendJobEvent(db, current.jobId, "output.deleted", current.fileName, {
    outputId: current.id,
    fileName: current.fileName,
  }, deletedAt);
  return mustGetJobOutput(db, outputId);
}

export function upsertAutomationModule(db: DatabaseSync, input: AutomationModuleInput): StoredAutomationModule {
  const timestamp = input.now ?? nowIso();
  db.prepare(`
    INSERT INTO automation_modules (id, manifest_json, enabled, installed_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      manifest_json = excluded.manifest_json,
      available = 1,
      updated_at = excluded.updated_at
  `).run(input.id, JSON.stringify(input.manifest), input.enabled ? 1 : 0, timestamp, timestamp);
  return mustGetAutomationModule(db, input.id);
}

export function markAutomationModulesUnavailableExcept(
  db: DatabaseSync,
  availableIds: string[],
  updatedAt = nowIso(),
): number {
  if (availableIds.length === 0) {
    const result = db.prepare("UPDATE automation_modules SET available = 0, updated_at = ?").run(updatedAt);
    return Number(result.changes);
  }
  const placeholders = availableIds.map(() => '?').join(", ");
  const result = db.prepare(`
    UPDATE automation_modules
    SET available = 0, updated_at = ?
    WHERE id NOT IN (${placeholders})
  `).run(updatedAt, ...availableIds);
  return Number(result.changes);
}

export function listAutomationModules(db: DatabaseSync): StoredAutomationModule[] {
  return db
    .prepare("SELECT * FROM automation_modules ORDER BY id ASC")
    .all()
    .map((row) => mapAutomationModule(row as unknown as AutomationModuleRow));
}

export function getAutomationModule(db: DatabaseSync, id: string): StoredAutomationModule | null {
  const row = db.prepare("SELECT * FROM automation_modules WHERE id = ?").get(id) as AutomationModuleRow | undefined;
  return row ? mapAutomationModule(row) : null;
}

export function mustGetAutomationModule(db: DatabaseSync, id: string): StoredAutomationModule {
  const module = getAutomationModule(db, id);
  if (!module) {
    throw new Error(`Automation module not found: ${id}`);
  }
  return module;
}

export function setAutomationModuleEnabled(
  db: DatabaseSync,
  id: string,
  enabled: boolean,
  updatedAt = nowIso(),
): StoredAutomationModule {
  const result = db
    .prepare("UPDATE automation_modules SET enabled = ?, updated_at = ? WHERE id = ?")
    .run(enabled ? 1 : 0, updatedAt, id);
  if (result.changes === 0) {
    throw new Error(`Automation module not found: ${id}`);
  }
  return mustGetAutomationModule(db, id);
}

export function createAutomationRun(db: DatabaseSync, input: CreateAutomationRunInput): StoredAutomationRun {
  const timestamp = input.now ?? nowIso();
  db.prepare(`
    INSERT INTO automation_runs (
      id, module_id, trigger, status, idempotency_key, started_at,
      stdout_path, stderr_path, result_path
    ) VALUES (?, ?, ?, 'RUNNING', ?, ?, ?, ?, ?)
  `).run(
    input.id,
    input.moduleId,
    input.trigger,
    input.idempotencyKey ?? null,
    timestamp,
    input.stdoutPath,
    input.stderrPath,
    input.resultPath,
  );
  appendAutomationEvent(db, input.id, "info", "Automation run started", {
    moduleId: input.moduleId,
    trigger: input.trigger,
  }, timestamp);
  return mustGetAutomationRun(db, input.id);
}

export function completeAutomationRun(db: DatabaseSync, input: CompleteAutomationRunInput): StoredAutomationRun {
  const endedAt = input.endedAt ?? nowIso();
  db.prepare(`
    UPDATE automation_runs
    SET status = ?, ended_at = ?, exit_code = ?, error = ?
    WHERE id = ?
  `).run(input.status, endedAt, input.exitCode ?? null, input.error ?? null, input.id);
  appendAutomationEvent(db, input.id, input.status === "SUCCEEDED" ? "info" : "error", "Automation run completed", {
    status: input.status,
    exitCode: input.exitCode,
    error: input.error,
  }, endedAt);
  return mustGetAutomationRun(db, input.id);
}

export function getAutomationRun(db: DatabaseSync, id: string): StoredAutomationRun | null {
  const row = db.prepare("SELECT * FROM automation_runs WHERE id = ?").get(id) as AutomationRunRow | undefined;
  return row ? mapAutomationRun(row) : null;
}

export function getAutomationRunByIdempotency(
  db: DatabaseSync,
  moduleId: string,
  idempotencyKey: string,
): StoredAutomationRun | null {
  const row = db
    .prepare("SELECT * FROM automation_runs WHERE module_id = ? AND idempotency_key = ?")
    .get(moduleId, idempotencyKey) as AutomationRunRow | undefined;
  return row ? mapAutomationRun(row) : null;
}

export function mustGetAutomationRun(db: DatabaseSync, id: string): StoredAutomationRun {
  const run = getAutomationRun(db, id);
  if (!run) {
    throw new Error(`Automation run not found: ${id}`);
  }
  return run;
}

export function listAutomationRuns(
  db: DatabaseSync,
  options: { moduleId?: string; limit?: number } = {},
): StoredAutomationRun[] {
  const limit = options.limit ?? 20;
  if (options.moduleId) {
    return db
      .prepare("SELECT * FROM automation_runs WHERE module_id = ? ORDER BY started_at DESC LIMIT ?")
      .all(options.moduleId, limit)
      .map((row) => mapAutomationRun(row as unknown as AutomationRunRow));
  }
  return db
    .prepare("SELECT * FROM automation_runs ORDER BY started_at DESC LIMIT ?")
    .all(limit)
    .map((row) => mapAutomationRun(row as unknown as AutomationRunRow));
}

export function appendAutomationEvent(
  db: DatabaseSync,
  runId: string,
  level: string,
  message: string,
  data?: unknown,
  createdAt = nowIso(),
): StoredAutomationEvent {
  const result = db.prepare(`
    INSERT INTO automation_events (run_id, level, message, data_json, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(runId, level, message, data === undefined ? null : JSON.stringify(data), createdAt);
  return mustGetAutomationEvent(db, Number(result.lastInsertRowid));
}

export function listAutomationEvents(db: DatabaseSync, runId: string): StoredAutomationEvent[] {
  return db
    .prepare("SELECT * FROM automation_events WHERE run_id = ? ORDER BY id ASC")
    .all(runId)
    .map((row) => mapAutomationEvent(row as unknown as AutomationEventRow));
}

export function mustGetAutomationEvent(db: DatabaseSync, id: number): StoredAutomationEvent {
  const row = db.prepare("SELECT * FROM automation_events WHERE id = ?").get(id) as AutomationEventRow | undefined;
  if (!row) {
    throw new Error(`Automation event not found: ${id}`);
  }
  return mapAutomationEvent(row);
}

export function upsertAutomationScheduleState(
  db: DatabaseSync,
  input: UpsertAutomationScheduleStateInput,
): StoredAutomationScheduleState {
  const updatedAt = input.updatedAt ?? nowIso();
  db.prepare(`
    INSERT INTO automation_schedule_state (
      module_id, last_due_key, last_due_at, next_due_at,
      consecutive_failures, retry_after, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(module_id) DO UPDATE SET
      last_due_key = excluded.last_due_key,
      last_due_at = excluded.last_due_at,
      next_due_at = excluded.next_due_at,
      consecutive_failures = excluded.consecutive_failures,
      retry_after = excluded.retry_after,
      updated_at = excluded.updated_at
  `).run(
    input.moduleId,
    input.lastDueKey ?? null,
    input.lastDueAt ?? null,
    input.nextDueAt ?? null,
    input.consecutiveFailures ?? 0,
    input.retryAfter ?? null,
    updatedAt,
  );
  return mustGetAutomationScheduleState(db, input.moduleId);
}

export function getAutomationScheduleState(
  db: DatabaseSync,
  moduleId: string,
): StoredAutomationScheduleState | null {
  const row = db
    .prepare("SELECT * FROM automation_schedule_state WHERE module_id = ?")
    .get(moduleId) as AutomationScheduleStateRow | undefined;
  return row ? mapAutomationScheduleState(row) : null;
}

export function mustGetAutomationScheduleState(
  db: DatabaseSync,
  moduleId: string,
): StoredAutomationScheduleState {
  const state = getAutomationScheduleState(db, moduleId);
  if (!state) {
    throw new Error(`Automation schedule state not found: ${moduleId}`);
  }
  return state;
}

export function createArtifactRendererRun(
  db: DatabaseSync,
  input: CreateArtifactRendererRunInput,
): StoredArtifactRendererRun {
  const timestamp = input.now ?? nowIso();
  db.prepare(`
    INSERT INTO artifact_renderer_runs (
      id, artifact_id, artifact_kind, renderer_mode, renderer_id, renderer_language,
      status, source_prompt, request_json, run_dir, output_dir,
      stdout_path, stderr_path, result_path, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'RUNNING', ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.id,
    input.artifactId,
    input.artifactKind,
    input.rendererMode,
    input.rendererId ?? null,
    input.rendererLanguage ?? null,
    input.sourcePrompt,
    JSON.stringify(input.request),
    input.runDir,
    input.outputDir,
    input.stdoutPath,
    input.stderrPath,
    input.resultPath,
    timestamp,
  );
  return mustGetArtifactRendererRun(db, input.id);
}

export function completeArtifactRendererRun(
  db: DatabaseSync,
  input: CompleteArtifactRendererRunInput,
): StoredArtifactRendererRun {
  const endedAt = input.endedAt ?? nowIso();
  db.prepare(`
    UPDATE artifact_renderer_runs
    SET status = ?, ended_at = ?, derived_bundle_path = ?, wiki_page_path = ?, error = ?, error_json = ?
    WHERE id = ?
  `).run(
    input.status,
    endedAt,
    input.derivedBundlePath ?? null,
    input.wikiPagePath ?? null,
    input.error ?? null,
    input.errorDiagnostic === undefined ? null : JSON.stringify(input.errorDiagnostic),
    input.id,
  );
  return mustGetArtifactRendererRun(db, input.id);
}

export function getArtifactRendererRun(db: DatabaseSync, id: string): StoredArtifactRendererRun | null {
  const row = db.prepare("SELECT * FROM artifact_renderer_runs WHERE id = ?").get(id) as ArtifactRendererRunRow | undefined;
  return row ? mapArtifactRendererRun(row) : null;
}

export function mustGetArtifactRendererRun(db: DatabaseSync, id: string): StoredArtifactRendererRun {
  const run = getArtifactRendererRun(db, id);
  if (!run) {
    throw new Error(`Artifact renderer run not found: ${id}`);
  }
  return run;
}

export function listArtifactRendererRuns(db: DatabaseSync, limit = 50): StoredArtifactRendererRun[] {
  return db
    .prepare("SELECT * FROM artifact_renderer_runs ORDER BY created_at DESC LIMIT ?")
    .all(limit)
    .map((row) => mapArtifactRendererRun(row as unknown as ArtifactRendererRunRow));
}

export function markArtifactRendererRunPromoted(
  db: DatabaseSync,
  id: string,
  promotedRendererId: string,
  promotedAt = nowIso(),
): StoredArtifactRendererRun {
  const result = db.prepare(`
    UPDATE artifact_renderer_runs
    SET promoted_at = ?, promoted_renderer_id = ?
    WHERE id = ?
  `).run(promotedAt, promotedRendererId, id);
  if (result.changes === 0) {
    throw new Error(`Artifact renderer run not found: ${id}`);
  }
  return mustGetArtifactRendererRun(db, id);
}

export function createVaultTombstone(db: DatabaseSync, input: CreateVaultTombstoneInput): StoredVaultTombstone {
  const timestamp = input.now ?? nowIso();
  db.prepare(`
    INSERT INTO vault_tombstones (
      id, target_type, target_id, job_id, reason, paths_json, metadata_json, created_by, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.id,
    input.targetType,
    input.targetId,
    input.jobId ?? null,
    input.reason,
    JSON.stringify(input.paths ?? []),
    input.metadata === undefined ? null : JSON.stringify(input.metadata),
    input.createdBy ?? null,
    timestamp,
  );
  if (input.jobId) {
    appendJobEvent(db, input.jobId, "vault.tombstone", input.reason, {
      tombstoneId: input.id,
      targetType: input.targetType,
      targetId: input.targetId,
      paths: input.paths ?? [],
    }, timestamp);
  }
  return mustGetVaultTombstone(db, input.id);
}

export function getVaultTombstone(db: DatabaseSync, id: string): StoredVaultTombstone | null {
  const row = db.prepare("SELECT * FROM vault_tombstones WHERE id = ?").get(id) as VaultTombstoneRow | undefined;
  return row ? mapVaultTombstone(row) : null;
}

export function mustGetVaultTombstone(db: DatabaseSync, id: string): StoredVaultTombstone {
  const tombstone = getVaultTombstone(db, id);
  if (!tombstone) {
    throw new Error(`Vault tombstone not found: ${id}`);
  }
  return tombstone;
}

export function listVaultTombstones(db: DatabaseSync, limit = 1000): StoredVaultTombstone[] {
  return db
    .prepare("SELECT * FROM vault_tombstones ORDER BY created_at DESC LIMIT ?")
    .all(limit)
    .map((row) => mapVaultTombstone(row as unknown as VaultTombstoneRow));
}

export function deleteVaultTombstone(db: DatabaseSync, id: string): boolean {
  const result = db.prepare("DELETE FROM vault_tombstones WHERE id = ?").run(id);
  return result.changes > 0;
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

function applyV2(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE job_outputs (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      file_path TEXT NOT NULL,
      file_name TEXT NOT NULL,
      mime_type TEXT,
      size_bytes INTEGER,
      sha256 TEXT,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      deleted_at TEXT
    );

    CREATE INDEX idx_job_outputs_job_id ON job_outputs(job_id);
    CREATE INDEX idx_job_outputs_expires_at ON job_outputs(expires_at, deleted_at);
  `);
}

function applyV3(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE job_claims (
      job_id TEXT PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
      worker_id TEXT NOT NULL,
      claimed_at TEXT NOT NULL,
      heartbeat_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );

    CREATE INDEX idx_job_claims_expires_at ON job_claims(expires_at);
    CREATE INDEX idx_job_claims_worker_id ON job_claims(worker_id);
  `);
}

function applyV4(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE automation_modules (
      id TEXT PRIMARY KEY,
      manifest_json TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 0,
      available INTEGER NOT NULL DEFAULT 1,
      installed_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE automation_runs (
      id TEXT PRIMARY KEY,
      module_id TEXT NOT NULL REFERENCES automation_modules(id) ON DELETE CASCADE,
      trigger TEXT NOT NULL,
      status TEXT NOT NULL,
      idempotency_key TEXT,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      exit_code INTEGER,
      stdout_path TEXT NOT NULL,
      stderr_path TEXT NOT NULL,
      result_path TEXT NOT NULL,
      error TEXT
    );

    CREATE INDEX idx_automation_runs_module_started ON automation_runs(module_id, started_at DESC);
    CREATE INDEX idx_automation_runs_status_started ON automation_runs(status, started_at DESC);
    CREATE UNIQUE INDEX idx_automation_runs_idempotency
      ON automation_runs(module_id, idempotency_key)
      WHERE idempotency_key IS NOT NULL;

    CREATE TABLE automation_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL REFERENCES automation_runs(id) ON DELETE CASCADE,
      level TEXT NOT NULL,
      message TEXT NOT NULL,
      data_json TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX idx_automation_events_run_id_id ON automation_events(run_id, id);
  `);
}

function applyV5(db: DatabaseSync): void {
  if (!hasTableColumn(db, "automation_modules", "available")) {
    db.exec("ALTER TABLE automation_modules ADD COLUMN available INTEGER NOT NULL DEFAULT 1;");
  }
}

function applyV6(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS automation_schedule_state (
      module_id TEXT PRIMARY KEY REFERENCES automation_modules(id) ON DELETE CASCADE,
      last_due_key TEXT,
      last_due_at TEXT,
      next_due_at TEXT,
      consecutive_failures INTEGER NOT NULL DEFAULT 0,
      retry_after TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_automation_schedule_next_due
      ON automation_schedule_state(next_due_at);
    CREATE INDEX IF NOT EXISTS idx_automation_schedule_retry_after
      ON automation_schedule_state(retry_after);
  `);
}

function applyV7(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS artifact_renderer_runs (
      id TEXT PRIMARY KEY,
      artifact_id TEXT NOT NULL,
      artifact_kind TEXT NOT NULL,
      renderer_mode TEXT NOT NULL,
      renderer_id TEXT,
      renderer_language TEXT,
      status TEXT NOT NULL,
      source_prompt TEXT NOT NULL,
      request_json TEXT NOT NULL,
      run_dir TEXT NOT NULL,
      output_dir TEXT NOT NULL,
      stdout_path TEXT NOT NULL,
      stderr_path TEXT NOT NULL,
      result_path TEXT NOT NULL,
      derived_bundle_path TEXT,
      wiki_page_path TEXT,
      promoted_at TEXT,
      promoted_renderer_id TEXT,
      created_at TEXT NOT NULL,
      ended_at TEXT,
      error TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_artifact_renderer_runs_created
      ON artifact_renderer_runs(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_artifact_renderer_runs_mode_created
      ON artifact_renderer_runs(renderer_mode, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_artifact_renderer_runs_status_created
      ON artifact_renderer_runs(status, created_at DESC);
  `);
}

function applyV8(db: DatabaseSync): void {
  if (!hasTableColumn(db, "artifact_renderer_runs", "error_json")) {
    db.exec(`
      ALTER TABLE artifact_renderer_runs ADD COLUMN error_json TEXT;
    `);
  }
}

function applyV9(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS vault_tombstones (
      id TEXT PRIMARY KEY,
      target_type TEXT NOT NULL,
      target_id TEXT NOT NULL,
      job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL,
      reason TEXT NOT NULL,
      paths_json TEXT NOT NULL DEFAULT '[]',
      metadata_json TEXT,
      created_by TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_vault_tombstones_target
      ON vault_tombstones(target_type, target_id);
    CREATE INDEX IF NOT EXISTS idx_vault_tombstones_job
      ON vault_tombstones(job_id);
    CREATE INDEX IF NOT EXISTS idx_vault_tombstones_created
      ON vault_tombstones(created_at DESC);
  `);
}

function recordMigration(db: DatabaseSync, version: number): void {
  db.prepare("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(version, nowIso());
}

function hasTableColumn(db: DatabaseSync, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.some((row) => row.name === column);
}

function nowIso(): string {
  return new Date().toISOString();
}

function addMsIso(baseIso: string, ms: number): string {
  return new Date(Date.parse(baseIso) + ms).toISOString();
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

function mapJobClaim(row: JobClaimRow): JobClaim {
  return {
    jobId: row.job_id,
    workerId: row.worker_id,
    claimedAt: row.claimed_at,
    heartbeatAt: row.heartbeat_at,
    expiresAt: row.expires_at,
  };
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

function mapJobOutput(row: JobOutputRow): StoredJobOutput {
  const output: StoredJobOutput = {
    id: row.id,
    jobId: row.job_id,
    kind: row.kind,
    filePath: row.file_path,
    fileName: row.file_name,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
  assignDefined(output, "mimeType", definedString(row.mime_type));
  assignDefined(output, "sizeBytes", definedNumber(row.size_bytes));
  assignDefined(output, "sha256", definedString(row.sha256));
  assignDefined(output, "deletedAt", definedString(row.deleted_at));
  return output;
}

function mapAutomationModule(row: AutomationModuleRow): StoredAutomationModule {
  return {
    id: row.id,
    manifest: parseOptionalJson(row.manifest_json),
    enabled: row.enabled === 1,
    available: row.available === 1,
    installedAt: row.installed_at,
    updatedAt: row.updated_at,
  };
}

function mapAutomationRun(row: AutomationRunRow): StoredAutomationRun {
  const run: StoredAutomationRun = {
    id: row.id,
    moduleId: row.module_id,
    trigger: row.trigger,
    status: row.status as AutomationRunStatus,
    startedAt: row.started_at,
    stdoutPath: row.stdout_path,
    stderrPath: row.stderr_path,
    resultPath: row.result_path,
  };
  assignDefined(run, "idempotencyKey", definedString(row.idempotency_key));
  assignDefined(run, "endedAt", definedString(row.ended_at));
  assignDefined(run, "exitCode", definedNumber(row.exit_code));
  assignDefined(run, "error", definedString(row.error));
  return run;
}

function mapAutomationEvent(row: AutomationEventRow): StoredAutomationEvent {
  const event: StoredAutomationEvent = {
    id: row.id,
    runId: row.run_id,
    level: row.level,
    message: row.message,
    createdAt: row.created_at,
  };
  assignDefined(event, "data", parseOptionalJson(row.data_json));
  return event;
}

function mapAutomationScheduleState(row: AutomationScheduleStateRow): StoredAutomationScheduleState {
  const state: StoredAutomationScheduleState = {
    moduleId: row.module_id,
    consecutiveFailures: row.consecutive_failures,
    updatedAt: row.updated_at,
  };
  assignDefined(state, "lastDueKey", definedString(row.last_due_key));
  assignDefined(state, "lastDueAt", definedString(row.last_due_at));
  assignDefined(state, "nextDueAt", definedString(row.next_due_at));
  assignDefined(state, "retryAfter", definedString(row.retry_after));
  return state;
}

function mapArtifactRendererRun(row: ArtifactRendererRunRow): StoredArtifactRendererRun {
  const run: StoredArtifactRendererRun = {
    id: row.id,
    artifactId: row.artifact_id,
    artifactKind: row.artifact_kind,
    rendererMode: row.renderer_mode,
    status: row.status as ArtifactRendererRunStatus,
    sourcePrompt: row.source_prompt,
    request: parseOptionalJson(row.request_json),
    runDir: row.run_dir,
    outputDir: row.output_dir,
    stdoutPath: row.stdout_path,
    stderrPath: row.stderr_path,
    resultPath: row.result_path,
    createdAt: row.created_at,
  };
  assignDefined(run, "rendererId", definedString(row.renderer_id));
  assignDefined(run, "rendererLanguage", definedString(row.renderer_language));
  assignDefined(run, "derivedBundlePath", definedString(row.derived_bundle_path));
  assignDefined(run, "wikiPagePath", definedString(row.wiki_page_path));
  assignDefined(run, "promotedAt", definedString(row.promoted_at));
  assignDefined(run, "promotedRendererId", definedString(row.promoted_renderer_id));
  assignDefined(run, "endedAt", definedString(row.ended_at));
  assignDefined(run, "error", definedString(row.error));
  assignDefined(run, "errorDiagnostic", parseOptionalJson(row.error_json));
  return run;
}

function mapVaultTombstone(row: VaultTombstoneRow): StoredVaultTombstone {
  const tombstone: StoredVaultTombstone = {
    id: row.id,
    targetType: row.target_type as VaultTombstoneTargetType,
    targetId: row.target_id,
    reason: row.reason,
    paths: parseJsonArray(row.paths_json),
    createdAt: row.created_at,
  };
  assignDefined(tombstone, "jobId", definedString(row.job_id));
  assignDefined(tombstone, "metadata", parseOptionalJson(row.metadata_json));
  assignDefined(tombstone, "createdBy", definedString(row.created_by));
  return tombstone;
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

interface JobOutputRow {
  id: string;
  job_id: string;
  kind: string;
  file_path: string;
  file_name: string;
  mime_type: string | null;
  size_bytes: number | null;
  sha256: string | null;
  created_at: string;
  expires_at: string;
  deleted_at: string | null;
}

interface JobClaimRow {
  job_id: string;
  worker_id: string;
  claimed_at: string;
  heartbeat_at: string;
  expires_at: string;
}

interface AutomationModuleRow {
  id: string;
  manifest_json: string;
  enabled: number;
  available: number;
  installed_at: string;
  updated_at: string;
}

interface AutomationRunRow {
  id: string;
  module_id: string;
  trigger: string;
  status: string;
  idempotency_key: string | null;
  started_at: string;
  ended_at: string | null;
  exit_code: number | null;
  stdout_path: string;
  stderr_path: string;
  result_path: string;
  error: string | null;
}

interface AutomationEventRow {
  id: number;
  run_id: string;
  level: string;
  message: string;
  data_json: string | null;
  created_at: string;
}

interface AutomationScheduleStateRow {
  module_id: string;
  last_due_key: string | null;
  last_due_at: string | null;
  next_due_at: string | null;
  consecutive_failures: number;
  retry_after: string | null;
  updated_at: string;
}

interface ArtifactRendererRunRow {
  id: string;
  artifact_id: string;
  artifact_kind: string;
  renderer_mode: string;
  renderer_id: string | null;
  renderer_language: string | null;
  status: string;
  source_prompt: string;
  request_json: string;
  run_dir: string;
  output_dir: string;
  stdout_path: string;
  stderr_path: string;
  result_path: string;
  derived_bundle_path: string | null;
  wiki_page_path: string | null;
  promoted_at: string | null;
  promoted_renderer_id: string | null;
  created_at: string;
  ended_at: string | null;
  error: string | null;
  error_json: string | null;
}

interface VaultTombstoneRow {
  id: string;
  target_type: string;
  target_id: string;
  job_id: string | null;
  reason: string;
  paths_json: string;
  metadata_json: string | null;
  created_by: string | null;
  created_at: string;
}
