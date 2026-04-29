import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  addJobFile,
  canRetry,
  claimRunnableJobs,
  completeArtifactRendererRun,
  createArtifactRendererRun,
  createJob,
  createJobOutput,
  createSourceBundle,
  createVaultTombstone,
  getCurrentSchemaVersion,
  getVaultTombstone,
  getJob,
  getJobClaim,
  getJobOutput,
  getArtifactRendererRun,
  getTelegramOffset,
  isValidTransition,
  listExpiredJobOutputs,
  listAllJobOutputs,
  listJobEvents,
  listJobFiles,
  listJobOutputs,
  listSourceBundles,
  listVaultTombstones,
  markJobOutputDeleted,
  migrate,
  openIngestDatabase,
  releaseJobClaim,
  renewJobClaim,
  requestRetry,
  SCHEMA_VERSION,
  setTelegramOffset,
  transitionJob,
} from "@telegram-local-ingest/db";

const NOW = "2026-04-22T08:30:00.000Z";

test("migrate creates the dashboard-ready operational schema", () => {
  const handle = openIngestDatabase(":memory:");
  try {
    migrate(handle.db);

    assert.equal(getCurrentSchemaVersion(handle.db), SCHEMA_VERSION);
    const tableNames = handle.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((row) => (row as { name: string }).name);

    assert.ok(tableNames.includes("jobs"));
    assert.ok(tableNames.includes("job_files"));
    assert.ok(tableNames.includes("job_events"));
    assert.ok(tableNames.includes("telegram_offsets"));
    assert.ok(tableNames.includes("source_bundles"));
    assert.ok(tableNames.includes("job_outputs"));
    assert.ok(tableNames.includes("job_claims"));
    assert.ok(tableNames.includes("vault_tombstones"));
  } finally {
    handle.close();
  }
});

test("jobs persist across database reopen", () => {
  const dbPath = tempDbPath();
  const first = openIngestDatabase(dbPath);
  try {
    migrate(first.db);
    createJob(first.db, {
      id: "job-1",
      source: "telegram-local-bot-api",
      chatId: "chat-1",
      userId: "user-1",
      command: "/ingest",
      project: "wechat-sales",
      tags: ["lead", "screenshot"],
      instructions: "preserve source language",
      now: NOW,
    });
  } finally {
    first.close();
  }

  const second = openIngestDatabase(dbPath);
  try {
    migrate(second.db);
    const job = getJob(second.db, "job-1");
    assert.equal(job?.status, "RECEIVED");
    assert.equal(job?.source, "telegram-local-bot-api");
    assert.equal(job?.project, "wechat-sales");
    assert.deepEqual(job?.tags, ["lead", "screenshot"]);
    assert.equal(job?.retryCount, 0);
  } finally {
    second.close();
  }
});

test("state machine accepts forward transitions and rejects invalid jumps", () => {
  const handle = openIngestDatabase(":memory:");
  try {
    migrate(handle.db);
    createJob(handle.db, { id: "job-2", source: "telegram-local-bot-api", now: NOW });

    assert.equal(isValidTransition("RECEIVED", "QUEUED"), true);
    assert.equal(isValidTransition("QUEUED", "COMPLETED"), false);

    transitionJob(handle.db, "job-2", "QUEUED", { now: NOW });
    transitionJob(handle.db, "job-2", "IMPORTING", { now: NOW });
    assert.throws(() => transitionJob(handle.db, "job-2", "COMPLETED", { now: NOW }), /Invalid job transition/);

    const failed = transitionJob(handle.db, "job-2", "FAILED", { now: NOW, error: "network timeout" });
    assert.equal(failed.status, "FAILED");
    assert.equal(failed.error, "network timeout");
    assert.equal(canRetry(failed.status), true);

    const retry = requestRetry(handle.db, "job-2", { now: NOW });
    assert.equal(retry.status, "RETRY_REQUESTED");
    assert.equal(retry.retryCount, 1);

    const queued = transitionJob(handle.db, "job-2", "QUEUED", { now: NOW });
    assert.equal(queued.status, "QUEUED");
    assert.equal(queued.error, undefined);
  } finally {
    handle.close();
  }
});

test("events reconstruct job history and files remain queryable for dashboards", () => {
  const handle = openIngestDatabase(":memory:");
  try {
    migrate(handle.db);
    createJob(handle.db, { id: "job-3", source: "telegram-local-bot-api", now: NOW });
    transitionJob(handle.db, "job-3", "QUEUED", { now: NOW });
    addJobFile(handle.db, {
      id: "file-1",
      jobId: "job-3",
      sourceFileId: "telegram-file-id",
      fileUniqueId: "telegram-unique-id",
      originalName: "capture.png",
      mimeType: "image/png",
      sizeBytes: 1234,
      sha256: "abc123",
      localPath: "runtime/staging/capture.png",
      archivePath: "runtime/archive/originals/capture.png",
      now: NOW,
    });
    transitionJob(handle.db, "job-3", "IMPORTING", { now: NOW });

    const events = listJobEvents(handle.db, "job-3");
    assert.deepEqual(
      events.map((event) => event.type),
      ["job.created", "job.transition", "file.added", "job.transition"],
    );
    assert.deepEqual(events[1]?.data, { from: "RECEIVED", to: "QUEUED" });

    const files = listJobFiles(handle.db, "job-3");
    assert.equal(files.length, 1);
    assert.equal(files[0]?.sha256, "abc123");
    assert.equal(files[0]?.sizeBytes, 1234);
  } finally {
    handle.close();
  }
});

test("artifact renderer runs retain structured error diagnostics", () => {
  const handle = openIngestDatabase(":memory:");
  try {
    migrate(handle.db);
    createArtifactRendererRun(handle.db, {
      id: "artifact-run-1",
      artifactId: "demo",
      artifactKind: "chart",
      rendererMode: "generated",
      rendererLanguage: "javascript",
      sourcePrompt: "차트 생성",
      request: { action: "create_derived_artifact" },
      runDir: "/tmp/run",
      outputDir: "/tmp/run/outputs",
      stdoutPath: "/tmp/run/stdout.log",
      stderrPath: "/tmp/run/stderr.log",
      resultPath: "/tmp/run/result.json",
      now: NOW,
    });
    completeArtifactRendererRun(handle.db, {
      id: "artifact-run-1",
      status: "FAILED",
      error: "source glob matched no files",
      errorDiagnostic: {
        name: "Error",
        message: "source glob matched no files",
        stack: "Error: source glob matched no files\n    at buildSourceSnapshot",
        context: { phase: "artifact_source_snapshot" },
      },
      endedAt: NOW,
    });

    const run = getArtifactRendererRun(handle.db, "artifact-run-1");
    assert.equal(run?.status, "FAILED");
    assert.equal(run?.error, "source glob matched no files");
    assert.deepEqual(run?.errorDiagnostic, {
      name: "Error",
      message: "source glob matched no files",
      stack: "Error: source glob matched no files\n    at buildSourceSnapshot",
      context: { phase: "artifact_source_snapshot" },
    });
  } finally {
    handle.close();
  }
});

test("telegram offsets and source bundles are persisted", () => {
  const handle = openIngestDatabase(":memory:");
  try {
    migrate(handle.db);
    createJob(handle.db, { id: "job-4", source: "telegram-local-bot-api", now: NOW });

    assert.equal(getTelegramOffset(handle.db, "bot-hash"), null);
    setTelegramOffset(handle.db, "bot-hash", 101, NOW);
    assert.equal(getTelegramOffset(handle.db, "bot-hash"), 101);
    setTelegramOffset(handle.db, "bot-hash", 102, NOW);
    assert.equal(getTelegramOffset(handle.db, "bot-hash"), 102);

    const bundle = createSourceBundle(handle.db, {
      id: "bundle-1",
      jobId: "job-4",
      bundlePath: "raw/2026-04-22/tg_1_abc",
      manifestPath: "raw/2026-04-22/tg_1_abc/manifest.yaml",
      sourceMarkdownPath: "raw/2026-04-22/tg_1_abc/source.md",
      now: NOW,
    });

    assert.equal(bundle.finalizedAt, NOW);
    assert.deepEqual(listSourceBundles(handle.db).map((item) => item.id), ["bundle-1"]);
    assert.equal(listJobEvents(handle.db, "job-4").at(-1)?.type, "bundle.created");
  } finally {
    handle.close();
  }
});

test("job outputs track downloadable files with expiry and deletion state", () => {
  const handle = openIngestDatabase(":memory:");
  try {
    migrate(handle.db);
    createJob(handle.db, { id: "job-outputs", source: "telegram-local-bot-api", now: NOW });

    const output = createJobOutput(handle.db, {
      id: "out-1",
      jobId: "job-outputs",
      kind: "agent_translation",
      filePath: "/tmp/out.md",
      fileName: "translated.md",
      mimeType: "text/markdown",
      sizeBytes: 123,
      sha256: "abc123",
      createdAt: NOW,
      expiresAt: "2026-04-23T08:30:00.000Z",
    });

    assert.equal(output.fileName, "translated.md");
    assert.equal(getJobOutput(handle.db, "out-1")?.kind, "agent_translation");
    assert.equal(listJobOutputs(handle.db, "job-outputs").length, 1);
    assert.equal(listAllJobOutputs(handle.db).length, 1);
    assert.equal(listExpiredJobOutputs(handle.db, "2026-04-23T08:29:59.000Z").length, 0);
    assert.equal(listExpiredJobOutputs(handle.db, "2026-04-23T08:30:00.000Z").length, 1);

    const deleted = markJobOutputDeleted(handle.db, "out-1", "2026-04-23T09:00:00.000Z");
    assert.equal(deleted.deletedAt, "2026-04-23T09:00:00.000Z");
    assert.equal(listExpiredJobOutputs(handle.db, "2026-04-24T00:00:00.000Z").length, 0);
    assert.ok(listJobEvents(handle.db, "job-outputs").some((event) => event.type === "output.created"));
    assert.ok(listJobEvents(handle.db, "job-outputs").some((event) => event.type === "output.deleted"));
  } finally {
    handle.close();
  }
});

test("vault tombstones preserve managed deletion history", () => {
  const handle = openIngestDatabase(":memory:");
  try {
    migrate(handle.db);
    createJob(handle.db, { id: "job-tombstone", source: "telegram-local-bot-api", now: NOW });

    const tombstone = createVaultTombstone(handle.db, {
      id: "vault-delete-1",
      targetType: "source_bundle",
      targetId: "bundle-delete-1",
      jobId: "job-tombstone",
      reason: "operator cleanup",
      paths: ["/vault/raw/2026-04-22/bundle-delete-1", "/vault/wiki/sources/bundle-delete-1.md"],
      metadata: { deleted: 2 },
      createdBy: "test",
      now: NOW,
    });

    assert.equal(tombstone.targetType, "source_bundle");
    assert.deepEqual(tombstone.paths, ["/vault/raw/2026-04-22/bundle-delete-1", "/vault/wiki/sources/bundle-delete-1.md"]);
    assert.deepEqual(getVaultTombstone(handle.db, "vault-delete-1")?.metadata, { deleted: 2 });
    assert.equal(listVaultTombstones(handle.db).length, 1);
    assert.ok(listJobEvents(handle.db, "job-tombstone").some((event) => event.type === "vault.tombstone"));
  } finally {
    handle.close();
  }
});

test("job claims reserve runnable work and expire safely", () => {
  const handle = openIngestDatabase(":memory:");
  try {
    migrate(handle.db);
    createJob(handle.db, { id: "job-claim-1", source: "telegram-local-bot-api", now: "2026-04-22T08:30:00.000Z" });
    createJob(handle.db, { id: "job-claim-2", source: "telegram-local-bot-api", now: "2026-04-22T08:30:01.000Z" });
    transitionJob(handle.db, "job-claim-1", "QUEUED", { now: NOW });
    transitionJob(handle.db, "job-claim-2", "QUEUED", { now: NOW });

    const first = claimRunnableJobs(handle.db, {
      workerId: "worker-a",
      limit: 1,
      leaseMs: 1000,
      now: "2026-04-22T08:31:00.000Z",
    });
    assert.deepEqual(first.map((job) => job.id), ["job-claim-1"]);
    assert.equal(getJobClaim(handle.db, "job-claim-1")?.workerId, "worker-a");

    const second = claimRunnableJobs(handle.db, {
      workerId: "worker-b",
      limit: 5,
      leaseMs: 1000,
      now: "2026-04-22T08:31:00.500Z",
    });
    assert.deepEqual(second.map((job) => job.id), ["job-claim-2"]);

    assert.equal(renewJobClaim(handle.db, "job-claim-1", "worker-a", 1000, "2026-04-22T08:31:00.750Z"), true);
    assert.equal(releaseJobClaim(handle.db, "job-claim-2", "worker-b"), true);
    assert.equal(getJobClaim(handle.db, "job-claim-2"), null);

    const expired = claimRunnableJobs(handle.db, {
      workerId: "worker-b",
      limit: 5,
      leaseMs: 1000,
      now: "2026-04-22T08:31:02.000Z",
    });
    assert.deepEqual(expired.map((job) => job.id), ["job-claim-1", "job-claim-2"]);
    assert.equal(getJobClaim(handle.db, "job-claim-1")?.workerId, "worker-b");
  } finally {
    handle.close();
  }
});

function tempDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "telegram-local-ingest-db-"));
  return path.join(dir, "ingest.db");
}
