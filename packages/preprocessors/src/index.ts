import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import zlib from "node:zlib";

import type { StoredJob, StoredJobFile, StoredSourceBundle } from "@telegram-local-ingest/db";

export type PreprocessedArtifactKind = "docx_text" | "original_text" | "pdf_text" | "transcript_markdown";

export interface PreprocessJobInput {
  job: StoredJob;
  files: StoredJobFile[];
  sourceBundle: StoredSourceBundle;
  artifactRoot?: string;
  maxBytesPerArtifact?: number;
}

export interface PreprocessedTextArtifact {
  id: string;
  kind: PreprocessedArtifactKind;
  fileId?: string;
  fileName: string;
  sourcePath: string;
  text: string;
  charCount: number;
  truncated: boolean;
}

export interface SkippedPreprocessFile {
  fileId?: string;
  fileName: string;
  reason: string;
}

export interface PreprocessJobResult {
  jobId: string;
  artifacts: PreprocessedTextArtifact[];
  skippedFiles: SkippedPreprocessFile[];
}

const DEFAULT_MAX_BYTES_PER_ARTIFACT = 512 * 1024;
const execFileAsync = promisify(execFile);
const TEXT_EXTENSIONS = new Set([
  ".csv",
  ".json",
  ".log",
  ".md",
  ".srt",
  ".tsv",
  ".txt",
  ".vtt",
  ".xml",
  ".yaml",
  ".yml",
]);
const TEXT_MIME_TYPES = new Set([
  "application/json",
  "application/ld+json",
  "application/xml",
  "application/yaml",
  "text/csv",
  "text/markdown",
  "text/plain",
  "text/tab-separated-values",
  "text/vtt",
  "text/xml",
  "text/yaml",
]);
const DOCX_MIME_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const PDF_MIME_TYPE = "application/pdf";
const PDFTOTEXT_TIMEOUT_MS = 60 * 1000;

export async function collectPreprocessedTextArtifacts(input: PreprocessJobInput): Promise<PreprocessJobResult> {
  const maxBytes = input.maxBytesPerArtifact ?? DEFAULT_MAX_BYTES_PER_ARTIFACT;
  const artifacts: PreprocessedTextArtifact[] = [];
  const skippedFiles: SkippedPreprocessFile[] = [];

  for (const file of input.files) {
    const preprocessKind = classifyJobFile(file);
    if (!preprocessKind) {
      skippedFiles.push({
        fileId: file.id,
        fileName: file.originalName ?? file.id,
        reason: "unsupported_file_type",
      });
      continue;
    }

    const sourcePath = file.archivePath ?? file.localPath;
    if (!sourcePath) {
      skippedFiles.push({
        fileId: file.id,
        fileName: file.originalName ?? file.id,
        reason: "missing_imported_path",
      });
      continue;
    }

    if (preprocessKind === "text") {
      const preview = await readUtf8Preview(sourcePath, maxBytes);
      artifacts.push({
        id: `${file.id}:original_text`,
        kind: "original_text",
        fileId: file.id,
        fileName: file.originalName ?? path.basename(sourcePath),
        sourcePath,
        text: preview.text,
        charCount: preview.text.length,
        truncated: preview.truncated,
      });
      continue;
    }

    if (preprocessKind === "pdf") {
      const preview = await readPdfTextPreview(sourcePath, maxBytes);
      if (preview.reason) {
        skippedFiles.push({
          fileId: file.id,
          fileName: file.originalName ?? file.id,
          reason: preview.reason,
        });
        continue;
      }
      if (preview.text.trim().length === 0) {
        skippedFiles.push({
          fileId: file.id,
          fileName: file.originalName ?? file.id,
          reason: "pdf_no_text",
        });
        continue;
      }
      const extractedPath = await writeExtractedTextArtifact(input.artifactRoot, file, sourcePath, preview.text);
      artifacts.push({
        id: `${file.id}:pdf_text`,
        kind: "pdf_text",
        fileId: file.id,
        fileName: `${file.originalName ?? path.basename(sourcePath)}.txt`,
        sourcePath: extractedPath,
        text: preview.text,
        charCount: preview.text.length,
        truncated: preview.truncated,
      });
      continue;
    }

    const preview = await readDocxTextPreview(sourcePath, maxBytes);
    if (preview.text.trim().length === 0) {
      skippedFiles.push({
        fileId: file.id,
        fileName: file.originalName ?? file.id,
        reason: "docx_no_text",
      });
      continue;
    }
    const extractedPath = await writeExtractedTextArtifact(input.artifactRoot, file, sourcePath, preview.text);
    artifacts.push({
      id: `${file.id}:docx_text`,
      kind: "docx_text",
      fileId: file.id,
      fileName: `${file.originalName ?? path.basename(sourcePath)}.txt`,
      sourcePath: extractedPath,
      text: preview.text,
      charCount: preview.text.length,
      truncated: preview.truncated,
    });
  }

  const transcriptArtifacts = await collectTranscriptArtifacts(input.sourceBundle, maxBytes);
  artifacts.push(...transcriptArtifacts);

  return {
    jobId: input.job.id,
    artifacts,
    skippedFiles,
  };
}

export function isTextLikeJobFile(file: StoredJobFile): boolean {
  return classifyJobFile(file) === "text";
}

export function isDocxJobFile(file: StoredJobFile): boolean {
  return classifyJobFile(file) === "docx";
}

function classifyJobFile(file: StoredJobFile): "docx" | "pdf" | "text" | null {
  const mimeType = file.mimeType?.toLowerCase();
  if (mimeType?.startsWith("text/") || (mimeType && TEXT_MIME_TYPES.has(mimeType))) {
    return "text";
  }
  const extension = path.extname(file.originalName ?? file.localPath ?? file.archivePath ?? "").toLowerCase();
  if (TEXT_EXTENSIONS.has(extension)) {
    return "text";
  }
  if (mimeType === PDF_MIME_TYPE || extension === ".pdf") {
    return "pdf";
  }
  if (mimeType === DOCX_MIME_TYPE || extension === ".docx") {
    return "docx";
  }
  return null;
}

async function collectTranscriptArtifacts(
  sourceBundle: StoredSourceBundle,
  maxBytes: number,
): Promise<PreprocessedTextArtifact[]> {
  const extractedDir = path.join(sourceBundle.bundlePath, "extracted");
  let entries: string[];
  try {
    entries = await fs.readdir(extractedDir);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const artifacts: PreprocessedTextArtifact[] = [];
  for (const entry of entries.sort()) {
    if (!entry.toLowerCase().endsWith(".transcript.md")) {
      continue;
    }
    const sourcePath = path.join(extractedDir, entry);
    const preview = await readUtf8Preview(sourcePath, maxBytes);
    const text = stripTranscriptMarkdownBoilerplate(preview.text);
    artifacts.push({
      id: `${sourceBundle.id}:extracted:${entry}`,
      kind: "transcript_markdown",
      fileName: entry,
      sourcePath,
      text,
      charCount: text.length,
      truncated: preview.truncated,
    });
  }
  return artifacts;
}

async function readUtf8Preview(filePath: string, maxBytes: number): Promise<{ text: string; truncated: boolean }> {
  const fileHandle = await fs.open(filePath, "r");
  try {
    const stat = await fileHandle.stat();
    const byteLength = Math.min(stat.size, maxBytes);
    const buffer = Buffer.alloc(byteLength);
    await fileHandle.read(buffer, 0, byteLength, 0);
    return {
      text: buffer.toString("utf8").replace(/\u0000/g, ""),
      truncated: stat.size > maxBytes,
    };
  } finally {
    await fileHandle.close();
  }
}

async function readDocxTextPreview(filePath: string, maxBytes: number): Promise<{ text: string; truncated: boolean }> {
  const buffer = await fs.readFile(filePath);
  const documentXml = extractZipEntry(buffer, "word/document.xml");
  if (!documentXml) {
    throw new Error(`DOCX document XML not found: ${filePath}`);
  }
  return truncateUtf8(extractTextFromWordDocumentXml(documentXml.toString("utf8")), maxBytes);
}

async function readPdfTextPreview(
  filePath: string,
  maxBytes: number,
): Promise<{ text: string; truncated: boolean; reason?: string }> {
  const pdftotextBin = process.env.PDFTOTEXT_BIN?.trim() || "pdftotext";
  try {
    const { stdout } = await execFileAsync(pdftotextBin, ["-layout", "-nopgbrk", "-enc", "UTF-8", filePath, "-"], {
      timeout: PDFTOTEXT_TIMEOUT_MS,
      maxBuffer: Math.max(4 * 1024 * 1024, maxBytes * 8),
    });
    return truncateUtf8(stdout.replace(/\u0000/g, ""), maxBytes);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return { text: "", truncated: false, reason: "pdf_tool_missing" };
    }
    return { text: "", truncated: false, reason: "pdf_text_extraction_failed" };
  }
}

async function writeExtractedTextArtifact(
  artifactRoot: string | undefined,
  file: StoredJobFile,
  sourcePath: string,
  text: string,
): Promise<string> {
  const root = artifactRoot ?? path.join(path.dirname(sourcePath), ".preprocessed");
  const fileRoot = path.join(root, sanitizePathPart(file.id));
  await fs.mkdir(fileRoot, { recursive: true });
  const outputPath = path.join(fileRoot, `${artifactStem(file.originalName ?? path.basename(sourcePath))}.txt`);
  await fs.writeFile(outputPath, text, "utf8");
  return outputPath;
}

function extractZipEntry(zip: Buffer, entryName: string): Buffer | null {
  const eocdOffset = findEndOfCentralDirectory(zip);
  if (eocdOffset < 0) {
    throw new Error("Invalid ZIP: end of central directory not found");
  }

  const centralDirectorySize = zip.readUInt32LE(eocdOffset + 12);
  const centralDirectoryOffset = zip.readUInt32LE(eocdOffset + 16);
  let offset = centralDirectoryOffset;
  const end = centralDirectoryOffset + centralDirectorySize;
  while (offset < end) {
    if (zip.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error("Invalid ZIP: central directory header not found");
    }
    const compressionMethod = zip.readUInt16LE(offset + 10);
    const compressedSize = zip.readUInt32LE(offset + 20);
    const fileNameLength = zip.readUInt16LE(offset + 28);
    const extraFieldLength = zip.readUInt16LE(offset + 30);
    const fileCommentLength = zip.readUInt16LE(offset + 32);
    const localHeaderOffset = zip.readUInt32LE(offset + 42);
    const name = zip.subarray(offset + 46, offset + 46 + fileNameLength).toString("utf8").replaceAll("\\", "/");
    if (name === entryName) {
      return inflateZipEntry(zip, localHeaderOffset, compressedSize, compressionMethod);
    }
    offset += 46 + fileNameLength + extraFieldLength + fileCommentLength;
  }
  return null;
}

function findEndOfCentralDirectory(zip: Buffer): number {
  const minOffset = Math.max(0, zip.length - 65_557);
  for (let offset = zip.length - 22; offset >= minOffset; offset -= 1) {
    if (zip.readUInt32LE(offset) === 0x06054b50) {
      return offset;
    }
  }
  return -1;
}

function inflateZipEntry(zip: Buffer, localHeaderOffset: number, compressedSize: number, compressionMethod: number): Buffer {
  if (zip.readUInt32LE(localHeaderOffset) !== 0x04034b50) {
    throw new Error("Invalid ZIP: local file header not found");
  }
  const fileNameLength = zip.readUInt16LE(localHeaderOffset + 26);
  const extraFieldLength = zip.readUInt16LE(localHeaderOffset + 28);
  const dataOffset = localHeaderOffset + 30 + fileNameLength + extraFieldLength;
  const compressed = zip.subarray(dataOffset, dataOffset + compressedSize);
  if (compressionMethod === 0) {
    return compressed;
  }
  if (compressionMethod === 8) {
    return zlib.inflateRawSync(compressed);
  }
  throw new Error(`Unsupported ZIP compression method: ${compressionMethod}`);
}

function extractTextFromWordDocumentXml(xml: string): string {
  const paragraphs = xml.match(/<w:p\b[\s\S]*?<\/w:p>/g) ?? [xml];
  return paragraphs
    .map((paragraph) => {
      const normalized = paragraph
        .replace(/<w:tab\b[^>]*\/>/g, "\t")
        .replace(/<w:br\b[^>]*\/>/g, "\n");
      return [...normalized.matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g)]
        .map((match) => decodeXmlText(match[1] ?? ""))
        .join("");
    })
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join("\n");
}

function truncateUtf8(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const buffer = Buffer.from(text, "utf8");
  if (buffer.length <= maxBytes) {
    return { text, truncated: false };
  }
  return {
    text: buffer.subarray(0, maxBytes).toString("utf8").replace(/\uFFFD$/u, ""),
    truncated: true,
  };
}

function decodeXmlText(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|amp|apos|gt|lt|quot);/gi, (entity, value: string) => {
    switch (value.toLowerCase()) {
      case "amp":
        return "&";
      case "apos":
        return "'";
      case "gt":
        return ">";
      case "lt":
        return "<";
      case "quot":
        return "\"";
      default:
        if (value.startsWith("#x")) {
          return String.fromCodePoint(Number.parseInt(value.slice(2), 16));
        }
        if (value.startsWith("#")) {
          return String.fromCodePoint(Number.parseInt(value.slice(1), 10));
        }
        return entity;
    }
  });
}

function artifactStem(value: string): string {
  const extension = path.extname(value);
  const stem = extension ? value.slice(0, -extension.length) : value;
  return sanitizePathPart(stem || "document");
}

function sanitizePathPart(value: string): string {
  const sanitized = value.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  return sanitized.length > 0 ? sanitized : "artifact";
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function stripTranscriptMarkdownBoilerplate(text: string): string {
  return text
    .split(/\r?\n/)
    .flatMap((line) => {
      const trimmed = line.trim();
      if (
        /^#\s+Transcript\b/i.test(trimmed)
        || /^##\s+(Utterances|Segments)\b/i.test(trimmed)
      ) {
        return [];
      }
      const normalized = trimmed
        .replace(/^-\s+/, "")
        .replace(/^\[[^\]]+\]\s*/, "")
        .replace(/^Speaker\s+\d+:\s*/i, "")
        .replace(/\s+\([a-z]{2,}\)$/i, "")
        .trim();
      return normalized.length > 0 ? [normalized] : [];
    })
    .join("\n")
    .trim();
}
