import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify, TextDecoder } from "node:util";
import zlib from "node:zlib";

import type { StoredJob, StoredJobFile, StoredSourceBundle } from "@telegram-local-ingest/db";

export type PreprocessedArtifactKind =
  | "docx_text"
  | "eml_text"
  | "image_ocr_text"
  | "original_text"
  | "pdf_ocr_text"
  | "pdf_text"
  | "transcript_markdown";

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
const EML_MIME_TYPES = new Set(["application/eml", "message/rfc822"]);
const PDF_MIME_TYPE = "application/pdf";
const IMAGE_EXTENSIONS = new Set([".bmp", ".jpeg", ".jpg", ".png", ".pnm", ".tif", ".tiff", ".webp"]);
const IMAGE_MIME_TYPES = new Set([
  "image/bmp",
  "image/jpeg",
  "image/png",
  "image/tiff",
  "image/webp",
  "image/x-portable-anymap",
  "image/x-portable-bitmap",
  "image/x-portable-graymap",
  "image/x-portable-pixmap",
]);
const PDFTOTEXT_TIMEOUT_MS = 60 * 1000;
const PDFTOPPM_TIMEOUT_MS = 120 * 1000;
const TESSERACT_TIMEOUT_MS = 120 * 1000;
const DEFAULT_PDF_OCR_MAX_PAGES = 10;
const DEFAULT_PDF_OCR_DPI = 200;
const DEFAULT_OCR_LANGUAGES = "kor+eng+chi_sim+jpn";

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
      if (!preview.reason && preview.text.trim().length > 0) {
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

      const ocrPreview = await readPdfOcrTextPreview(sourcePath, maxBytes);
      if (ocrPreview.reason) {
        skippedFiles.push({
          fileId: file.id,
          fileName: file.originalName ?? file.id,
          reason: ocrPreview.reason,
        });
        continue;
      }
      if (ocrPreview.text.trim().length === 0) {
        skippedFiles.push({
          fileId: file.id,
          fileName: file.originalName ?? file.id,
          reason: "pdf_ocr_no_text",
        });
        continue;
      }
      const extractedPath = await writeExtractedTextArtifact(input.artifactRoot, file, sourcePath, ocrPreview.text);
      artifacts.push({
        id: `${file.id}:pdf_ocr_text`,
        kind: "pdf_ocr_text",
        fileId: file.id,
        fileName: `${file.originalName ?? path.basename(sourcePath)}.txt`,
        sourcePath: extractedPath,
        text: ocrPreview.text,
        charCount: ocrPreview.text.length,
        truncated: ocrPreview.truncated,
      });
      continue;
    }

    if (preprocessKind === "image") {
      const preview = await readImageOcrTextPreview(sourcePath, maxBytes);
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
          reason: "image_ocr_no_text",
        });
        continue;
      }
      const extractedPath = await writeExtractedTextArtifact(input.artifactRoot, file, sourcePath, preview.text);
      artifacts.push({
        id: `${file.id}:image_ocr_text`,
        kind: "image_ocr_text",
        fileId: file.id,
        fileName: `${file.originalName ?? path.basename(sourcePath)}.txt`,
        sourcePath: extractedPath,
        text: preview.text,
        charCount: preview.text.length,
        truncated: preview.truncated,
      });
      continue;
    }

    if (preprocessKind === "eml") {
      const preview = await readEmlTextPreview(sourcePath, maxBytes);
      if (preview.text.trim().length === 0) {
        skippedFiles.push({
          fileId: file.id,
          fileName: file.originalName ?? file.id,
          reason: "eml_no_text",
        });
        continue;
      }
      const extractedPath = await writeExtractedTextArtifact(input.artifactRoot, file, sourcePath, preview.text);
      artifacts.push({
        id: `${file.id}:eml_text`,
        kind: "eml_text",
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

function classifyJobFile(file: StoredJobFile): "docx" | "eml" | "image" | "pdf" | "text" | null {
  const mimeType = file.mimeType?.toLowerCase();
  const extension = path.extname(file.originalName ?? file.localPath ?? file.archivePath ?? "").toLowerCase();
  if (extension === ".eml" || (mimeType && EML_MIME_TYPES.has(mimeType))) {
    return "eml";
  }
  if (mimeType?.startsWith("text/") || (mimeType && TEXT_MIME_TYPES.has(mimeType))) {
    return "text";
  }
  if (TEXT_EXTENSIONS.has(extension)) {
    return "text";
  }
  if (mimeType === PDF_MIME_TYPE || extension === ".pdf") {
    return "pdf";
  }
  if (mimeType === DOCX_MIME_TYPE || extension === ".docx") {
    return "docx";
  }
  if ((mimeType && IMAGE_MIME_TYPES.has(mimeType)) || IMAGE_EXTENSIONS.has(extension)) {
    return "image";
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

async function readEmlTextPreview(filePath: string, maxBytes: number): Promise<{ text: string; truncated: boolean }> {
  const raw = await fs.readFile(filePath, "utf8");
  const parsed = parseMimeMessage(raw);
  const bodyText = extractMimeText(parsed.headers, parsed.body).trim();
  const headerLines = [
    ["Subject", getHeader(parsed.headers, "subject")],
    ["From", getHeader(parsed.headers, "from")],
    ["To", getHeader(parsed.headers, "to")],
    ["Cc", getHeader(parsed.headers, "cc")],
    ["Date", getHeader(parsed.headers, "date")],
  ].flatMap(([label, value]) => {
    const decoded = decodeMimeWords(value ?? "").trim();
    return decoded ? [`${label}: ${decoded}`] : [];
  });
  const text = [
    ...headerLines,
    ...(headerLines.length > 0 ? [""] : []),
    "Body:",
    "",
    bodyText,
  ].join("\n").trim();
  return truncateUtf8(text, maxBytes);
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

async function readPdfOcrTextPreview(
  filePath: string,
  maxBytes: number,
): Promise<{ text: string; truncated: boolean; reason?: string }> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "telegram-local-ingest-pdf-ocr-"));
  try {
    const pdfToPpmBin = process.env.PDFTOPPM_BIN?.trim() || "pdftoppm";
    const outputPrefix = path.join(tempDir, "page");
    try {
      await execFileAsync(pdfToPpmBin, [
        "-png",
        "-r",
        String(readPositiveIntegerEnv("PDF_OCR_DPI", DEFAULT_PDF_OCR_DPI)),
        "-f",
        "1",
        "-l",
        String(readPositiveIntegerEnv("PDF_OCR_MAX_PAGES", DEFAULT_PDF_OCR_MAX_PAGES)),
        filePath,
        outputPrefix,
      ], {
        timeout: PDFTOPPM_TIMEOUT_MS,
        maxBuffer: 512 * 1024,
      });
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return { text: "", truncated: false, reason: "pdf_ocr_tool_missing" };
      }
      return { text: "", truncated: false, reason: "pdf_ocr_failed" };
    }

    const pagePaths = (await fs.readdir(tempDir))
      .filter((entry) => /^page-\d+\.png$/i.test(entry))
      .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }))
      .map((entry) => path.join(tempDir, entry));
    if (pagePaths.length === 0) {
      return { text: "", truncated: false, reason: "pdf_ocr_failed" };
    }

    const pageTexts: string[] = [];
    for (const pagePath of pagePaths) {
      const pagePreview = await readImageOcrTextPreview(pagePath, maxBytes);
      if (pagePreview.reason) {
        return {
          text: "",
          truncated: false,
          reason: pagePreview.reason === "image_ocr_tool_missing" ? "pdf_ocr_tool_missing" : "pdf_ocr_failed",
        };
      }
      if (pagePreview.text.trim().length > 0) {
        pageTexts.push(pagePreview.text.trim());
      }
    }

    return truncateUtf8(pageTexts.join("\n\n"), maxBytes);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function readImageOcrTextPreview(
  filePath: string,
  maxBytes: number,
): Promise<{ text: string; truncated: boolean; reason?: string }> {
  const tesseractBin = process.env.TESSERACT_BIN?.trim() || "tesseract";
  try {
    const { stdout } = await execFileAsync(tesseractBin, [
      filePath,
      "stdout",
      "-l",
      process.env.OCR_LANGUAGES?.trim() || DEFAULT_OCR_LANGUAGES,
      "--psm",
      process.env.OCR_PSM?.trim() || "3",
    ], {
      timeout: TESSERACT_TIMEOUT_MS,
      maxBuffer: Math.max(4 * 1024 * 1024, maxBytes * 8),
    });
    return truncateUtf8(stdout.replace(/\u0000/g, ""), maxBytes);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return { text: "", truncated: false, reason: "image_ocr_tool_missing" };
    }
    return { text: "", truncated: false, reason: "image_ocr_failed" };
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

type MimeHeaders = Map<string, string>;

function parseMimeMessage(raw: string): { headers: MimeHeaders; body: string } {
  const separator = /\r?\n\r?\n/.exec(raw);
  if (!separator || separator.index === undefined) {
    return { headers: new Map(), body: raw };
  }
  return {
    headers: parseMimeHeaders(raw.slice(0, separator.index)),
    body: raw.slice(separator.index + separator[0].length),
  };
}

function parseMimeHeaders(headerBlock: string): MimeHeaders {
  const headers = new Map<string, string>();
  let current = "";
  const flush = () => {
    const colon = current.indexOf(":");
    if (colon <= 0) {
      current = "";
      return;
    }
    const key = current.slice(0, colon).trim().toLowerCase();
    const value = current.slice(colon + 1).trim();
    if (key && value) {
      headers.set(key, headers.has(key) ? `${headers.get(key)}, ${value}` : value);
    }
    current = "";
  };

  for (const line of headerBlock.split(/\r?\n/)) {
    if (/^[\t ]/.test(line) && current) {
      current += ` ${line.trim()}`;
      continue;
    }
    flush();
    current = line;
  }
  flush();
  return headers;
}

function getHeader(headers: MimeHeaders, name: string): string | undefined {
  return headers.get(name.toLowerCase());
}

function extractMimeText(headers: MimeHeaders, body: string): string {
  const contentType = parseHeaderWithParameters(getHeader(headers, "content-type") ?? "text/plain");
  const contentDisposition = (getHeader(headers, "content-disposition") ?? "").toLowerCase();
  if (contentDisposition.startsWith("attachment")) {
    return "";
  }

  if (contentType.value.startsWith("multipart/")) {
    const boundary = contentType.params.get("boundary");
    if (!boundary) {
      return "";
    }
    const partTexts = parseMultipartBody(body, boundary)
      .map((part) => ({ part, text: extractMimeText(part.headers, part.body) }))
      .filter((entry) => entry.text.trim().length > 0);
    if (contentType.value === "multipart/alternative") {
      return partTexts.find((entry) => contentTypeValue(entry.part.headers) === "text/plain")?.text
        ?? partTexts.find((entry) => contentTypeValue(entry.part.headers) === "text/html")?.text
        ?? partTexts[0]?.text
        ?? "";
    }
    return partTexts.map((entry) => entry.text).join("\n\n");
  }

  if (contentType.value === "text/plain") {
    return decodeMimeBody(body, getHeader(headers, "content-transfer-encoding"), contentType.params.get("charset"));
  }
  if (contentType.value === "text/html") {
    return htmlToText(decodeMimeBody(body, getHeader(headers, "content-transfer-encoding"), contentType.params.get("charset")));
  }
  if (contentType.value === "message/rfc822") {
    const nested = parseMimeMessage(body);
    return extractMimeText(nested.headers, nested.body);
  }
  return "";
}

function contentTypeValue(headers: MimeHeaders): string {
  return parseHeaderWithParameters(getHeader(headers, "content-type") ?? "text/plain").value;
}

function parseMultipartBody(body: string, boundary: string): Array<{ headers: MimeHeaders; body: string }> {
  const parts: Array<{ headers: MimeHeaders; body: string }> = [];
  for (const rawPart of body.split(`--${boundary}`).slice(1)) {
    if (rawPart.startsWith("--")) {
      break;
    }
    const trimmed = rawPart.replace(/^\r?\n/, "").replace(/\r?\n$/, "");
    if (!trimmed) {
      continue;
    }
    parts.push(parseMimeMessage(trimmed));
  }
  return parts;
}

function parseHeaderWithParameters(value: string): { value: string; params: Map<string, string> } {
  const [rawValue = "", ...rawParams] = value.split(";");
  const params = new Map<string, string>();
  for (const rawParam of rawParams) {
    const equals = rawParam.indexOf("=");
    if (equals <= 0) {
      continue;
    }
    const key = rawParam.slice(0, equals).trim().toLowerCase().replace(/\*$/, "");
    const paramValue = rawParam.slice(equals + 1).trim().replace(/^"|"$/g, "");
    if (key) {
      params.set(key, paramValue);
    }
  }
  return { value: rawValue.trim().toLowerCase() || "text/plain", params };
}

function decodeMimeBody(body: string, transferEncoding: string | undefined, charset: string | undefined): string {
  const encoding = transferEncoding?.trim().toLowerCase();
  if (encoding === "base64") {
    return decodeCharsetBuffer(Buffer.from(body.replace(/\s+/g, ""), "base64"), charset);
  }
  if (encoding === "quoted-printable") {
    return decodeCharsetBuffer(decodeQuotedPrintableToBuffer(body), charset);
  }
  return decodeCharsetBuffer(Buffer.from(body.replace(/\u0000/g, ""), "utf8"), charset);
}

function decodeMimeWords(value: string): string {
  return value.replace(/=\?([^?]+)\?([bq])\?([^?]*)\?=/gi, (_match, charset: string, encoding: string, encoded: string) => {
    if (encoding.toLowerCase() === "b") {
      return decodeCharsetBuffer(Buffer.from(encoded, "base64"), charset);
    }
    return decodeCharsetBuffer(decodeQuotedPrintableToBuffer(encoded.replace(/_/g, " ")), charset);
  });
}

function decodeQuotedPrintableToBuffer(value: string): Buffer {
  const bytes: number[] = [];
  const normalized = value.replace(/=\r?\n/g, "");
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index] ?? "";
    if (char === "=" && /^[0-9a-f]{2}$/i.test(normalized.slice(index + 1, index + 3))) {
      bytes.push(Number.parseInt(normalized.slice(index + 1, index + 3), 16));
      index += 2;
      continue;
    }
    bytes.push(...Buffer.from(char, "utf8"));
  }
  return Buffer.from(bytes);
}

function decodeCharsetBuffer(buffer: Buffer, charset: string | undefined): string {
  const label = (charset ?? "utf-8").trim().toLowerCase().replace(/^"|"$/g, "");
  try {
    return new TextDecoder(label || "utf-8").decode(buffer).replace(/\u0000/g, "");
  } catch {
    return buffer.toString("utf8").replace(/\u0000/g, "");
  }
}

function htmlToText(html: string): string {
  return decodeHtmlEntities(html
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n"))
    .trim();
}

function decodeHtmlEntities(value: string): string {
  const named: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: "\"",
  };
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, code: string) => {
    const normalized = code.toLowerCase();
    if (normalized.startsWith("#x")) {
      return String.fromCodePoint(Number.parseInt(normalized.slice(2), 16));
    }
    if (normalized.startsWith("#")) {
      return String.fromCodePoint(Number.parseInt(normalized.slice(1), 10));
    }
    return named[normalized] ?? entity;
  });
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

function readPositiveIntegerEnv(key: string, fallback: number): number {
  const raw = process.env[key]?.trim();
  if (!raw) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
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
