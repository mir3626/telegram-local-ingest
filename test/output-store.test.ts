import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createJob, getJobOutput, listJobEvents, migrate, openIngestDatabase } from "@telegram-local-ingest/db";
import {
  cleanupExpiredOutputs,
  createRuntimeOutput,
  discardRuntimeOutput,
  resolveDownloadableOutput,
} from "@telegram-local-ingest/output-store";

const NOW = "2026-04-22T12:00:00.000Z";

test("createRuntimeOutput copies files into runtime outputs and tracks expiry", async () => {
  const fixture = createFixture();
  const sourcePath = path.join(fixture.root, "translated.md");
  fs.writeFileSync(sourcePath, "translated", "utf8");
  const dbHandle = openIngestDatabase(":memory:");
  try {
    migrate(dbHandle.db);
    createJob(dbHandle.db, { id: "job-1", source: "telegram-local-bot-api", now: NOW });

    const output = await createRuntimeOutput({
      db: dbHandle.db,
      jobId: "job-1",
      runtimeDir: fixture.runtimeDir,
      sourcePath,
      kind: "agent_translation",
      fileName: "translated result.md",
      mimeType: "text/markdown",
      now: NOW,
      ttlMs: 1000,
      outputId: "out-test",
    });

    assert.equal(output.id, "out-test");
    assert.equal(output.expiresAt, "2026-04-22T12:00:01.000Z");
    assert.equal(fs.readFileSync(output.filePath, "utf8"), "translated");
    assert.equal(getJobOutput(dbHandle.db, "out-test")?.fileName, "translated result.md");
    assert.equal(resolveDownloadableOutput(dbHandle.db, "out-test", NOW).status, "active");
    assert.equal(resolveDownloadableOutput(dbHandle.db, "out-test", "2026-04-22T12:00:01.000Z").status, "expired");
    assert.ok(listJobEvents(dbHandle.db, "job-1").some((event) => event.type === "output.created"));
  } finally {
    dbHandle.close();
  }
});

test("cleanupExpiredOutputs deletes expired output files and marks records", async () => {
  const fixture = createFixture();
  const sourcePath = path.join(fixture.root, "old.md");
  fs.writeFileSync(sourcePath, "old", "utf8");
  const dbHandle = openIngestDatabase(":memory:");
  try {
    migrate(dbHandle.db);
    createJob(dbHandle.db, { id: "job-2", source: "telegram-local-bot-api", now: NOW });
    const output = await createRuntimeOutput({
      db: dbHandle.db,
      jobId: "job-2",
      runtimeDir: fixture.runtimeDir,
      sourcePath,
      kind: "agent_translation",
      now: NOW,
      ttlMs: 1,
      outputId: "out-old",
    });

    const cleanup = await cleanupExpiredOutputs(dbHandle.db, { now: "2026-04-22T12:00:00.001Z" });

    assert.equal(cleanup.failedOutputs.length, 0);
    assert.equal(cleanup.deletedOutputs.map((deleted) => deleted.id).join(","), "out-old");
    assert.equal(fs.existsSync(output.filePath), false);
    assert.equal(resolveDownloadableOutput(dbHandle.db, "out-old", "2026-04-22T12:00:02.000Z").status, "deleted");
  } finally {
    dbHandle.close();
  }
});

test("discardRuntimeOutput deletes an active output and marks it deleted", async () => {
  const fixture = createFixture();
  const sourcePath = path.join(fixture.root, "discard.md");
  fs.writeFileSync(sourcePath, "discard", "utf8");
  const dbHandle = openIngestDatabase(":memory:");
  try {
    migrate(dbHandle.db);
    createJob(dbHandle.db, { id: "job-discard", source: "telegram-local-bot-api", now: NOW });
    const output = await createRuntimeOutput({
      db: dbHandle.db,
      jobId: "job-discard",
      runtimeDir: fixture.runtimeDir,
      sourcePath,
      kind: "agent_translation",
      now: NOW,
      ttlMs: 10_000,
      outputId: "out-discard",
    });

    const discarded = await discardRuntimeOutput(dbHandle.db, output.id, "2026-04-22T12:00:02.000Z");

    assert.equal(discarded.fileDeleted, true);
    assert.equal(fs.existsSync(output.filePath), false);
    assert.equal(resolveDownloadableOutput(dbHandle.db, output.id, "2026-04-22T12:00:03.000Z").status, "deleted");
    assert.ok(listJobEvents(dbHandle.db, "job-discard").some((event) => event.type === "output.deleted"));
  } finally {
    dbHandle.close();
  }
});

function createFixture(): { root: string; runtimeDir: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "output-store-"));
  return {
    root,
    runtimeDir: path.join(root, "runtime"),
  };
}
