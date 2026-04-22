import fs from "node:fs";
import path from "node:path";

export type JobStatus =
  | "RECEIVED"
  | "QUEUED"
  | "IMPORTING"
  | "NORMALIZING"
  | "INGESTING"
  | "COMPLETED"
  | "FAILED"
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
}

export interface WikiAdapterConfig {
  ingestCommand?: string;
}

export interface AppConfig {
  telegram: TelegramConfig;
  runtime: RuntimeConfig;
  vault: VaultConfig;
  rtzr: RtzrConfig;
  wiki: WikiAdapterConfig;
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
    },
    vault: {
      obsidianVaultPath: required("OBSIDIAN_VAULT_PATH"),
      rawRoot: readNonEmpty(env.OBSIDIAN_RAW_ROOT) ?? "raw",
    },
    rtzr: {
      apiBaseUrl: normalizeBaseUrl(readNonEmpty(env.RTZR_API_BASE_URL) ?? "https://openapi.vito.ai", "RTZR_API_BASE_URL", issues),
      ffmpegPath: readNonEmpty(env.FFMPEG_PATH) ?? "ffmpeg",
    },
    wiki: {},
  };

  assignOptional(config.telegram, "apiId", optional("TELEGRAM_API_ID"));
  assignOptional(config.telegram, "apiHash", optional("TELEGRAM_API_HASH"));
  assignOptional(config.telegram, "localFilesRoot", optional("TELEGRAM_LOCAL_FILES_ROOT"));
  assignOptional(config.rtzr, "clientId", optional("RTZR_CLIENT_ID"));
  assignOptional(config.rtzr, "clientSecret", optional("RTZR_CLIENT_SECRET"));
  assignOptional(config.wiki, "ingestCommand", optional("WIKI_INGEST_COMMAND"));

  if (pollTimeoutSeconds < 1 || pollTimeoutSeconds > 100) {
    issues.push("TELEGRAM_POLL_TIMEOUT_SECONDS must be between 1 and 100");
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
