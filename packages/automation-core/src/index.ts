import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

const scheduleSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("manual"),
  }),
  z.object({
    type: z.literal("daily"),
    time: z.string().regex(/^\d{2}:\d{2}$/),
    timezone: z.string().default("Asia/Seoul"),
    catchUp: z.enum(["none", "missed-runs", "missing-business-days"]).default("none"),
  }),
  z.object({
    type: z.literal("interval"),
    intervalMinutes: z.number().int().positive(),
    catchUp: z.enum(["none", "missed-runs"]).default("none"),
  }),
]);

const retrySchema = z.object({
  maxAttempts: z.number().int().nonnegative().default(0),
  backoffMs: z.number().int().nonnegative().default(0),
});

export const automationManifestSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/),
  title: z.string().min(1),
  description: z.string().optional(),
  entry: z.string().min(1),
  defaultEnabled: z.boolean().default(false),
  schedule: scheduleSchema.default({ type: "manual" }),
  requiredEnv: z.array(z.string().min(1)).default([]),
  capabilities: z.array(z.string().min(1)).default([]),
  timeoutMs: z.number().int().positive().default(120_000),
  retry: retrySchema.default({ maxAttempts: 0, backoffMs: 0 }),
});

export type AutomationManifest = z.infer<typeof automationManifestSchema>;

export interface DiscoveredAutomationModule {
  manifest: AutomationManifest;
  moduleDir: string;
  manifestPath: string;
  entryPath: string;
}

export interface AutomationReadiness {
  ready: boolean;
  missingEnv: string[];
}

export interface AutomationScheduleStateSnapshot {
  lastDueKey?: string;
  lastDueAt?: string;
  nextDueAt?: string;
  retryAfter?: string;
}

export interface AutomationDueWindow {
  scheduleKey: string;
  idempotencyKey: string;
  dueAt: string;
}

export interface RunAutomationModuleInput {
  module: DiscoveredAutomationModule;
  projectRoot: string;
  runtimeDir: string;
  sqliteDbPath: string;
  runId: string;
  runDir: string;
  trigger: string;
  idempotencyKey?: string;
  scheduledAt?: string;
  env?: NodeJS.ProcessEnv;
}

export interface RunAutomationModuleResult {
  exitCode: number;
  stdoutPath: string;
  stderrPath: string;
  resultPath: string;
  startedAt: string;
  endedAt: string;
  error?: string;
}

export async function discoverAutomationModules(modulesRoot: string): Promise<DiscoveredAutomationModule[]> {
  const resolvedRoot = path.resolve(modulesRoot);
  let entries;
  try {
    entries = await fs.readdir(resolvedRoot, { withFileTypes: true });
  } catch (error) {
    if (isNotFound(error)) {
      return [];
    }
    throw error;
  }

  const modules: DiscoveredAutomationModule[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) {
      continue;
    }
    const moduleDir = path.join(resolvedRoot, entry.name);
    const manifestPath = path.join(moduleDir, "manifest.json");
    let rawManifest;
    try {
      rawManifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as unknown;
    } catch (error) {
      if (isNotFound(error)) {
        continue;
      }
      throw new Error(`Failed to read automation manifest ${manifestPath}: ${errorMessage(error)}`);
    }
    const manifest = automationManifestSchema.parse(rawManifest);
    const entryPath = path.resolve(moduleDir, manifest.entry);
    assertInside(moduleDir, entryPath, "Automation entry must stay inside its module directory");
    modules.push({
      manifest,
      moduleDir,
      manifestPath,
      entryPath,
    });
  }

  return modules.sort((left, right) => left.manifest.id.localeCompare(right.manifest.id));
}

export function getAutomationReadiness(
  manifest: AutomationManifest,
  env: NodeJS.ProcessEnv = process.env,
): AutomationReadiness {
  const missingEnv = manifest.requiredEnv.filter((key) => !env[key]?.trim());
  return {
    ready: missingEnv.length === 0,
    missingEnv,
  };
}

export function buildAutomationRunId(moduleId: string, now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:.]/g, "");
  const safeModuleId = moduleId.replace(/[^a-zA-Z0-9_-]+/g, "_");
  return `${safeModuleId}_${stamp}`;
}

export function getDueAutomationWindows(
  manifest: AutomationManifest,
  state: AutomationScheduleStateSnapshot = {},
  now = new Date(),
  maxCatchUp = 10,
): AutomationDueWindow[] {
  if (state.retryAfter && new Date(state.retryAfter).getTime() > now.getTime()) {
    return [];
  }
  if (manifest.schedule.type === "manual") {
    return [];
  }
  if (state.nextDueAt) {
    const nextDueMs = new Date(state.nextDueAt).getTime();
    if (Number.isFinite(nextDueMs) && nextDueMs > now.getTime()) {
      return [];
    }
  }
  if (manifest.schedule.type === "daily") {
    return getDueDailyWindows(manifest, state, now, maxCatchUp);
  }
  return getDueIntervalWindows(manifest, state, now, maxCatchUp);
}

export function getNextAutomationDueAt(manifest: AutomationManifest, after = new Date()): string | undefined {
  if (manifest.schedule.type === "manual") {
    return undefined;
  }
  if (manifest.schedule.type === "interval") {
    const intervalMs = manifest.schedule.intervalMinutes * 60_000;
    const nextMs = Math.floor(after.getTime() / intervalMs) * intervalMs + intervalMs;
    return new Date(nextMs).toISOString();
  }

  const { time, timezone, catchUp } = manifest.schedule;
  const [hour, minute] = parseHourMinute(time);
  let localDate = getTimeZoneDateParts(after, timezone).date;
  for (let attempt = 0; attempt < 14; attempt += 1) {
    if (catchUp !== "missing-business-days" || isBusinessDay(localDate)) {
      const candidate = zonedLocalDateTimeToUtc(localDate, hour, minute, timezone);
      if (candidate.getTime() > after.getTime()) {
        return candidate.toISOString();
      }
    }
    localDate = addLocalDays(localDate, 1);
  }
  return undefined;
}

export async function runAutomationModule(input: RunAutomationModuleInput): Promise<RunAutomationModuleResult> {
  const startedAt = new Date().toISOString();
  await fs.mkdir(input.runDir, { recursive: true });
  const stdoutPath = path.join(input.runDir, "stdout.log");
  const stderrPath = path.join(input.runDir, "stderr.log");
  const resultPath = path.join(input.runDir, "result.json");
  const readiness = getAutomationReadiness(input.module.manifest, input.env ?? process.env);
  if (!readiness.ready) {
    const endedAt = new Date().toISOString();
    const error = `Missing required env: ${readiness.missingEnv.join(", ")}`;
    await writeRunFiles({ stdoutPath, stderrPath, resultPath, stdout: "", stderr: `${error}\n`, result: {
      moduleId: input.module.manifest.id,
      runId: input.runId,
      trigger: input.trigger,
      status: "failed",
      startedAt,
      endedAt,
      error,
    } });
    return { exitCode: 1, stdoutPath, stderrPath, resultPath, startedAt, endedAt, error };
  }

  return spawnAutomationEntry(input, { stdoutPath, stderrPath, resultPath, startedAt });
}

async function spawnAutomationEntry(
  input: RunAutomationModuleInput,
  paths: { stdoutPath: string; stderrPath: string; resultPath: string; startedAt: string },
): Promise<RunAutomationModuleResult> {
  return new Promise<RunAutomationModuleResult>((resolve) => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;
    let timeout: NodeJS.Timeout | undefined;
    const childEnv: NodeJS.ProcessEnv = {
      ...(input.env ?? process.env),
      AUTOMATION_MODULE_ID: input.module.manifest.id,
      AUTOMATION_RUN_ID: input.runId,
      AUTOMATION_TRIGGER: input.trigger,
      AUTOMATION_PROJECT_ROOT: input.projectRoot,
      AUTOMATION_RUNTIME_DIR: input.runtimeDir,
      AUTOMATION_SQLITE_DB_PATH: input.sqliteDbPath,
      AUTOMATION_RESULT_PATH: paths.resultPath,
      ...(input.idempotencyKey ? { AUTOMATION_IDEMPOTENCY_KEY: input.idempotencyKey } : {}),
      ...(input.scheduledAt ? { AUTOMATION_SCHEDULED_AT: input.scheduledAt } : {}),
    };
    const child = spawn(process.execPath, [
      input.module.entryPath,
      "--module-id", input.module.manifest.id,
      "--run-id", input.runId,
      "--project-root", input.projectRoot,
      "--runtime-dir", input.runtimeDir,
      "--sqlite-db-path", input.sqliteDbPath,
      "--result", paths.resultPath,
    ], {
      cwd: input.module.moduleDir,
      env: childEnv,
      windowsHide: true,
    });

    const finish = async (exitCode: number, error?: string): Promise<void> => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeout) {
        clearTimeout(timeout);
      }
      const endedAt = new Date().toISOString();
      const stdoutText = Buffer.concat(stdout).toString("utf8");
      const stderrText = Buffer.concat(stderr).toString("utf8");
      const moduleResult = await readExistingModuleResult(paths.resultPath);
      const result = {
        moduleId: input.module.manifest.id,
        runId: input.runId,
        trigger: input.trigger,
        status: exitCode === 0 ? "succeeded" : "failed",
        exitCode,
        startedAt: paths.startedAt,
        endedAt,
        ...(moduleResult !== undefined ? { moduleResult } : {}),
        ...(error ? { error } : {}),
      };
      await writeRunFiles({
        stdoutPath: paths.stdoutPath,
        stderrPath: paths.stderrPath,
        resultPath: paths.resultPath,
        stdout: stdoutText,
        stderr: error && !stderrText ? `${error}\n` : stderrText,
        result,
      });
      resolve({
        exitCode,
        stdoutPath: paths.stdoutPath,
        stderrPath: paths.stderrPath,
        resultPath: paths.resultPath,
        startedAt: paths.startedAt,
        endedAt,
        ...(error ? { error } : {}),
      });
    };

    timeout = setTimeout(() => {
      child.kill("SIGTERM");
      void finish(1, `${input.module.manifest.id} timed out after ${input.module.manifest.timeoutMs}ms`);
    }, input.module.manifest.timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => {
      void finish(1, error.message);
    });
    child.on("close", (exitCode) => {
      void finish(exitCode ?? 1);
    });
  }).catch((error) => {
    throw new Error(`Automation ${input.module.manifest.id} failed to run: ${errorMessage(error)}`);
  });
}

async function writeRunFiles(input: {
  stdoutPath: string;
  stderrPath: string;
  resultPath: string;
  stdout: string;
  stderr: string;
  result: unknown;
}): Promise<void> {
  await fs.mkdir(path.dirname(input.stdoutPath), { recursive: true });
  await Promise.all([
    writeOptionalTextFile(input.stdoutPath, input.stdout),
    writeOptionalTextFile(input.stderrPath, input.stderr),
    fs.writeFile(input.resultPath, `${JSON.stringify(input.result, null, 2)}\n`, "utf8"),
  ]);
}

async function writeOptionalTextFile(filePath: string, text: string): Promise<void> {
  if (text.length === 0) {
    await fs.rm(filePath, { force: true });
    return;
  }
  await fs.writeFile(filePath, text, "utf8");
}

async function readExistingModuleResult(resultPath: string): Promise<unknown | undefined> {
  let text;
  try {
    text = await fs.readFile(resultPath, "utf8");
  } catch (error) {
    if (isNotFound(error)) {
      return undefined;
    }
    throw error;
  }
  const trimmed = text.trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return { raw: trimmed };
  }
}

function getDueDailyWindows(
  manifest: AutomationManifest,
  state: AutomationScheduleStateSnapshot,
  now: Date,
  maxCatchUp: number,
): AutomationDueWindow[] {
  if (manifest.schedule.type !== "daily") {
    return [];
  }
  const { time, timezone, catchUp } = manifest.schedule;
  const [hour, minute] = parseHourMinute(time);
  const today = getTimeZoneDateParts(now, timezone).date;
  let startDate = today;
  const lastDate = parseDailyScheduleKey(state.lastDueKey);
  if (catchUp !== "none" && lastDate) {
    startDate = addLocalDays(lastDate, 1);
  } else if (catchUp !== "none" && state.nextDueAt) {
    startDate = getTimeZoneDateParts(new Date(state.nextDueAt), timezone).date;
  }
  const earliestDate = addLocalDays(today, -Math.max(0, maxCatchUp - 1));
  if (compareLocalDate(startDate, earliestDate) < 0) {
    startDate = earliestDate;
  }
  if (catchUp === "none") {
    startDate = today;
  }

  const windows: AutomationDueWindow[] = [];
  for (let localDate = startDate; compareLocalDate(localDate, today) <= 0; localDate = addLocalDays(localDate, 1)) {
    if (catchUp === "missing-business-days" && !isBusinessDay(localDate)) {
      continue;
    }
    const dueAt = zonedLocalDateTimeToUtc(localDate, hour, minute, timezone);
    if (dueAt.getTime() > now.getTime()) {
      continue;
    }
    const scheduleKey = `daily:${localDate}`;
    windows.push({
      scheduleKey,
      idempotencyKey: scheduleKey,
      dueAt: dueAt.toISOString(),
    });
    if (windows.length >= maxCatchUp || catchUp === "none") {
      break;
    }
  }
  return windows;
}

function getDueIntervalWindows(
  manifest: AutomationManifest,
  state: AutomationScheduleStateSnapshot,
  now: Date,
  maxCatchUp: number,
): AutomationDueWindow[] {
  if (manifest.schedule.type !== "interval") {
    return [];
  }
  const intervalMs = manifest.schedule.intervalMinutes * 60_000;
  let dueMs: number;
  if (state.nextDueAt) {
    dueMs = new Date(state.nextDueAt).getTime();
  } else if (state.lastDueAt) {
    dueMs = new Date(state.lastDueAt).getTime() + intervalMs;
  } else {
    dueMs = Math.floor(now.getTime() / intervalMs) * intervalMs;
  }
  if (!Number.isFinite(dueMs)) {
    dueMs = Math.floor(now.getTime() / intervalMs) * intervalMs;
  }

  const windows: AutomationDueWindow[] = [];
  while (dueMs <= now.getTime() && windows.length < maxCatchUp) {
    const dueAt = new Date(dueMs).toISOString();
    const scheduleKey = `interval:${dueAt}`;
    windows.push({ scheduleKey, idempotencyKey: scheduleKey, dueAt });
    dueMs += intervalMs;
    if (manifest.schedule.catchUp === "none") {
      break;
    }
  }
  return windows;
}

function parseHourMinute(value: string): [number, number] {
  const [hour, minute] = value.split(":").map((part) => Number.parseInt(part, 10));
  return [hour ?? 0, minute ?? 0];
}

function parseDailyScheduleKey(key: string | undefined): string | undefined {
  if (!key?.startsWith("daily:")) {
    return undefined;
  }
  const date = key.slice("daily:".length);
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : undefined;
}

function getTimeZoneDateParts(date: Date, timeZone: string): { date: string; hour: number; minute: number; second: number } {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value])) as Record<string, string>;
  return {
    date: `${requireDatePart(parts, "year")}-${requireDatePart(parts, "month")}-${requireDatePart(parts, "day")}`,
    hour: Number.parseInt(requireDatePart(parts, "hour"), 10),
    minute: Number.parseInt(requireDatePart(parts, "minute"), 10),
    second: Number.parseInt(requireDatePart(parts, "second"), 10),
  };
}

function zonedLocalDateTimeToUtc(localDate: string, hour: number, minute: number, timeZone: string): Date {
  const [year, month, day] = parseLocalDate(localDate);
  const targetAsUtc = Date.UTC(year, month - 1, day, hour, minute, 0);
  let guess = targetAsUtc;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const parts = getTimeZoneDateParts(new Date(guess), timeZone);
    const actualAsUtc = Date.UTC(
      Number.parseInt(parts.date.slice(0, 4), 10),
      Number.parseInt(parts.date.slice(5, 7), 10) - 1,
      Number.parseInt(parts.date.slice(8, 10), 10),
      parts.hour,
      parts.minute,
      parts.second,
    );
    guess += targetAsUtc - actualAsUtc;
  }
  return new Date(guess);
}

function addLocalDays(localDate: string, days: number): string {
  const [year, month, day] = parseLocalDate(localDate);
  const date = new Date(Date.UTC(year, month - 1, day + days, 0, 0, 0));
  return date.toISOString().slice(0, 10);
}

function compareLocalDate(left: string, right: string): number {
  return left.localeCompare(right);
}

function isBusinessDay(localDate: string): boolean {
  const [year, month, day] = parseLocalDate(localDate);
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return weekday !== 0 && weekday !== 6;
}

function requireDatePart(parts: Record<string, string>, key: string): string {
  const value = parts[key];
  if (!value) {
    throw new Error(`Missing time zone date part: ${key}`);
  }
  return value;
}

function parseLocalDate(localDate: string): [number, number, number] {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(localDate);
  if (!match) {
    throw new Error(`Invalid local date: ${localDate}`);
  }
  return [Number.parseInt(match[1]!, 10), Number.parseInt(match[2]!, 10), Number.parseInt(match[3]!, 10)];
}

function assertInside(root: string, candidate: string, message: string): void {
  const relative = path.relative(root, candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(message);
  }
}

function isNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
