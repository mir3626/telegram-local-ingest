import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";

import { buildAgentCommand } from "@telegram-local-ingest/agent-adapter";
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

  checks.push(ok("STT_PROVIDER", config.stt.provider));
  if (config.stt.provider === "rtzr") {
    if ((config.rtzr.clientId && !config.rtzr.clientSecret) || (!config.rtzr.clientId && config.rtzr.clientSecret)) {
      checks.push(fail("RTZR", "set both RTZR_CLIENT_ID and RTZR_CLIENT_SECRET, or leave both empty to skip STT"));
    } else if (config.rtzr.clientId && config.rtzr.clientSecret) {
      checks.push(ok("RTZR", "credentials present; audio/voice STT can run"));
    } else {
      checks.push(warn("RTZR", "credentials not set; audio/voice STT will be skipped until configured"));
    }
  } else if (config.stt.provider === "sensevoice") {
    await checkReadableFile(checks, "SENSEVOICE_SCRIPT_PATH", resolveFrom(cwd, config.sensevoice.scriptPath));
    const python = await checkCommandVersion(config.sensevoice.pythonPath, ["--version"]);
    if (python.ok) {
      checks.push(ok("SENSEVOICE_PYTHON", `${config.sensevoice.pythonPath}: ${python.output}`));
    } else {
      checks.push(fail("SENSEVOICE_PYTHON", `${config.sensevoice.pythonPath} is not runnable: ${python.output}`));
    }
    const funasr = await checkCommandVersion(config.sensevoice.pythonPath, ["-c", "import funasr; print('funasr ok')"]);
    if (funasr.ok) {
      checks.push(ok("SenseVoice dependencies", "funasr import succeeded"));
    } else {
      checks.push(fail("SenseVoice dependencies", "run scripts/setup-sensevoice-cpu.sh, then set SENSEVOICE_PYTHON=.venv-sensevoice/bin/python"));
    }
  } else {
    checks.push(warn("STT", "audio/voice transcription disabled by STT_PROVIDER=none"));
  }

  if (config.wiki.ingestCommand) {
    checks.push(ok("WIKI_INGEST_COMMAND", "configured; wiki adapter can run after raw bundle write"));
  } else {
    checks.push(warn("WIKI_INGEST_COMMAND", "not set; worker will preserve raw bundles and skip wiki adaptation"));
  }

  await checkAgentPostprocessReadiness(checks, config, cwd, env);

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

async function checkAgentPostprocessReadiness(
  checks: ReadinessCheck[],
  config: AppConfig,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  if (config.agent.provider === "none") {
    checks.push(warn("AGENT_POSTPROCESS_PROVIDER", "none; translation/formatting agent will be skipped"));
    return;
  }
  if (!config.agent.command) {
    checks.push(fail("AGENT_POSTPROCESS_COMMAND", "required when AGENT_POSTPROCESS_PROVIDER is enabled"));
    return;
  }

  let command: ReturnType<typeof buildAgentCommand>;
  try {
    command = buildAgentCommand(config.agent.command, {
      bundlePath: path.join(cwd, "raw-placeholder"),
      jobId: "readiness-job",
      outputDir: path.join(cwd, "runtime", "agent-readiness-output"),
      projectRoot: cwd,
      promptFile: path.join(cwd, "runtime", "agent-readiness-prompt.md"),
    });
  } catch (error) {
    checks.push(fail("AGENT_POSTPROCESS_COMMAND", error instanceof Error ? error.message : String(error)));
    return;
  }

  const commandPath = resolveCommandPath(cwd, command.command);
  if (commandPath.includes(path.sep)) {
    await checkReadableFile(checks, "AGENT_POSTPROCESS_COMMAND", commandPath);
  } else {
    const version = await checkCommandVersion(command.command, ["--version"]);
    if (version.ok) {
      checks.push(ok("AGENT_POSTPROCESS_COMMAND", `${command.command}: ${version.output}`));
    } else {
      checks.push(warn("AGENT_POSTPROCESS_COMMAND", `custom command not version-checkable: ${version.output}`));
    }
  }

  if (path.basename(command.command) === "run-codex-postprocess.sh") {
    const health = await checkCommandVersion(commandPath, ["--health"]);
    if (health.ok) {
      checks.push(ok("Codex postprocess wrapper", health.output));
    } else {
      checks.push(fail("Codex postprocess wrapper", health.output));
    }
  } else {
    checks.push(warn("Codex postprocess wrapper", "not using scripts/run-codex-postprocess.sh; custom command live behavior was not checked"));
  }

  await checkDocxTemplateRenderTools(checks, cwd, env);
}

async function checkDocxTemplateRenderTools(checks: ReadinessCheck[], cwd: string, env: NodeJS.ProcessEnv): Promise<void> {
  const pandocCommand = resolveCommandPath(cwd, env.PANDOC_BIN || "pandoc");
  const pandoc = await checkCommandVersion(pandocCommand, ["--version"]);
  if (pandoc.ok) {
    checks.push(ok("DOCX document renderer: pandoc", firstLine(pandoc.output)));
  } else {
    checks.push(warn("DOCX document renderer: pandoc", "missing; DOCX/HWP uploads may fall back to the agent's raw output"));
  }
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

async function checkReadableFile(checks: ReadinessCheck[], name: string, filePath: string): Promise<void> {
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) {
      checks.push(fail(name, `${filePath} is not a file`));
      return;
    }
    await checkAccess(checks, name, filePath, fs.constants.R_OK, "readable");
  } catch (error) {
    checks.push(fail(name, error instanceof Error ? error.message : String(error)));
  }
}

function checkCommandVersion(command: string, args: string[]): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      resolve({ ok: false, output: "timed out" });
    }, 10_000);
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      resolve({ ok: false, output: error.message });
    });
    child.on("close", (exitCode) => {
      clearTimeout(timeout);
      resolve({
        ok: exitCode === 0,
        output: (stdout || stderr).trim(),
      });
    });
  });
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

function resolveCommandPath(cwd: string, command: string): string {
  if (path.isAbsolute(command)) {
    return command;
  }
  if (command.includes("/") || command.includes("\\")) {
    return path.resolve(cwd, command);
  }
  return command;
}

function firstLine(value: string): string {
  return value.split(/\r?\n/).find((line) => line.trim().length > 0)?.trim() ?? value;
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
