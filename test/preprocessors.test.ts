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
        originalName: "archive.bin",
        mimeType: "application/octet-stream",
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
    fileName: "archive.bin",
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
  assert.match(result.artifacts[0]?.structurePath ?? "", /runtime\/extracted\/job-docx\/preprocess\/file-docx\/vendor-update\.blocks\.json$/);
  assert.match(fs.readFileSync(result.artifacts[0]?.sourcePath ?? "", "utf8"), /vendor update requires Korean translation/);
  const blocks = JSON.parse(fs.readFileSync(result.artifacts[0]?.structurePath ?? "", "utf8")) as {
    blocks: Array<{ id: string; text: string }>;
  };
  assert.deepEqual(blocks.blocks, [{
    id: "b0001",
    text: "This vendor update requires Korean translation & formatting.",
  }]);
});

test("collectPreprocessedTextArtifacts extracts EML message text into runtime artifacts", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "preprocessors-eml-"));
  const originalPath = writeFile(root, "runtime/archive/originals/vendor-update.eml", [
    "From: Vendor <vendor@example.com>",
    "To: Operator <operator@example.com>",
    "Subject: =?UTF-8?Q?Vendor_update?=",
    "Date: Fri, 24 Apr 2026 10:30:00 +0000",
    "MIME-Version: 1.0",
    "Content-Type: multipart/alternative; boundary=\"mail-boundary\"",
    "",
    "--mail-boundary",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: quoted-printable",
    "",
    "This vendor update requires Korean translation.=0AArticle 1. Scope.",
    "--mail-boundary",
    "Content-Type: text/html; charset=utf-8",
    "",
    "<p>This HTML alternative should not be preferred.</p>",
    "--mail-boundary--",
    "",
  ].join("\r\n"));
  const artifactRoot = path.join(root, "runtime/extracted/job-eml/preprocess");

  const result = await collectPreprocessedTextArtifacts({
    job: jobFixture("job-eml"),
    files: [
      fileFixture({
        id: "file-eml",
        originalName: "vendor-update.eml",
        mimeType: "message/rfc822",
        archivePath: originalPath,
      }),
    ],
    sourceBundle: bundleFixture(root, "job-eml"),
    artifactRoot,
  });

  assert.equal(result.jobId, "job-eml");
  assert.equal(result.skippedFiles.length, 0);
  assert.equal(result.artifacts.length, 1);
  assert.equal(result.artifacts[0]?.kind, "eml_text");
  assert.match(result.artifacts[0]?.text ?? "", /Subject: Vendor update/);
  assert.match(result.artifacts[0]?.text ?? "", /This vendor update requires Korean translation/);
  assert.doesNotMatch(result.artifacts[0]?.text ?? "", /HTML alternative/);
  assert.match(result.artifacts[0]?.sourcePath ?? "", /runtime\/extracted\/job-eml\/preprocess\/file-eml\/vendor-update\.txt$/);
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

test("collectPreprocessedTextArtifacts falls back to OCR for scanned PDF uploads", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "preprocessors-pdf-ocr-"));
  const originalPath = writeFile(root, "runtime/archive/originals/scanned.pdf", "%PDF-1.4\n");
  const toolRoot = path.join(root, "tools");
  const fakePdftotext = writeExecutable(toolRoot, "pdftotext", [
    "#!/bin/sh",
    "printf ''",
  ].join("\n"));
  const fakePdftoppm = writeExecutable(toolRoot, "pdftoppm", [
    "#!/bin/sh",
    "prefix=''",
    "for arg do prefix=\"$arg\"; done",
    "printf 'fake image' > \"${prefix}-1.png\"",
  ].join("\n"));
  const fakeTesseract = writeExecutable(toolRoot, "tesseract", [
    "#!/bin/sh",
    "printf 'OCR text from scanned PDF requiring Korean translation.\\n'",
  ].join("\n"));
  const previousPdftotext = process.env.PDFTOTEXT_BIN;
  const previousPdftoppm = process.env.PDFTOPPM_BIN;
  const previousTesseract = process.env.TESSERACT_BIN;

  try {
    process.env.PDFTOTEXT_BIN = fakePdftotext;
    process.env.PDFTOPPM_BIN = fakePdftoppm;
    process.env.TESSERACT_BIN = fakeTesseract;
    const result = await collectPreprocessedTextArtifacts({
      job: jobFixture("job-pdf-ocr"),
      files: [
        fileFixture({
          id: "file-pdf",
          originalName: "scanned.pdf",
          mimeType: "application/pdf",
          archivePath: originalPath,
        }),
      ],
      sourceBundle: bundleFixture(root, "job-pdf-ocr"),
      artifactRoot: path.join(root, "runtime/extracted/job-pdf-ocr/preprocess"),
    });

    assert.equal(result.skippedFiles.length, 0);
    assert.equal(result.artifacts.length, 1);
    assert.equal(result.artifacts[0]?.kind, "pdf_ocr_text");
    assert.match(result.artifacts[0]?.text ?? "", /OCR text from scanned PDF/);
  } finally {
    restoreEnv("PDFTOTEXT_BIN", previousPdftotext);
    restoreEnv("PDFTOPPM_BIN", previousPdftoppm);
    restoreEnv("TESSERACT_BIN", previousTesseract);
  }
});

test("collectPreprocessedTextArtifacts extracts image OCR text into runtime artifacts", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "preprocessors-image-ocr-"));
  const originalPath = writeFile(root, "runtime/archive/originals/photo.png", "not really png");
  const fakeTesseract = writeExecutable(path.join(root, "tools"), "tesseract", [
    "#!/bin/sh",
    "printf 'Image OCR text requiring Korean translation.\\n'",
  ].join("\n"));
  const previousTesseract = process.env.TESSERACT_BIN;

  try {
    process.env.TESSERACT_BIN = fakeTesseract;
    const result = await collectPreprocessedTextArtifacts({
      job: jobFixture("job-image-ocr"),
      files: [
        fileFixture({
          id: "file-image",
          originalName: "photo.png",
          mimeType: "image/png",
          archivePath: originalPath,
        }),
      ],
      sourceBundle: bundleFixture(root, "job-image-ocr"),
      artifactRoot: path.join(root, "runtime/extracted/job-image-ocr/preprocess"),
    });

    assert.equal(result.skippedFiles.length, 0);
    assert.equal(result.artifacts.length, 1);
    assert.equal(result.artifacts[0]?.kind, "image_ocr_text");
    assert.match(result.artifacts[0]?.text ?? "", /Image OCR text/);
    assert.match(result.artifacts[0]?.sourcePath ?? "", /runtime\/extracted\/job-image-ocr\/preprocess\/file-image\/photo\.txt$/);
  } finally {
    restoreEnv("TESSERACT_BIN", previousTesseract);
  }
});

test("collectPreprocessedTextArtifacts reports missing PDF OCR tools when text layer is unavailable", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "preprocessors-pdf-missing-tool-"));
  const originalPath = writeFile(root, "runtime/archive/originals/source.pdf", "%PDF-1.4\n");
  const previousPdftotext = process.env.PDFTOTEXT_BIN;
  const previousPdftoppm = process.env.PDFTOPPM_BIN;

  try {
    process.env.PDFTOTEXT_BIN = path.join(root, "tools", "missing-pdftotext");
    process.env.PDFTOPPM_BIN = path.join(root, "tools", "missing-pdftoppm");
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
      reason: "pdf_ocr_tool_missing",
    }]);
  } finally {
    restoreEnv("PDFTOTEXT_BIN", previousPdftotext);
    restoreEnv("PDFTOPPM_BIN", previousPdftoppm);
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
  assert.equal(isTextLikeJobFile(fileFixture({ originalName: "mail.eml", mimeType: "message/rfc822" })), false);
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
