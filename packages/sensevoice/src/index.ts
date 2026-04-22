import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface SenseVoiceTranscribeOptions {
  pythonPath: string;
  scriptPath: string;
  model: string;
  device: string;
  language: string;
  useItn: boolean;
  batchSizeSeconds: number;
  mergeVad: boolean;
  mergeLengthSeconds: number;
  maxSingleSegmentTimeMs: number;
  timeoutMs: number;
  vadModel?: string;
  torchNumThreads?: number;
}

export interface SenseVoiceSegment {
  text: string;
  language?: string;
  start?: number;
  end?: number;
  emotion?: string;
  event?: string;
}

export interface SenseVoiceTranscript {
  id: string;
  text: string;
  segments: SenseVoiceSegment[];
  raw: unknown;
}

export interface SenseVoiceArtifactPaths {
  senseVoiceJsonPath: string;
  transcriptMarkdownPath: string;
}

export interface SenseVoiceProgressEvent {
  stage: string;
  message: string;
  percent?: number;
}

export type SenseVoiceProgressHandler = (event: SenseVoiceProgressEvent) => void;

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export type CommandRunner = (
  command: string,
  args: string[],
  options: {
    timeoutMs: number;
    env?: NodeJS.ProcessEnv;
    onStdout?: (chunk: string) => void;
    onStderr?: (chunk: string) => void;
  },
) => Promise<CommandResult>;

export class SenseVoiceError extends Error {
  readonly stderr?: string;
  readonly stdout?: string;

  constructor(message: string, details: { stderr?: string; stdout?: string } = {}) {
    super(message);
    this.name = "SenseVoiceError";
    if (details.stderr !== undefined) {
      this.stderr = details.stderr;
    }
    if (details.stdout !== undefined) {
      this.stdout = details.stdout;
    }
  }
}

export class LocalSenseVoiceClient {
  private readonly runner: CommandRunner;

  constructor(runner: CommandRunner = runCommand) {
    this.runner = runner;
  }

  async transcribeFile(
    filePath: string,
    options: SenseVoiceTranscribeOptions,
    onProgress?: SenseVoiceProgressHandler,
  ): Promise<SenseVoiceTranscript> {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "telegram-local-ingest-sensevoice-"));
    const outputPath = path.join(outputDir, "result.json");
    const args = [
      options.scriptPath,
      "--input",
      filePath,
      "--output",
      outputPath,
      "--model",
      options.model,
      "--device",
      options.device,
      "--language",
      options.language,
      "--use-itn",
      String(options.useItn),
      "--batch-size-s",
      String(options.batchSizeSeconds),
      "--merge-vad",
      String(options.mergeVad),
      "--merge-length-s",
      String(options.mergeLengthSeconds),
      "--max-single-segment-time-ms",
      String(options.maxSingleSegmentTimeMs),
    ];
    if (options.vadModel) {
      args.push("--vad-model", options.vadModel);
    }

    const env: NodeJS.ProcessEnv = {};
    if (options.torchNumThreads !== undefined) {
      env.OMP_NUM_THREADS = String(options.torchNumThreads);
      env.MKL_NUM_THREADS = String(options.torchNumThreads);
      env.TORCH_NUM_THREADS = String(options.torchNumThreads);
    }

    try {
      onProgress?.({ stage: "START", percent: 1, message: `Starting SenseVoice for ${path.basename(filePath)}` });
      const result = await this.runner(options.pythonPath, args, {
        timeoutMs: options.timeoutMs,
        env,
        onStderr: createProgressLineReader(onProgress),
      });
      if (result.timedOut) {
        throw new SenseVoiceError(`SenseVoice timed out after ${options.timeoutMs}ms`, result);
      }
      if (result.exitCode !== 0) {
        throw new SenseVoiceError(`SenseVoice failed with exit code ${result.exitCode}: ${result.stderr || result.stdout}`, result);
      }
      const payload = JSON.parse(await fs.readFile(outputPath, "utf8")) as unknown;
      onProgress?.({ stage: "DONE", percent: 100, message: "SenseVoice transcript JSON parsed" });
      return parseSenseVoiceTranscript(payload);
    } finally {
      await fs.rm(outputDir, { recursive: true, force: true });
    }
  }
}

export async function writeSenseVoiceTranscriptArtifacts(
  transcript: SenseVoiceTranscript,
  outputDir: string,
): Promise<SenseVoiceArtifactPaths> {
  await fs.mkdir(outputDir, { recursive: true });
  const senseVoiceJsonPath = path.join(outputDir, "sensevoice.json");
  const transcriptMarkdownPath = path.join(outputDir, "transcript.md");
  await fs.writeFile(senseVoiceJsonPath, `${JSON.stringify(transcript.raw, null, 2)}\n`, "utf8");
  await fs.writeFile(transcriptMarkdownPath, renderSenseVoiceTranscriptMarkdown(transcript), "utf8");
  return { senseVoiceJsonPath, transcriptMarkdownPath };
}

export function renderSenseVoiceTranscriptMarkdown(transcript: SenseVoiceTranscript): string {
  const lines = [`# Transcript ${transcript.id}`, "", transcript.text, ""];
  if (transcript.segments.length > 0) {
    lines.push("## Segments", "");
    for (const segment of transcript.segments) {
      const time = typeof segment.start === "number" ? `[${formatMilliseconds(segment.start)}] ` : "";
      const language = segment.language ? ` (${segment.language})` : "";
      lines.push(`- ${time}${segment.text}${language}`.trimEnd());
    }
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

function parseSenseVoiceTranscript(payload: unknown): SenseVoiceTranscript {
  if (!isRecord(payload) || typeof payload.id !== "string" || typeof payload.text !== "string") {
    throw new SenseVoiceError("Invalid SenseVoice transcript JSON");
  }
  const segments = Array.isArray(payload.segments)
    ? payload.segments.flatMap((segment) => parseSegment(segment))
    : [];
  return {
    id: payload.id,
    text: payload.text,
    segments,
    raw: payload,
  };
}

function parseSegment(segment: unknown): SenseVoiceSegment[] {
  if (!isRecord(segment) || typeof segment.text !== "string") {
    return [];
  }
  const parsed: SenseVoiceSegment = {
    text: segment.text,
  };
  if (typeof segment.language === "string") {
    parsed.language = segment.language;
  }
  if (typeof segment.start === "number") {
    parsed.start = segment.start;
  }
  if (typeof segment.end === "number") {
    parsed.end = segment.end;
  }
  if (typeof segment.emotion === "string") {
    parsed.emotion = segment.emotion;
  }
  if (typeof segment.event === "string") {
    parsed.event = segment.event;
  }
  return [parsed];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatMilliseconds(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const milliseconds = Math.floor(ms % 1000);
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(milliseconds).padStart(3, "0")}`;
}

function runCommand(
  command: string,
  args: string[],
  options: {
    timeoutMs: number;
    env?: NodeJS.ProcessEnv;
    onStdout?: (chunk: string) => void;
    onStderr?: (chunk: string) => void;
  },
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      windowsHide: true,
      env: {
        ...process.env,
        ...(options.env ?? {}),
      },
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeout = setTimeout(() => {
      settled = true;
      child.kill("SIGTERM");
      resolve({ exitCode: 1, stdout, stderr, timedOut: true });
    }, options.timeoutMs);
    child.stdout.on("data", (chunk) => {
      const text = String(chunk);
      stdout += text;
      options.onStdout?.(text);
    });
    child.stderr.on("data", (chunk) => {
      const text = String(chunk);
      stderr += text;
      options.onStderr?.(text);
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    child.on("close", (exitCode) => {
      clearTimeout(timeout);
      if (!settled) {
        settled = true;
        resolve({ exitCode: exitCode ?? 1, stdout, stderr, timedOut: false });
      }
    });
  });
}

function createProgressLineReader(onProgress: SenseVoiceProgressHandler | undefined): (chunk: string) => void {
  let pending = "";
  return (chunk: string) => {
    pending += chunk;
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() ?? "";
    for (const line of lines) {
      const event = parseProgressLine(line);
      if (event) {
        onProgress?.(event);
      }
    }
  };
}

function parseProgressLine(line: string): SenseVoiceProgressEvent | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) {
    return null;
  }
  let payload: unknown;
  try {
    payload = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (
    !isRecord(payload)
    || payload.type !== "sensevoice_progress"
    || typeof payload.stage !== "string"
    || typeof payload.message !== "string"
  ) {
    return null;
  }
  const event: SenseVoiceProgressEvent = {
    stage: payload.stage,
    message: payload.message,
  };
  if (typeof payload.percent === "number") {
    event.percent = payload.percent;
  }
  return event;
}
