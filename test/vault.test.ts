import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { StoredJob, StoredJobEvent, StoredJobFile } from "@telegram-local-ingest/db";
import { buildRawBundlePaths, RawBundleError, writeRawBundle } from "@telegram-local-ingest/vault";

const NOW = "2026-04-22T11:00:00.000Z";

test("buildRawBundlePaths creates deterministic paths under the vault raw root", () => {
  const vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), "vault-paths-"));
  const paths = buildRawBundlePaths({
    vaultPath,
    rawRoot: "raw",
    date: "2026-04-22",
    sourceId: "tg:chat/message",
  });

  assert.equal(paths.root, path.join(vaultPath, "raw", "2026-04-22", "tg_chat_message"));
  assert.equal(paths.manifest, path.join(paths.root, "manifest.yaml"));
  assert.throws(
    () => buildRawBundlePaths({ vaultPath, rawRoot: "../outside", date: "2026-04-22", sourceId: "job" }),
    RawBundleError,
  );
});

test("writeRawBundle creates manifest, source markdown, log, marker, and original files", async () => {
  const fixture = createFixture();
  const originalPath = writeFile(fixture.runtimeDir, "archive/originals/lead.txt", "lead content");
  const extractedPath = writeFile(fixture.runtimeDir, "extracted/lead.md", "# Lead\n");

  const result = await writeRawBundle({
    vaultPath: fixture.vaultPath,
    rawRoot: "raw",
    job: jobFixture(),
    files: [
      {
        id: "file-1",
        jobId: "job-1",
        originalName: "lead.txt",
        mimeType: "text/plain",
        sizeBytes: 12,
        sha256: "abc123",
        archivePath: originalPath,
        createdAt: NOW,
      },
    ],
    extractedArtifacts: [{ sourcePath: extractedPath, name: "lead.md", mimeType: "text/markdown" }],
    events: [eventFixture()],
    now: NOW,
  });

  assert.equal(result.id, "tg_300_21");
  assert.equal(fs.readFileSync(path.join(result.paths.originalDir, "lead.txt"), "utf8"), "lead content");
  assert.equal(fs.readFileSync(path.join(result.paths.extractedDir, "lead.md"), "utf8"), "# Lead\n");
  assert.match(fs.readFileSync(result.paths.manifest, "utf8"), /bundle_id: "tg_300_21"/);
  assert.match(fs.readFileSync(result.paths.manifest, "utf8"), /sha256: "abc123"/);
  assert.match(fs.readFileSync(result.paths.sourceMarkdown, "utf8"), /## Original Files/);
  assert.match(fs.readFileSync(result.paths.sourceMarkdown, "utf8"), /\[lead.txt\]\(original\/lead.txt\)/);
  assert.match(fs.readFileSync(result.paths.logMarkdown, "utf8"), /job.transition: QUEUED -> IMPORTING/);
  assert.match(fs.readFileSync(result.paths.finalizedMarker, "utf8"), /finalized_at=/);
});

test("writeRawBundle refuses to overwrite finalized bundles", async () => {
  const fixture = createFixture();
  const originalPath = writeFile(fixture.runtimeDir, "archive/originals/lead.txt", "first");
  const job = jobFixture();
  const file = fileFixture(originalPath);

  const first = await writeRawBundle({
    vaultPath: fixture.vaultPath,
    rawRoot: "raw",
    job,
    files: [file],
    now: NOW,
  });
  fs.writeFileSync(path.join(first.paths.originalDir, "lead.txt"), "changed", "utf8");

  await assert.rejects(
    () =>
      writeRawBundle({
        vaultPath: fixture.vaultPath,
        rawRoot: "raw",
        job,
        files: [file],
        now: NOW,
      }),
    RawBundleError,
  );
  assert.equal(fs.readFileSync(path.join(first.paths.originalDir, "lead.txt"), "utf8"), "changed");
});

function createFixture(): { vaultPath: string; runtimeDir: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vault-writer-"));
  return {
    vaultPath: path.join(root, "vault"),
    runtimeDir: path.join(root, "runtime"),
  };
}

function writeFile(root: string, relativePath: string, content: string): string {
  const filePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
  return filePath;
}

function jobFixture(): StoredJob {
  return {
    id: "tg_300_21",
    source: "telegram-local-bot-api",
    status: "BUNDLE_WRITING",
    chatId: "300",
    userId: "400",
    command: "/ingest project:sales tag:lead",
    project: "sales",
    tags: ["lead"],
    instructions: "preserve Korean text",
    retryCount: 0,
    createdAt: "2026-04-22T10:30:00.000Z",
    updatedAt: "2026-04-22T10:31:00.000Z",
  };
}

function fileFixture(archivePath: string): StoredJobFile {
  return {
    id: "file-1",
    jobId: "tg_300_21",
    originalName: "lead.txt",
    mimeType: "text/plain",
    sizeBytes: 5,
    sha256: "abc123",
    archivePath,
    createdAt: NOW,
  };
}

function eventFixture(): StoredJobEvent {
  return {
    id: 1,
    jobId: "tg_300_21",
    type: "job.transition",
    message: "QUEUED -> IMPORTING",
    createdAt: NOW,
  };
}
