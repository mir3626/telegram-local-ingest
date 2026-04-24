import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import zlib from "node:zlib";

import {
  collectPreprocessedTextArtifacts,
  isDocxJobFile,
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

test("collectPreprocessedTextArtifacts extracts DOCX text into runtime artifacts", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "preprocessors-docx-"));
  const originalPath = writeMinimalDocx(
    root,
    "runtime/archive/originals/vendor-update.docx",
    "This vendor update requires Korean translation & formatting.",
  );
  const artifactRoot = path.join(root, "runtime/extracted/job-docx/preprocess");

  const result = await collectPreprocessedTextArtifacts({
    job: jobFixture("job-docx"),
    files: [
      fileFixture({
        id: "file-docx",
        originalName: "vendor-update.docx",
        mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        archivePath: originalPath,
      }),
    ],
    sourceBundle: bundleFixture(root, "job-docx"),
    artifactRoot,
  });

  assert.equal(result.jobId, "job-docx");
  assert.equal(result.skippedFiles.length, 0);
  assert.equal(result.artifacts.length, 1);
  assert.equal(result.artifacts[0]?.kind, "docx_text");
  assert.match(result.artifacts[0]?.text ?? "", /vendor update requires Korean translation & formatting/);
  assert.match(result.artifacts[0]?.sourcePath ?? "", /runtime\/extracted\/job-docx\/preprocess\/file-docx\/vendor-update\.txt$/);
  assert.match(fs.readFileSync(result.artifacts[0]?.sourcePath ?? "", "utf8"), /vendor update requires Korean translation/);
});

test("collectPreprocessedTextArtifacts extracts PDF text into runtime artifacts", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "preprocessors-pdf-"));
  const originalPath = writeFile(root, "runtime/archive/originals/chinese-food-law.pdf", "%PDF-1.4\n");
  const toolRoot = path.join(root, "tools");
  const fakePdftotext = writeExecutable(toolRoot, "pdftotext", [
    "#!/bin/sh",
    "printf 'Chinese food law requires Korean translation.\\nArticle 1.\\n'",
  ].join("\n"));
  const previousPdftotext = process.env.PDFTOTEXT_BIN;
  const artifactRoot = path.join(root, "runtime/extracted/job-pdf/preprocess");

  try {
    process.env.PDFTOTEXT_BIN = fakePdftotext;
    const result = await collectPreprocessedTextArtifacts({
      job: jobFixture("job-pdf"),
      files: [
        fileFixture({
          id: "file-pdf",
          originalName: "chinese-food-law.pdf",
          mimeType: "application/pdf",
          archivePath: originalPath,
        }),
      ],
      sourceBundle: bundleFixture(root, "job-pdf"),
      artifactRoot,
    });

    assert.equal(result.jobId, "job-pdf");
    assert.equal(result.skippedFiles.length, 0);
    assert.equal(result.artifacts.length, 1);
    assert.equal(result.artifacts[0]?.kind, "pdf_text");
    assert.match(result.artifacts[0]?.text ?? "", /Chinese food law requires Korean translation/);
    assert.match(result.artifacts[0]?.sourcePath ?? "", /runtime\/extracted\/job-pdf\/preprocess\/file-pdf\/chinese-food-law\.txt$/);
  } finally {
    restoreEnv("PDFTOTEXT_BIN", previousPdftotext);
  }
});

test("collectPreprocessedTextArtifacts reports missing PDF text extractor", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "preprocessors-pdf-missing-tool-"));
  const originalPath = writeFile(root, "runtime/archive/originals/source.pdf", "%PDF-1.4\n");
  const previousPdftotext = process.env.PDFTOTEXT_BIN;

  try {
    process.env.PDFTOTEXT_BIN = path.join(root, "tools", "missing-pdftotext");
    const result = await collectPreprocessedTextArtifacts({
      job: jobFixture("job-pdf-missing-tool"),
      files: [
        fileFixture({
          id: "file-pdf",
          originalName: "source.pdf",
          mimeType: "application/pdf",
          archivePath: originalPath,
        }),
      ],
      sourceBundle: bundleFixture(root, "job-pdf-missing-tool"),
      artifactRoot: path.join(root, "runtime/extracted/job-pdf-missing-tool/preprocess"),
    });

    assert.equal(result.artifacts.length, 0);
    assert.deepEqual(result.skippedFiles, [{
      fileId: "file-pdf",
      fileName: "source.pdf",
      reason: "pdf_tool_missing",
    }]);
  } finally {
    restoreEnv("PDFTOTEXT_BIN", previousPdftotext);
  }
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
  assert.equal(isTextLikeJobFile(fileFixture({ originalName: "memo.docx" })), false);
  assert.equal(isDocxJobFile(fileFixture({ originalName: "memo.docx" })), true);
});

function writeFile(root: string, relativePath: string, content: string): string {
  const filePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
  return filePath;
}

function writeMinimalDocx(root: string, relativePath: string, textContent: string): string {
  const escaped = textContent
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  const documentXml = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">',
    "<w:body><w:p><w:r><w:t>",
    escaped,
    "</w:t></w:r></w:p></w:body></w:document>",
  ].join("");
  const filePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, buildZip({ "word/document.xml": documentXml }));
  return filePath;
}

function writeExecutable(root: string, name: string, content: string): string {
  const filePath = path.join(root, name);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, { encoding: "utf8", mode: 0o755 });
  return filePath;
}

function buildZip(entries: Record<string, string>): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let localOffset = 0;

  for (const [name, content] of Object.entries(entries)) {
    const nameBuffer = Buffer.from(name, "utf8");
    const contentBuffer = Buffer.from(content, "utf8");
    const compressed = zlib.deflateRawSync(contentBuffer);

    const localHeader = Buffer.alloc(30 + nameBuffer.length);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(8, 8);
    localHeader.writeUInt32LE(compressed.length, 18);
    localHeader.writeUInt32LE(contentBuffer.length, 22);
    localHeader.writeUInt16LE(nameBuffer.length, 26);
    nameBuffer.copy(localHeader, 30);
    localParts.push(localHeader, compressed);

    const centralHeader = Buffer.alloc(46 + nameBuffer.length);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(8, 10);
    centralHeader.writeUInt32LE(compressed.length, 20);
    centralHeader.writeUInt32LE(contentBuffer.length, 24);
    centralHeader.writeUInt16LE(nameBuffer.length, 28);
    centralHeader.writeUInt32LE(localOffset, 42);
    nameBuffer.copy(centralHeader, 46);
    centralParts.push(centralHeader);

    localOffset += localHeader.length + compressed.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const endOfCentralDirectory = Buffer.alloc(22);
  endOfCentralDirectory.writeUInt32LE(0x06054b50, 0);
  endOfCentralDirectory.writeUInt16LE(centralParts.length, 8);
  endOfCentralDirectory.writeUInt16LE(centralParts.length, 10);
  endOfCentralDirectory.writeUInt32LE(centralDirectory.length, 12);
  endOfCentralDirectory.writeUInt32LE(localOffset, 16);

  return Buffer.concat([...localParts, centralDirectory, endOfCentralDirectory]);
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

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
    return;
  }
  process.env[key] = value;
}
