import fs from "node:fs/promises";
import path from "node:path";

import type { StoredJob, StoredJobFile, StoredSourceBundle } from "@telegram-local-ingest/db";

export type PreprocessedArtifactKind = "original_text" | "transcript_markdown";

export interface PreprocessJobInput {
  job: StoredJob;
  files: StoredJobFile[];
  sourceBundle: StoredSourceBundle;
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

export async function collectPreprocessedTextArtifacts(input: PreprocessJobInput): Promise<PreprocessJobResult> {
  const maxBytes = input.maxBytesPerArtifact ?? DEFAULT_MAX_BYTES_PER_ARTIFACT;
  const artifacts: PreprocessedTextArtifact[] = [];
  const skippedFiles: SkippedPreprocessFile[] = [];

  for (const file of input.files) {
    if (!isTextLikeJobFile(file)) {
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
  const mimeType = file.mimeType?.toLowerCase();
  if (mimeType?.startsWith("text/") || (mimeType && TEXT_MIME_TYPES.has(mimeType))) {
    return true;
  }
  const extension = path.extname(file.originalName ?? file.localPath ?? file.archivePath ?? "").toLowerCase();
  return TEXT_EXTENSIONS.has(extension);
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
