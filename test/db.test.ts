import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  addJobFile,
  canRetry,
  createJob,
  createSourceBundle,
  getCurrentSchemaVersion,
  getJob,
  getTelegramOffset,
  isValidTransition,
  listJobEvents,
  listJobFiles,
  migrate,
  openIngestDatabase,
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
    assert.equal(listJobEvents(handle.db, "job-4").at(-1)?.type, "bundle.created");
  } finally {
    handle.close();
  }
});

function tempDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "telegram-local-ingest-db-"));
  return path.join(dir, "ingest.db");
}
