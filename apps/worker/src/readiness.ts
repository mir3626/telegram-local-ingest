import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  type AppConfig,
  ConfigError,
  loadConfig,
  loadNearestEnvFile,
} from "@telegram-local-ingest/core";
import {
  checkTelegramLocalBotApi,
  TelegramBotApiClient,
  type FetchLike,
} from "@telegram-local-ingest/telegram";

export type ReadinessStatus = "ok" | "warn" | "fail";

export interface ReadinessCheck {
  status: ReadinessStatus;
  name: string;
  message: string;
}

export interface ReadinessReport {
  ready: boolean;
  envPath: string | null;
  checks: ReadinessCheck[];
}

export interface ReadinessOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: FetchLike;
  checkTelegram?: boolean;
}

export async function checkLiveSmokeReadiness(options: ReadinessOptions = {}): Promise<ReadinessReport> {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const env = { ...(options.env ?? process.env) };
  const checks: ReadinessCheck[] = [];
  const envPath = loadNearestEnvFile(cwd, env);

  if (envPath) {
    checks.push(ok(".env", `loaded ${path.relative(cwd, envPath) || ".env"}`));
  } else {
    checks.push(fail(".env", "missing .env; create one from .env.example before live smoke"));
  }

  let config: AppConfig;
  try {
    config = loadConfig(env);
    checks.push(ok("config", "required Telegram and vault settings are present"));
  } catch (error) {
    if (error instanceof ConfigError) {
      checks.push(fail("config", error.issues.join("; ")));
      return finish(envPath, checks);
    }
    throw error;
  }

  if (config.telegram.allowedUserIds.length === 0) {
    checks.push(fail("TELEGRAM_ALLOWED_USER_IDS", "must include the Telegram user id allowed to run /ingest"));
  } else {
    checks.push(ok("TELEGRAM_ALLOWED_USER_IDS", `${config.telegram.allowedUserIds.length} allowed operator id(s)`));
  }

  await checkWritableDirectoryIntent(checks, "INGEST_RUNTIME_DIR", resolveFrom(cwd, config.runtime.runtimeDir), {
    mustExist: false,
  });
  await checkWritableDirectoryIntent(checks, "SQLITE_DB_PATH parent", path.dirname(resolveFrom(cwd, config.runtime.sqliteDbPath)), {
    mustExist: false,
  });
  await checkWritableDirectoryIntent(checks, "OBSIDIAN_VAULT_PATH", resolveFrom(cwd, config.vault.obsidianVaultPath), {
    mustExist: true,
  });
  await checkWritableDirectoryIntent(
    checks,
    "OBSIDIAN_RAW_ROOT",
    path.resolve(resolveFrom(cwd, config.vault.obsidianVaultPath), config.vault.rawRoot),
    { mustExist: false },
  );

  if (config.telegram.localFilesRoot) {
    await checkReadableDirectory(checks, "TELEGRAM_LOCAL_FILES_ROOT", resolveFrom(cwd, config.telegram.localFilesRoot));
  } else {
    checks.push(warn("TELEGRAM_LOCAL_FILES_ROOT", "not set; live smoke depends on Local Bot API returning absolute file paths"));
  }

  if ((config.rtzr.clientId && !config.rtzr.clientSecret) || (!config.rtzr.clientId && config.rtzr.clientSecret)) {
    checks.push(fail("RTZR", "set both RTZR_CLIENT_ID and RTZR_CLIENT_SECRET, or leave both empty to skip STT"));
  } else if (config.rtzr.clientId && config.rtzr.clientSecret) {
    checks.push(ok("RTZR", "credentials present; audio/voice STT can run"));
  } else {
    checks.push(warn("RTZR", "credentials not set; audio/voice STT will be skipped until configured"));
  }

  if (config.wiki.ingestCommand) {
    checks.push(ok("WIKI_INGEST_COMMAND", "configured; wiki adapter can run after raw bundle write"));
  } else {
    checks.push(warn("WIKI_INGEST_COMMAND", "not set; worker will preserve raw bundles and skip wiki adaptation"));
  }

  if (options.checkTelegram ?? true) {
    const client = new TelegramBotApiClient(
      {
        botToken: config.telegram.botToken,
        baseUrl: config.telegram.botApiBaseUrl,
        ...(config.telegram.localFilesRoot ? { localFilesRoot: config.telegram.localFilesRoot } : {}),
      },
      options.fetchImpl,
    );
    const health = await checkTelegramLocalBotApi(client);
    if (health.ok) {
      checks.push(ok("Telegram Local Bot API Server", `reachable as ${health.bot?.username ?? health.bot?.first_name ?? "bot"}`));
    } else {
      checks.push(fail("Telegram Local Bot API Server", health.issues.join("; ")));
    }
  }

  return finish(envPath, checks);
}

function finish(envPath: string | null, checks: ReadinessCheck[]): ReadinessReport {
  return {
    envPath,
    checks,
    ready: checks.every((check) => check.status !== "fail"),
  };
}

async function checkWritableDirectoryIntent(
  checks: ReadinessCheck[],
  name: string,
  directoryPath: string,
  options: { mustExist: boolean },
): Promise<void> {
  const existing = await nearestExistingPath(directoryPath);
  if (!existing) {
    checks.push(fail(name, `no existing parent for ${directoryPath}`));
    return;
  }

  if (existing === directoryPath) {
    const stat = await fs.stat(directoryPath);
    if (!stat.isDirectory()) {
      checks.push(fail(name, `${directoryPath} is not a directory`));
      return;
    }
    await checkAccess(checks, name, directoryPath, fs.constants.R_OK | fs.constants.W_OK, "read/write");
    return;
  }

  if (options.mustExist) {
    checks.push(fail(name, `${directoryPath} does not exist`));
    return;
  }

  await checkAccess(checks, name, existing, fs.constants.W_OK, `can be created under ${existing}`);
}

async function checkReadableDirectory(checks: ReadinessCheck[], name: string, directoryPath: string): Promise<void> {
  try {
    const stat = await fs.stat(directoryPath);
    if (!stat.isDirectory()) {
      checks.push(fail(name, `${directoryPath} is not a directory`));
      return;
    }
    await checkAccess(checks, name, directoryPath, fs.constants.R_OK, "readable");
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    checks.push(fail(name, code === "ENOENT" ? `${directoryPath} does not exist` : String(error)));
  }
}

async function checkAccess(
  checks: ReadinessCheck[],
  name: string,
  targetPath: string,
  mode: number,
  success: string,
): Promise<void> {
  try {
    await fs.access(targetPath, mode);
    checks.push(ok(name, `${success}: ${targetPath}`));
  } catch {
    checks.push(fail(name, `insufficient access: ${targetPath}`));
  }
}

async function nearestExistingPath(targetPath: string): Promise<string | null> {
  let current = path.resolve(targetPath);
  while (true) {
    try {
      await fs.access(current, fs.constants.F_OK);
      return current;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) {
        return null;
      }
      current = parent;
    }
  }
}

function resolveFrom(cwd: string, value: string): string {
  return path.isAbsolute(value) ? value : path.resolve(cwd, value);
}

function ok(name: string, message: string): ReadinessCheck {
  return { status: "ok", name, message };
}

function warn(name: string, message: string): ReadinessCheck {
  return { status: "warn", name, message };
}

function fail(name: string, message: string): ReadinessCheck {
  return { status: "fail", name, message };
}

export function renderReadinessReport(report: ReadinessReport): string {
  const lines = [`Live smoke readiness: ${report.ready ? "ready" : "not ready"}`];
  for (const check of report.checks) {
    lines.push(`${check.status.toUpperCase().padEnd(4)} ${check.name}: ${check.message}`);
  }
  return `${lines.join("\n")}\n`;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const report = await checkLiveSmokeReadiness();
  process.stdout.write(renderReadinessReport(report));
  process.exitCode = report.ready ? 0 : 1;
}
