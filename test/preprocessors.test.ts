import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  collectPreprocessedTextArtifacts,
  isTextLikeJobFile,
} from "@telegram-local-ingest/preprocessors";
import type { StoredJob, StoredJobFile, StoredSourceBundle } from "@telegram-local-ingest/db";

test("collectPreprocessedTextArtifacts reads text originals and bundled transcripts", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "preprocessors-"));
  const originalPath = writeFile(root, "runtime/archive/originals/note.txt", "Please translate this note.");
  writeFile(root, "vault/raw/2026-04-23/job-1/extracted/call.transcript.md", "회의 전사입니다.");

  const result = await collectPreprocessedTextArtifacts({
    job: jobFixture("job-1"),
    files: [
      fileFixture({
        id: "file-text",
        originalName: "note.txt",
        mimeType: "text/plain",
        archivePath: originalPath,
      }),
      fileFixture({
        id: "file-binary",
        originalName: "image.png",
        mimeType: "image/png",
      }),
    ],
    sourceBundle: bundleFixture(root, "job-1"),
  });

  assert.equal(result.jobId, "job-1");
  assert.deepEqual(result.artifacts.map((artifact) => artifact.kind), ["original_text", "transcript_markdown"]);
  assert.match(result.artifacts[0]?.text ?? "", /translate this note/);
  assert.match(result.artifacts[1]?.text ?? "", /회의 전사/);
  assert.deepEqual(result.skippedFiles, [{
    fileId: "file-binary",
    fileName: "image.png",
    reason: "unsupported_file_type",
  }]);
});

test("collectPreprocessedTextArtifacts marks large text previews as truncated", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "preprocessors-truncate-"));
  const originalPath = writeFile(root, "runtime/archive/originals/large.txt", "a".repeat(128));

  const result = await collectPreprocessedTextArtifacts({
    job: jobFixture("job-2"),
    files: [fileFixture({ id: "file-large", originalName: "large.txt", archivePath: originalPath })],
    sourceBundle: bundleFixture(root, "job-2"),
    maxBytesPerArtifact: 16,
  });

  assert.equal(result.artifacts.length, 1);
  assert.equal(result.artifacts[0]?.charCount, 16);
  assert.equal(result.artifacts[0]?.truncated, true);
});

test("isTextLikeJobFile accepts common text extensions and mimes", () => {
  assert.equal(isTextLikeJobFile(fileFixture({ originalName: "memo.md" })), true);
  assert.equal(isTextLikeJobFile(fileFixture({ originalName: "data.bin", mimeType: "application/json" })), true);
  assert.equal(isTextLikeJobFile(fileFixture({ originalName: "photo.jpg", mimeType: "image/jpeg" })), false);
});

function writeFile(root: string, relativePath: string, content: string): string {
  const filePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
  return filePath;
}

function jobFixture(id: string): StoredJob {
  return {
    id,
    source: "telegram-local-bot-api",
    status: "INGESTING",
    tags: [],
    retryCount: 0,
    createdAt: "2026-04-23T00:00:00.000Z",
    updatedAt: "2026-04-23T00:00:00.000Z",
  };
}

function fileFixture(overrides: Partial<StoredJobFile>): StoredJobFile {
  return {
    id: overrides.id ?? "file-1",
    jobId: "job-1",
    createdAt: "2026-04-23T00:00:00.000Z",
    ...overrides,
  };
}

function bundleFixture(root: string, id: string): StoredSourceBundle {
  const bundlePath = path.join(root, "vault", "raw", "2026-04-23", id);
  fs.mkdirSync(path.join(bundlePath, "extracted"), { recursive: true });
  return {
    id,
    jobId: id,
    bundlePath,
    manifestPath: path.join(bundlePath, "manifest.yaml"),
    sourceMarkdownPath: path.join(bundlePath, "source.md"),
    finalizedAt: "2026-04-23T00:00:00.000Z",
    createdAt: "2026-04-23T00:00:00.000Z",
  };
}
