import fs from "node:fs";
import path from "node:path";

export type JobStatus =
  | "RECEIVED"
  | "QUEUED"
  | "IMPORTING"
  | "NORMALIZING"
  | "BUNDLE_WRITING"
  | "INGESTING"
  | "NOTIFYING"
  | "COMPLETED"
  | "FAILED"
  | "RETRY_REQUESTED"
  | "CANCELLED";

export type IngestSource = "telegram-local-bot-api" | "local";

export interface IngestJob {
  id: string;
  source: IngestSource;
  status: JobStatus;
  createdAt: string;
  updatedAt: string;
}

export interface RuntimeConfig {
  runtimeDir: string;
  sqliteDbPath: string;
  wikiWriteLockPath: string;
  maxFileSizeBytes: number;
}

export interface TelegramConfig {
  botToken: string;
  apiId?: string;
  apiHash?: string;
  botApiBaseUrl: string;
  localFilesRoot?: string;
  allowedUserIds: string[];
  pollTimeoutSeconds: number;
}

export interface VaultConfig {
  obsidianVaultPath: string;
  rawRoot: string;
}

export interface RtzrConfig {
  clientId?: string;
  clientSecret?: string;
  apiBaseUrl: string;
  ffmpegPath: string;
  pollIntervalMs: number;
  timeoutMs: number;
  rateLimitBackoffMs: number;
}

export type SttProvider = "rtzr" | "sensevoice" | "none";

export interface SttConfig {
  provider: SttProvider;
}

export interface SenseVoiceConfig {
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

export interface WikiAdapterConfig {
  ingestCommand?: string;
}

export interface TranslationConfig {
  defaultRelation: string;
}

export interface AppConfig {
  telegram: TelegramConfig;
  runtime: RuntimeConfig;
  vault: VaultConfig;
  stt: SttConfig;
  rtzr: RtzrConfig;
  sensevoice: SenseVoiceConfig;
  wiki: WikiAdapterConfig;
  translation: TranslationConfig;
}

export class ConfigError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`Invalid configuration: ${issues.join("; ")}`);
    this.name = "ConfigError";
    this.issues = issues;
  }
}

export function loadNearestEnvFile(startDir = process.cwd(), env: NodeJS.ProcessEnv = process.env): string | null {
  let current = path.resolve(startDir);
  while (true) {
    const candidate = path.join(current, ".env");
    if (fs.existsSync(candidate)) {
      loadEnvFile(candidate, env);
      return candidate;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

export function loadEnvFile(filePath: string, env: NodeJS.ProcessEnv = process.env): void {
  const content = fs.readFileSync(filePath, "utf8");
  for (const line of content.split(/\r?\n/)) {
    const parsed = parseEnvLine(line);
    if (!parsed || env[parsed.key] !== undefined) {
      continue;
    }
    env[parsed.key] = parsed.value;
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const issues: string[] = [];
  const required = (key: string): string => {
    const value = readNonEmpty(env[key]);
    if (!value) {
      issues.push(`${key} is required`);
      return "";
    }
    return value;
  };

  const optional = (key: string): string | undefined => readNonEmpty(env[key]);

  const botApiBaseUrl = readNonEmpty(env.TELEGRAM_BOT_API_BASE_URL) ?? "http://127.0.0.1:8081";
  const pollTimeoutSeconds = parseInteger(
    env.TELEGRAM_POLL_TIMEOUT_SECONDS,
    50,
    "TELEGRAM_POLL_TIMEOUT_SECONDS",
    issues,
  );
  const maxFileSizeBytes = parseInteger(
    env.INGEST_MAX_FILE_SIZE_BYTES,
    2 * 1024 * 1024 * 1024,
    "INGEST_MAX_FILE_SIZE_BYTES",
    issues,
  );
  const rtzrPollIntervalMs = parseInteger(env.RTZR_POLL_INTERVAL_MS, 5000, "RTZR_POLL_INTERVAL_MS", issues);
  const rtzrTimeoutMs = parseInteger(env.RTZR_TIMEOUT_MS, 30 * 60 * 1000, "RTZR_TIMEOUT_MS", issues);
  const rtzrRateLimitBackoffMs = parseInteger(env.RTZR_RATE_LIMIT_BACKOFF_MS, 30_000, "RTZR_RATE_LIMIT_BACKOFF_MS", issues);
  const senseVoiceBatchSizeSeconds = parseInteger(env.SENSEVOICE_BATCH_SIZE_SECONDS, 60, "SENSEVOICE_BATCH_SIZE_SECONDS", issues);
  const senseVoiceMergeLengthSeconds = parseInteger(env.SENSEVOICE_MERGE_LENGTH_SECONDS, 15, "SENSEVOICE_MERGE_LENGTH_SECONDS", issues);
  const senseVoiceMaxSingleSegmentTimeMs = parseInteger(
    env.SENSEVOICE_MAX_SINGLE_SEGMENT_TIME_MS,
    30_000,
    "SENSEVOICE_MAX_SINGLE_SEGMENT_TIME_MS",
    issues,
  );
  const senseVoiceTimeoutMs = parseInteger(env.SENSEVOICE_TIMEOUT_MS, 60 * 60 * 1000, "SENSEVOICE_TIMEOUT_MS", issues);
  const senseVoiceTorchNumThreads = parseOptionalInteger(env.SENSEVOICE_TORCH_NUM_THREADS, "SENSEVOICE_TORCH_NUM_THREADS", issues);

  const config: AppConfig = {
    telegram: {
      botToken: required("TELEGRAM_BOT_TOKEN"),
      botApiBaseUrl: normalizeBaseUrl(botApiBaseUrl, "TELEGRAM_BOT_API_BASE_URL", issues),
      allowedUserIds: parseCsv(env.TELEGRAM_ALLOWED_USER_IDS),
      pollTimeoutSeconds,
    },
    runtime: {
      runtimeDir: readNonEmpty(env.INGEST_RUNTIME_DIR) ?? "./runtime",
      sqliteDbPath: readNonEmpty(env.SQLITE_DB_PATH) ?? "./runtime/ingest.db",
      wikiWriteLockPath: readNonEmpty(env.WIKI_WRITE_LOCK_PATH) ?? "./runtime/wiki.lock",
      maxFileSizeBytes,
    },
    vault: {
      obsidianVaultPath: required("OBSIDIAN_VAULT_PATH"),
      rawRoot: readNonEmpty(env.OBSIDIAN_RAW_ROOT) ?? "raw",
    },
    stt: {
      provider: parseSttProvider(env.STT_PROVIDER, issues),
    },
    rtzr: {
      apiBaseUrl: normalizeBaseUrl(readNonEmpty(env.RTZR_API_BASE_URL) ?? "https://openapi.vito.ai", "RTZR_API_BASE_URL", issues),
      ffmpegPath: readNonEmpty(env.FFMPEG_PATH) ?? "ffmpeg",
      pollIntervalMs: rtzrPollIntervalMs,
      timeoutMs: rtzrTimeoutMs,
      rateLimitBackoffMs: rtzrRateLimitBackoffMs,
    },
    sensevoice: {
      pythonPath: readNonEmpty(env.SENSEVOICE_PYTHON) ?? "python3",
      scriptPath: readNonEmpty(env.SENSEVOICE_SCRIPT_PATH) ?? "./scripts/sensevoice-transcribe.py",
      model: readNonEmpty(env.SENSEVOICE_MODEL) ?? "iic/SenseVoiceSmall",
      device: readNonEmpty(env.SENSEVOICE_DEVICE) ?? "cpu",
      language: readNonEmpty(env.SENSEVOICE_LANGUAGE) ?? "auto",
      useItn: parseBoolean(env.SENSEVOICE_USE_ITN, true, "SENSEVOICE_USE_ITN", issues),
      batchSizeSeconds: senseVoiceBatchSizeSeconds,
      mergeVad: parseBoolean(env.SENSEVOICE_MERGE_VAD, true, "SENSEVOICE_MERGE_VAD", issues),
      mergeLengthSeconds: senseVoiceMergeLengthSeconds,
      maxSingleSegmentTimeMs: senseVoiceMaxSingleSegmentTimeMs,
      timeoutMs: senseVoiceTimeoutMs,
    },
    wiki: {},
    translation: {
      defaultRelation: readNonEmpty(env.TRANSLATION_DEFAULT_RELATION) ?? "business",
    },
  };

  assignOptional(config.telegram, "apiId", optional("TELEGRAM_API_ID"));
  assignOptional(config.telegram, "apiHash", optional("TELEGRAM_API_HASH"));
  assignOptional(config.telegram, "localFilesRoot", optional("TELEGRAM_LOCAL_FILES_ROOT"));
  assignOptional(config.rtzr, "clientId", optional("RTZR_CLIENT_ID"));
  assignOptional(config.rtzr, "clientSecret", optional("RTZR_CLIENT_SECRET"));
  assignOptional(config.sensevoice, "vadModel", optional("SENSEVOICE_VAD_MODEL") ?? "fsmn-vad");
  if (senseVoiceTorchNumThreads !== undefined) {
    config.sensevoice.torchNumThreads = senseVoiceTorchNumThreads;
  }
  assignOptional(config.wiki, "ingestCommand", optional("WIKI_INGEST_COMMAND"));

  if (pollTimeoutSeconds < 1 || pollTimeoutSeconds > 100) {
    issues.push("TELEGRAM_POLL_TIMEOUT_SECONDS must be between 1 and 100");
  }
  if (maxFileSizeBytes < 1) {
    issues.push("INGEST_MAX_FILE_SIZE_BYTES must be at least 1");
  }
  if (rtzrPollIntervalMs < 1) {
    issues.push("RTZR_POLL_INTERVAL_MS must be at least 1");
  }
  if (rtzrTimeoutMs < 1) {
    issues.push("RTZR_TIMEOUT_MS must be at least 1");
  }
  if (rtzrRateLimitBackoffMs < 1) {
    issues.push("RTZR_RATE_LIMIT_BACKOFF_MS must be at least 1");
  }
  if (senseVoiceBatchSizeSeconds < 1) {
    issues.push("SENSEVOICE_BATCH_SIZE_SECONDS must be at least 1");
  }
  if (senseVoiceMergeLengthSeconds < 1) {
    issues.push("SENSEVOICE_MERGE_LENGTH_SECONDS must be at least 1");
  }
  if (senseVoiceMaxSingleSegmentTimeMs < 1) {
    issues.push("SENSEVOICE_MAX_SINGLE_SEGMENT_TIME_MS must be at least 1");
  }
  if (senseVoiceTimeoutMs < 1) {
    issues.push("SENSEVOICE_TIMEOUT_MS must be at least 1");
  }
  if (senseVoiceTorchNumThreads !== undefined && senseVoiceTorchNumThreads < 1) {
    issues.push("SENSEVOICE_TORCH_NUM_THREADS must be at least 1");
  }

  if (issues.length > 0) {
    throw new ConfigError(issues);
  }

  return config;
}

function parseEnvLine(line: string): { key: string; value: string } | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) {
    return null;
  }
  const equals = trimmed.indexOf("=");
  if (equals <= 0) {
    return null;
  }
  const key = trimmed.slice(0, equals).trim();
  let value = trimmed.slice(equals + 1).trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }
  return { key, value };
}

function readNonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function parseCsv(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function parseInteger(
  value: string | undefined,
  fallback: number,
  key: string,
  issues: string[],
): number {
  const raw = readNonEmpty(value);
  if (!raw) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || String(parsed) !== raw) {
    issues.push(`${key} must be an integer`);
    return fallback;
  }
  return parsed;
}

function parseOptionalInteger(value: string | undefined, key: string, issues: string[]): number | undefined {
  const raw = readNonEmpty(value);
  if (!raw) {
    return undefined;
  }
  return parseInteger(raw, 0, key, issues);
}

function parseBoolean(value: string | undefined, fallback: boolean, key: string, issues: string[]): boolean {
  const raw = readNonEmpty(value);
  if (!raw) {
    return fallback;
  }
  const normalized = raw.toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "n", "off"].includes(normalized)) {
    return false;
  }
  issues.push(`${key} must be a boolean`);
  return fallback;
}

function parseSttProvider(value: string | undefined, issues: string[]): SttProvider {
  const raw = readNonEmpty(value) ?? "rtzr";
  if (raw === "rtzr" || raw === "sensevoice" || raw === "none") {
    return raw;
  }
  issues.push("STT_PROVIDER must be one of: rtzr, sensevoice, none");
  return "rtzr";
}

function normalizeBaseUrl(value: string, key: string, issues: string[]): string {
  try {
    const url = new URL(value);
    url.pathname = url.pathname.replace(/\/+$/, "");
    return url.toString().replace(/\/$/, "");
  } catch {
    issues.push(`${key} must be a valid URL`);
    return value;
  }
}

function assignOptional<T extends object, K extends keyof T>(target: T, key: K, value: T[K] | undefined): void {
  if (value !== undefined) {
    target[key] = value;
  }
}
