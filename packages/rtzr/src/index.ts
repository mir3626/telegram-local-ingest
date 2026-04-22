import { spawn } from "node:child_process";
import { openAsBlob } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

export interface RtzrConfig {
  clientId: string;
  clientSecret: string;
  apiBaseUrl: string;
}

export interface RtzrAuthToken {
  accessToken: string;
  expireAt: number;
}

export interface RtzrTranscribeConfig {
  model_name?: "sommers" | "whisper";
  language?: "ko" | "ja" | "en" | "detect" | "multi" | string;
  language_candidates?: string[];
  use_diarization?: boolean;
  diarization?: { spk_count?: number };
  use_itn?: boolean;
  use_disfluency_filter?: boolean;
  use_profanity_filter?: boolean;
  use_paragraph_splitter?: boolean;
  paragraph_splitter?: { max?: number };
  domain?: "GENERAL" | "CALL" | string;
  use_word_timestamp?: boolean;
  keywords?: string[];
}

export interface RtzrSubmitResponse {
  id: string;
}

export type RtzrTranscriptionStatus = "transcribing" | "completed" | "failed";

export interface RtzrUtterance {
  start_at: number;
  duration: number;
  msg: string;
  spk?: number;
  lang?: string;
}

export interface RtzrTranscriptionResult {
  id: string;
  status: RtzrTranscriptionStatus;
  results?: {
    utterances?: RtzrUtterance[];
  };
  error?: {
    code?: string;
    message?: string;
  };
}

export interface RtzrTranscript {
  id: string;
  text: string;
  raw: RtzrTranscriptionResult;
}

export interface WaitForTranscriptionOptions {
  pollIntervalMs: number;
  timeoutMs: number;
  rateLimitBackoffMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface TranscriptArtifactPaths {
  rtzrJsonPath: string;
  transcriptMarkdownPath: string;
}

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type CommandRunner = (command: string, args: string[]) => Promise<CommandResult>;
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class RtzrApiError extends Error {
  readonly statusCode?: number;
  readonly code?: string;

  constructor(message: string, options: { statusCode?: number; code?: string } = {}) {
    super(message);
    this.name = "RtzrApiError";
    if (options.statusCode !== undefined) {
      this.statusCode = options.statusCode;
    }
    if (options.code !== undefined) {
      this.code = options.code;
    }
  }
}

export class RtzrTranscriptionFailedError extends Error {
  readonly result: RtzrTranscriptionResult;

  constructor(result: RtzrTranscriptionResult) {
    super(`RTZR transcription failed: ${result.error?.message ?? result.error?.code ?? result.id}`);
    this.name = "RtzrTranscriptionFailedError";
    this.result = result;
  }
}

export class RtzrOpenApiClient {
  private readonly config: RtzrConfig;
  private readonly fetchImpl: FetchLike;
  private token: RtzrAuthToken | null = null;

  constructor(config: RtzrConfig, fetchImpl: FetchLike = globalThis.fetch) {
    this.config = {
      ...config,
      apiBaseUrl: normalizeBaseUrl(config.apiBaseUrl),
    };
    this.fetchImpl = fetchImpl;
  }

  async authenticate(): Promise<RtzrAuthToken> {
    const body = new URLSearchParams({
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
    });
    const response = await this.fetchImpl(`${this.config.apiBaseUrl}/v1/authenticate`, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
      },
      body,
    });
    const payload = await readJson(response);
    if (!response.ok) {
      throw apiError("authenticate", response.status, payload);
    }
    const token = parseAuthToken(payload);
    this.token = token;
    return token;
  }

  async getAccessToken(nowSeconds = Math.floor(Date.now() / 1000)): Promise<string> {
    if (!this.token || this.token.expireAt <= nowSeconds + 30 * 60) {
      await this.authenticate();
    }
    if (!this.token) {
      throw new RtzrApiError("RTZR authentication did not return a token");
    }
    return this.token.accessToken;
  }

  async submitTranscription(filePath: string, config: RtzrTranscribeConfig = {}): Promise<RtzrSubmitResponse> {
    const form = new FormData();
    const blob = await openAsBlob(filePath);
    form.append("file", blob, path.basename(filePath));
    form.append("config", JSON.stringify(config));

    const response = await this.fetchImpl(`${this.config.apiBaseUrl}/v1/transcribe`, {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${await this.getAccessToken()}`,
      },
      body: form,
    });
    const payload = await readJson(response);
    if (!response.ok) {
      throw apiError("submitTranscription", response.status, payload);
    }
    return parseSubmitResponse(payload);
  }

  async getTranscription(transcribeId: string): Promise<RtzrTranscriptionResult> {
    const response = await this.fetchImpl(`${this.config.apiBaseUrl}/v1/transcribe/${encodeURIComponent(transcribeId)}`, {
      method: "GET",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${await this.getAccessToken()}`,
      },
    });
    const payload = await readJson(response);
    if (!response.ok) {
      throw apiError("getTranscription", response.status, payload);
    }
    return parseTranscriptionResult(payload);
  }

  async waitForTranscription(transcribeId: string, options: WaitForTranscriptionOptions): Promise<RtzrTranscriptionResult> {
    const sleep = options.sleep ?? defaultSleep;
    const now = options.now ?? Date.now;
    const deadline = now() + options.timeoutMs;
    while (true) {
      if (now() > deadline) {
        throw new RtzrApiError(`Timed out waiting for RTZR transcription: ${transcribeId}`);
      }
      try {
        const result = await this.getTranscription(transcribeId);
        if (result.status === "completed") {
          return result;
        }
        if (result.status === "failed") {
          throw new RtzrTranscriptionFailedError(result);
        }
      } catch (error) {
        if (!(error instanceof RtzrApiError) || error.statusCode !== 429) {
          throw error;
        }
        await sleep(options.rateLimitBackoffMs ?? options.pollIntervalMs);
        continue;
      }
      await sleep(options.pollIntervalMs);
    }
  }

  async transcribeFile(
    filePath: string,
    config: RtzrTranscribeConfig,
    waitOptions: WaitForTranscriptionOptions,
  ): Promise<RtzrTranscript> {
    const submitted = await this.submitTranscription(filePath, config);
    const result = await this.waitForTranscription(submitted.id, waitOptions);
    return {
      id: result.id,
      text: transcriptionText(result),
      raw: result,
    };
  }
}

export async function writeTranscriptArtifacts(
  transcript: RtzrTranscript,
  outputDir: string,
): Promise<TranscriptArtifactPaths> {
  await fs.mkdir(outputDir, { recursive: true });
  const rtzrJsonPath = path.join(outputDir, "rtzr.json");
  const transcriptMarkdownPath = path.join(outputDir, "transcript.md");
  await fs.writeFile(rtzrJsonPath, `${JSON.stringify(transcript.raw, null, 2)}\n`, "utf8");
  await fs.writeFile(transcriptMarkdownPath, renderTranscriptMarkdown(transcript), "utf8");
  return { rtzrJsonPath, transcriptMarkdownPath };
}

export async function checkFfmpeg(ffmpegPath: string, runner: CommandRunner = runCommand): Promise<CommandResult> {
  const result = await runner(ffmpegPath, ["-version"]);
  if (result.exitCode !== 0) {
    throw new Error(`ffmpeg check failed: ${result.stderr || result.stdout}`);
  }
  return result;
}

export interface EnsureSupportedAudioInput {
  inputPath: string;
  outputDir: string;
  ffmpegPath: string;
  runner?: CommandRunner;
}

export interface EnsureSupportedAudioResult {
  audioPath: string;
  converted: boolean;
}

export async function ensureRtzrSupportedAudio(input: EnsureSupportedAudioInput): Promise<EnsureSupportedAudioResult> {
  if (isRtzrSupportedAudioPath(input.inputPath)) {
    return { audioPath: input.inputPath, converted: false };
  }
  await fs.mkdir(input.outputDir, { recursive: true });
  const outputPath = path.join(input.outputDir, `${path.basename(input.inputPath, path.extname(input.inputPath))}.wav`);
  const runner = input.runner ?? runCommand;
  const result = await runner(input.ffmpegPath, [
    "-y",
    "-i",
    input.inputPath,
    "-ar",
    "16000",
    "-ac",
    "1",
    outputPath,
  ]);
  if (result.exitCode !== 0) {
    throw new Error(`ffmpeg conversion failed: ${result.stderr || result.stdout}`);
  }
  return { audioPath: outputPath, converted: true };
}

export function isRtzrSupportedAudioPath(filePath: string): boolean {
  return [".mp4", ".m4a", ".mp3", ".amr", ".flac", ".wav"].includes(path.extname(filePath).toLowerCase());
}

export function transcriptionText(result: RtzrTranscriptionResult): string {
  return (result.results?.utterances ?? []).map((utterance) => utterance.msg).join("\n");
}

export function renderTranscriptMarkdown(transcript: RtzrTranscript): string {
  const lines = [`# Transcript ${transcript.id}`, "", transcript.text, ""];
  const utterances = transcript.raw.results?.utterances ?? [];
  if (utterances.length > 0) {
    lines.push("## Utterances", "");
    for (const utterance of utterances) {
      const speaker = utterance.spk === undefined ? "" : ` Speaker ${utterance.spk}:`;
      lines.push(`- [${formatMilliseconds(utterance.start_at)}]${speaker} ${utterance.msg}`.trimEnd());
    }
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

function parseAuthToken(payload: unknown): RtzrAuthToken {
  if (!isRecord(payload) || typeof payload.access_token !== "string" || typeof payload.expire_at !== "number") {
    throw new RtzrApiError("Invalid RTZR auth response");
  }
  return {
    accessToken: payload.access_token,
    expireAt: payload.expire_at,
  };
}

function parseSubmitResponse(payload: unknown): RtzrSubmitResponse {
  if (!isRecord(payload) || typeof payload.id !== "string") {
    throw new RtzrApiError("Invalid RTZR submit response");
  }
  return { id: payload.id };
}

function parseTranscriptionResult(payload: unknown): RtzrTranscriptionResult {
  if (!isRecord(payload) || typeof payload.id !== "string" || !isTranscriptionStatus(payload.status)) {
    throw new RtzrApiError("Invalid RTZR transcription response");
  }
  return payload as unknown as RtzrTranscriptionResult;
}

function isTranscriptionStatus(value: unknown): value is RtzrTranscriptionStatus {
  return value === "transcribing" || value === "completed" || value === "failed";
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  return text ? JSON.parse(text) : {};
}

function apiError(method: string, statusCode: number, payload: unknown): RtzrApiError {
  const code = isRecord(payload) && typeof payload.code === "string" ? payload.code : undefined;
  const message = isRecord(payload) && typeof payload.msg === "string" ? payload.msg : `${method} failed`;
  return new RtzrApiError(`RTZR ${method} failed: ${message}`, {
    statusCode,
    ...(code ? { code } : {}),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeBaseUrl(value: string): string {
  const url = new URL(value);
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString().replace(/\/$/, "");
}

async function defaultSleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function formatMilliseconds(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const milliseconds = ms % 1000;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(milliseconds).padStart(3, "0")}`;
}

function runCommand(command: string, args: string[]): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (exitCode) => {
      resolve({ exitCode: exitCode ?? 1, stdout, stderr });
    });
  });
}
