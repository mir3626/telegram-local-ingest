#!/usr/bin/env node
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { DatabaseSync } from "node:sqlite";

import {
  type AutomationDueWindow,
  type AutomationManifest,
  buildAutomationRunId,
  discoverAutomationModules,
  getAutomationReadiness,
  getDueAutomationWindows,
  getNextAutomationDueAt,
  runAutomationModule,
  type DiscoveredAutomationModule,
} from "@telegram-local-ingest/automation-core";
import { loadNearestEnvFile } from "@telegram-local-ingest/core";
import {
  completeAutomationRun,
  createAutomationRun,
  getAutomationRun,
  getAutomationRunByIdempotency,
  getAutomationScheduleState,
  listAutomationModules,
  listAutomationRuns,
  markAutomationModulesUnavailableExcept,
  migrate,
  openIngestDatabase,
  setAutomationModuleEnabled,
  upsertAutomationModule,
  upsertAutomationScheduleState,
  type StoredAutomationModule,
  type StoredAutomationRun,
  type StoredAutomationScheduleState,
} from "@telegram-local-ingest/db";

interface RuntimePaths {
  projectRoot: string;
  modulesRoot: string;
  runtimeDir: string;
  sqliteDbPath: string;
  automationRunsDir: string;
}

export interface OpsDashboardOptions {
  projectRoot?: string;
  host?: string;
  port?: number;
  env?: NodeJS.ProcessEnv;
  loadEnvFile?: boolean;
}

export interface StartedOpsDashboard {
  server: http.Server;
  url: string;
  paths: RuntimePaths;
}

interface DashboardContext {
  paths: RuntimePaths;
  env: NodeJS.ProcessEnv;
}

interface RunArtifactLinks {
  rawBundlePath?: string;
  wikiPagePath?: string;
  wikiPageRelative?: string;
}

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 58991;
const MAX_LOG_CHARS = 80_000;
const RECENT_RUN_LIMIT = 100;

export async function createOpsDashboardServer(options: OpsDashboardOptions = {}): Promise<StartedOpsDashboard> {
  const env = options.env ?? process.env;
  const projectRoot = options.projectRoot ? path.resolve(options.projectRoot) : await findProjectRoot(process.cwd());
  if (options.loadEnvFile !== false) {
    loadNearestEnvFile(projectRoot, env);
  }
  const paths = resolveRuntimePaths(projectRoot, env);
  const context: DashboardContext = { paths, env };
  const host = options.host ?? env.OPS_DASHBOARD_HOST?.trim() ?? DEFAULT_HOST;
  if (!isLocalBindHost(host)) {
    throw new Error("OPS dashboard only supports localhost bind addresses");
  }
  const port = options.port ?? Number.parseInt(env.OPS_DASHBOARD_PORT ?? String(DEFAULT_PORT), 10);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error("OPS_DASHBOARD_PORT must be a valid TCP port");
  }

  const server = http.createServer((request, response) => {
    void handleRequest(context, request, response);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address() as AddressInfo;
  return {
    server,
    paths,
    url: `http://${host}:${address.port}/`,
  };
}

export async function startOpsDashboard(options: OpsDashboardOptions = {}): Promise<StartedOpsDashboard> {
  const started = await createOpsDashboardServer(options);
  process.stdout.write(`ops dashboard listening ${started.url}\n`);
  return started;
}

async function handleRequest(context: DashboardContext, request: IncomingMessage, response: ServerResponse): Promise<void> {
  try {
    if (!isLoopbackRemote(request.socket.remoteAddress)) {
      sendJson(response, 403, { error: "forbidden_remote" });
      return;
    }
    const url = new URL(request.url ?? "/", "http://localhost");
    if (request.method === "GET" && url.pathname === "/") {
      sendHtml(response, renderDashboardHtml());
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/state") {
      sendJson(response, 200, await readDashboardState(context));
      return;
    }
    if (request.method === "GET" && url.pathname.startsWith("/api/runs/")) {
      const id = decodeURIComponent(url.pathname.slice("/api/runs/".length));
      sendJson(response, 200, await readRunDetail(context, id));
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/dispatch") {
      assertAdminRequest(context, request, url);
      const body = await readJsonBody(request);
      const dryRun = body.dryRun === true;
      const maxCatchUp = typeof body.maxCatchUp === "number" ? body.maxCatchUp : 10;
      sendJson(response, 200, await dispatchDueAutomations(context, { dryRun, maxCatchUp }));
      return;
    }
    const moduleAction = url.pathname.match(/^\/api\/modules\/([^/]+)\/(enable|disable|run)$/);
    if (request.method === "POST" && moduleAction) {
      assertAdminRequest(context, request, url);
      const moduleId = decodeURIComponent(moduleAction[1] ?? "");
      const action = moduleAction[2];
      if (action === "enable" || action === "disable") {
        sendJson(response, 200, await setModuleEnabled(context, moduleId, action === "enable"));
        return;
      }
      const body = await readJsonBody(request);
      sendJson(response, 200, await runModuleNow(context, moduleId, body.force === true));
      return;
    }
    sendJson(response, 404, { error: "not_found" });
  } catch (error) {
    const statusCode = error instanceof DashboardHttpError ? error.statusCode : 500;
    sendJson(response, statusCode, { error: errorMessage(error) });
  }
}

async function readDashboardState(context: DashboardContext): Promise<unknown> {
  const { db, discovered } = await openSyncedAutomationDb(context);
  try {
    const discoveredById = new Map(discovered.map((module) => [module.manifest.id, module]));
    const modules = await Promise.all(listAutomationModules(db).map(async (stored) => {
      const manifest = parseManifest(stored);
      const readiness = getAutomationReadiness(manifest, context.env);
      const scheduleState = getAutomationScheduleState(db, stored.id);
      const lastRun = listAutomationRuns(db, { moduleId: stored.id, limit: 1 })[0];
      const nextDueAt = scheduleState?.nextDueAt ?? getNextAutomationDueAt(manifest);
      const links = lastRun ? await readRunArtifactLinks(context, lastRun) : {};
      return {
        id: stored.id,
        title: manifest.title,
        description: manifest.description ?? "",
        enabled: stored.enabled,
        available: stored.available && discoveredById.has(stored.id),
        readiness,
        schedule: manifest.schedule,
        nextDueAt,
        scheduleState,
        lastRun,
        lastRunLinks: links,
      };
    }));
    const runs = await Promise.all(listAutomationRuns(db, { limit: RECENT_RUN_LIMIT }).map(async (run) => ({
      ...run,
      links: await readRunArtifactLinks(context, run),
    })));
    return {
      project: {
        root: context.paths.projectRoot,
        sqliteDbPath: context.paths.sqliteDbPath,
        modulesRoot: context.paths.modulesRoot,
      },
      modules,
      runs,
      admin: {
        tokenRequired: Boolean(context.env.OPS_DASHBOARD_TOKEN?.trim()),
      },
    };
  } finally {
    db.close();
  }
}

async function setModuleEnabled(context: DashboardContext, moduleId: string, enabled: boolean): Promise<unknown> {
  const { db } = await openSyncedAutomationDb(context);
  try {
    const updated = setAutomationModuleEnabled(db, moduleId, enabled);
    return { module: updated };
  } finally {
    db.close();
  }
}

async function runModuleNow(context: DashboardContext, moduleId: string, force: boolean): Promise<unknown> {
  const { db, discovered } = await openSyncedAutomationDb(context);
  try {
    const stored = listAutomationModules(db).find((item) => item.id === moduleId);
    if (!stored) {
      throw new Error(`Automation module not registered: ${moduleId}`);
    }
    if (!stored.available) {
      throw new Error(`Automation module is not available on disk: ${moduleId}`);
    }
    if (!stored.enabled && !force) {
      throw new Error(`Automation module is disabled: ${moduleId}`);
    }
    const module = mustFindDiscovered(discovered, moduleId);
    const run = await runAndRecordAutomation(context.paths, module, "manual", db, context.env);
    return await readRunDetail(context, run.id);
  } finally {
    db.close();
  }
}

async function readRunDetail(context: DashboardContext, runId: string): Promise<unknown> {
  const dbHandle = openIngestDatabase(context.paths.sqliteDbPath);
  try {
    migrate(dbHandle.db);
    const run = getAutomationRun(dbHandle.db, runId);
    if (!run) {
      throw new Error(`Automation run not found: ${runId}`);
    }
    const [stdout, stderr, resultText] = await Promise.all([
      readSafeRunText(context.paths.automationRunsDir, run.stdoutPath),
      readSafeRunText(context.paths.automationRunsDir, run.stderrPath),
      readSafeRunText(context.paths.automationRunsDir, run.resultPath),
    ]);
    const parsedResult = parseJson(resultText);
    return {
      run,
      stdout,
      stderr,
      resultText,
      result: parsedResult,
      links: await readRunArtifactLinks(context, run, parsedResult),
    };
  } finally {
    dbHandle.close();
  }
}

async function dispatchDueAutomations(
  context: DashboardContext,
  options: { dryRun: boolean; maxCatchUp: number },
): Promise<unknown> {
  const now = new Date();
  const { db, discovered } = await openSyncedAutomationDb(context);
  try {
    const discoveredById = new Map(discovered.map((module) => [module.manifest.id, module]));
    const modules = listAutomationModules(db).filter((module) => module.enabled && module.available);
    const events: Array<Record<string, unknown>> = [];
    let dueCount = 0;
    let runCount = 0;
    let skippedCount = 0;
    for (const stored of modules) {
      const module = discoveredById.get(stored.id);
      if (!module) {
        skippedCount += 1;
        events.push({ type: "skip", moduleId: stored.id, reason: "missing-on-disk" });
        continue;
      }
      const manifest = parseManifest(stored);
      if (manifest.schedule.type === "manual") {
        continue;
      }
      const state = getAutomationScheduleState(db, stored.id);
      const windows = getDueAutomationWindows(manifest, state ?? {}, now, options.maxCatchUp);
      if (windows.length === 0) {
        if (!options.dryRun) {
          ensureFutureScheduleState(db, manifest, state, now);
        }
        continue;
      }
      for (const window of windows) {
        dueCount += 1;
        const existing = getAutomationRunByIdempotency(db, stored.id, window.idempotencyKey);
        if (existing) {
          skippedCount += 1;
          if (!options.dryRun) {
            recordScheduleWindow(db, manifest, state, window, existing, now);
          }
          events.push({ type: "skip", moduleId: stored.id, scheduleKey: window.scheduleKey, existing: existing.status });
          continue;
        }
        if (options.dryRun) {
          events.push({ type: "due", moduleId: stored.id, scheduleKey: window.scheduleKey, dueAt: window.dueAt });
          continue;
        }
        const run = await runAndRecordAutomation(context.paths, module, "scheduled", db, context.env, {
          idempotencyKey: window.idempotencyKey,
          scheduledAt: window.dueAt,
        });
        recordScheduleWindow(db, manifest, getAutomationScheduleState(db, stored.id), window, run, now);
        runCount += 1;
        events.push({ type: "run", moduleId: stored.id, scheduleKey: window.scheduleKey, runId: run.id, status: run.status });
      }
    }
    return { dryRun: options.dryRun, dueCount, runCount, skippedCount, events };
  } finally {
    db.close();
  }
}

async function openSyncedAutomationDb(context: DashboardContext): Promise<{ db: DatabaseSync; discovered: DiscoveredAutomationModule[]; close(): void }> {
  const handle = openIngestDatabase(context.paths.sqliteDbPath);
  try {
    migrate(handle.db);
    const discovered = await discoverAutomationModules(context.paths.modulesRoot);
    syncModules(handle.db, discovered);
    return { db: handle.db, discovered, close: handle.close };
  } catch (error) {
    handle.close();
    throw error;
  }
}

function syncModules(db: DatabaseSync, modules: DiscoveredAutomationModule[]): void {
  const existing = new Map(listAutomationModules(db).map((item) => [item.id, item]));
  for (const module of modules) {
    upsertAutomationModule(db, {
      id: module.manifest.id,
      manifest: module.manifest,
      enabled: existing.get(module.manifest.id)?.enabled ?? module.manifest.defaultEnabled,
    });
  }
  markAutomationModulesUnavailableExcept(db, modules.map((module) => module.manifest.id));
}

async function runAndRecordAutomation(
  paths: RuntimePaths,
  module: DiscoveredAutomationModule,
  trigger: string,
  db: DatabaseSync,
  env: NodeJS.ProcessEnv,
  options: { idempotencyKey?: string; scheduledAt?: string } = {},
): Promise<StoredAutomationRun> {
  const runId = buildAutomationRunId(module.manifest.id);
  const runDir = path.join(paths.automationRunsDir, runId);
  await fs.mkdir(runDir, { recursive: true });
  const stdoutPath = path.join(runDir, "stdout.log");
  const stderrPath = path.join(runDir, "stderr.log");
  const resultPath = path.join(runDir, "result.json");
  createAutomationRun(db, {
    id: runId,
    moduleId: module.manifest.id,
    trigger,
    ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
    stdoutPath,
    stderrPath,
    resultPath,
  });
  const result = await runAutomationModule({
    module,
    projectRoot: paths.projectRoot,
    runtimeDir: paths.runtimeDir,
    sqliteDbPath: paths.sqliteDbPath,
    runId,
    runDir,
    trigger,
    env,
    ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
    ...(options.scheduledAt ? { scheduledAt: options.scheduledAt } : {}),
  });
  return completeAutomationRun(db, {
    id: runId,
    status: result.exitCode === 0 ? "SUCCEEDED" : "FAILED",
    exitCode: result.exitCode,
    endedAt: result.endedAt,
    ...(result.error ? { error: result.error } : {}),
  });
}

function ensureFutureScheduleState(
  db: DatabaseSync,
  manifest: AutomationManifest,
  state: StoredAutomationScheduleState | null,
  now: Date,
): void {
  const nextDueAt = getNextAutomationDueAt(manifest, now);
  if (!nextDueAt && state) {
    return;
  }
  upsertAutomationScheduleState(db, {
    moduleId: manifest.id,
    ...(state?.lastDueKey ? { lastDueKey: state.lastDueKey } : {}),
    ...(state?.lastDueAt ? { lastDueAt: state.lastDueAt } : {}),
    ...(nextDueAt ? { nextDueAt } : {}),
    consecutiveFailures: state?.consecutiveFailures ?? 0,
    ...(state?.retryAfter ? { retryAfter: state.retryAfter } : {}),
    updatedAt: now.toISOString(),
  });
}

function recordScheduleWindow(
  db: DatabaseSync,
  manifest: AutomationManifest,
  previous: StoredAutomationScheduleState | null,
  window: AutomationDueWindow,
  run: StoredAutomationRun,
  now: Date,
): StoredAutomationScheduleState {
  const failed = run.status === "FAILED";
  const consecutiveFailures = failed ? (previous?.consecutiveFailures ?? 0) + 1 : 0;
  const retryAfter = failed && manifest.retry.backoffMs > 0
    ? new Date(now.getTime() + manifest.retry.backoffMs).toISOString()
    : undefined;
  const nextDueAt = getNextAutomationDueAt(manifest, new Date(window.dueAt));
  return upsertAutomationScheduleState(db, {
    moduleId: manifest.id,
    lastDueKey: window.scheduleKey,
    lastDueAt: window.dueAt,
    ...(nextDueAt ? { nextDueAt } : {}),
    consecutiveFailures,
    ...(retryAfter ? { retryAfter } : {}),
    updatedAt: now.toISOString(),
  });
}

async function readRunArtifactLinks(context: DashboardContext, run: StoredAutomationRun, parsedResult?: unknown): Promise<RunArtifactLinks> {
  const result = parsedResult ?? parseJson(await readSafeRunText(context.paths.automationRunsDir, run.resultPath));
  if (!result || typeof result !== "object") {
    return {};
  }
  const moduleResult = (result as { moduleResult?: unknown }).moduleResult;
  if (!moduleResult || typeof moduleResult !== "object") {
    return {};
  }
  const rawBundlePath = typeof (moduleResult as { bundlePath?: unknown }).bundlePath === "string"
    ? (moduleResult as { bundlePath: string }).bundlePath
    : undefined;
  const wikiPageRelative = extractWikiPageRelative(moduleResult);
  const vaultPath = context.env.OBSIDIAN_VAULT_PATH?.trim();
  const wikiPagePath = vaultPath && wikiPageRelative
    ? path.resolve(vaultPath, "wiki", wikiPageRelative)
    : undefined;
  return {
    ...(rawBundlePath ? { rawBundlePath } : {}),
    ...(wikiPageRelative ? { wikiPageRelative } : {}),
    ...(wikiPagePath && await pathExists(wikiPagePath) ? { wikiPagePath } : {}),
  };
}

function extractWikiPageRelative(moduleResult: unknown): string | undefined {
  if (!moduleResult || typeof moduleResult !== "object") {
    return undefined;
  }
  const wiki = (moduleResult as { wiki?: unknown }).wiki;
  if (!wiki || typeof wiki !== "object") {
    return undefined;
  }
  const stdout = (wiki as { stdout?: unknown }).stdout;
  if (typeof stdout !== "string") {
    return undefined;
  }
  const match = stdout.match(/->\s+(sources\/[^\s]+\.md)/);
  return match?.[1];
}

async function readSafeRunText(runsRoot: string, targetPath: string): Promise<string> {
  const resolvedRoot = path.resolve(runsRoot);
  const resolvedTarget = path.resolve(targetPath);
  if (!isPathInside(resolvedRoot, resolvedTarget)) {
    return "[blocked: path outside automation runs root]";
  }
  try {
    const text = await fs.readFile(resolvedTarget, "utf8");
    return text.length > MAX_LOG_CHARS ? `${text.slice(0, MAX_LOG_CHARS)}\n[truncated]` : text;
  } catch (error) {
    return `[unavailable: ${errorMessage(error)}]`;
  }
}

function parseManifest(stored: StoredAutomationModule): AutomationManifest {
  return stored.manifest as AutomationManifest;
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function resolveRuntimePaths(projectRoot: string, env: NodeJS.ProcessEnv): RuntimePaths {
  const runtimeDir = path.resolve(projectRoot, env.INGEST_RUNTIME_DIR ?? "runtime");
  const sqliteDbPath = path.resolve(projectRoot, env.SQLITE_DB_PATH ?? path.join(runtimeDir, "ingest.db"));
  return {
    projectRoot,
    runtimeDir,
    sqliteDbPath,
    modulesRoot: path.resolve(projectRoot, env.AUTOMATION_MODULES_DIR ?? "automations"),
    automationRunsDir: path.resolve(projectRoot, env.AUTOMATION_RUNS_DIR ?? path.join(runtimeDir, "automation", "runs")),
  };
}

async function findProjectRoot(startDir: string): Promise<string> {
  let current = path.resolve(startDir);
  while (true) {
    try {
      const packageJson = JSON.parse(await fs.readFile(path.join(current, "package.json"), "utf8")) as { name?: string };
      if (packageJson.name === "telegram-local-ingest") {
        return current;
      }
    } catch {
      // Continue upward.
    }
    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error("Could not find telegram-local-ingest project root");
    }
    current = parent;
  }
}

function mustFindDiscovered(modules: DiscoveredAutomationModule[], id: string): DiscoveredAutomationModule {
  const found = modules.find((module) => module.manifest.id === id);
  if (!found) {
    throw new Error(`Automation module not found: ${id}`);
  }
  return found;
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) {
    return {};
  }
  const parsed = JSON.parse(text) as unknown;
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
}

function assertAdminRequest(context: DashboardContext, request: IncomingMessage, url: URL): void {
  const token = context.env.OPS_DASHBOARD_TOKEN?.trim();
  if (!token) {
    return;
  }
  const headerToken = request.headers["x-ops-dashboard-token"];
  const authorization = request.headers.authorization;
  const actual = typeof headerToken === "string"
    ? headerToken
    : authorization?.startsWith("Bearer ")
      ? authorization.slice("Bearer ".length)
      : url.searchParams.get("token") ?? "";
  if (actual !== token) {
    throw new DashboardHttpError(403, "Dashboard admin token is required");
  }
}

function sendJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(`${JSON.stringify(body, null, 2)}\n`);
}

function sendHtml(response: ServerResponse, body: string): void {
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(body);
}

function isLocalBindHost(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

function isLoopbackRemote(remoteAddress: string | undefined): boolean {
  return remoteAddress === "127.0.0.1" || remoteAddress === "::1" || remoteAddress === "::ffff:127.0.0.1";
}

function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class DashboardHttpError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message);
    this.name = "DashboardHttpError";
  }
}

function renderDashboardHtml(): string {
  return `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Telegram Local Ingest 운영 대시보드</title>
  <style>
    :root { color-scheme: light; font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #f5f6f8; color: #17202a; }
    body { margin: 0; }
    header { background: #12343b; color: #fff; padding: 18px 24px; display: flex; gap: 16px; align-items: center; justify-content: space-between; }
    h1 { font-size: 20px; margin: 0; letter-spacing: 0; }
    main { max-width: 1280px; margin: 0 auto; padding: 20px; }
    section { margin: 0 0 20px; }
    h2 { font-size: 16px; margin: 0 0 10px; }
    button { border: 1px solid #94a3b8; background: #fff; color: #17202a; border-radius: 6px; padding: 7px 10px; cursor: default; font: inherit; }
    button[data-run], button[data-enable], button[data-runmodule], #refresh, #dispatch { cursor: pointer; }
    button.primary { background: #0f766e; color: #fff; border-color: #0f766e; }
    button.danger { background: #b42318; color: #fff; border-color: #b42318; }
    button:disabled { opacity: 0.55; cursor: not-allowed; }
    table { width: 100%; border-collapse: collapse; background: #fff; border: 1px solid #d7dde5; }
    th, td { text-align: left; vertical-align: top; padding: 9px 10px; border-bottom: 1px solid #e5e9ef; font-size: 13px; }
    th { background: #edf1f5; font-weight: 650; }
    .toolbar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
    .muted { color: #617083; }
    .status { display: inline-block; min-width: 72px; padding: 2px 6px; border-radius: 999px; font-size: 12px; text-align: center; background: #e2e8f0; }
    .ok { background: #d8f3dc; color: #14532d; }
    .bad { background: #ffe4e6; color: #9f1239; }
    .warn { background: #fef3c7; color: #92400e; }
    .actions { display: flex; gap: 6px; flex-wrap: wrap; }
    .table-scroll { overflow: auto; border: 1px solid #d7dde5; background: #fff; }
    .table-scroll table { border: 0; }
    .table-scroll thead th { position: sticky; top: 0; z-index: 1; }
    .runs-scroll { max-height: 720px; }
    pre { white-space: pre-wrap; word-break: break-word; background: #0f172a; color: #e2e8f0; padding: 12px; overflow: auto; max-height: 300px; border-radius: 6px; }
    .grid { display: grid; grid-template-columns: minmax(0, 1fr); gap: 12px; }
    .panel { background: #fff; border: 1px solid #d7dde5; padding: 12px; border-radius: 8px; }
    input { padding: 7px 9px; border-radius: 6px; border: 1px solid #94a3b8; font: inherit; min-width: 240px; }
    a { color: #0f766e; }
  </style>
</head>
<body>
  <header>
    <h1>Telegram Local Ingest 운영 대시보드</h1>
    <div class="toolbar">
      <input id="token" type="password" placeholder="관리 토큰">
      <button id="refresh">새로고침</button>
      <button id="dispatch">예약 실행 처리</button>
    </div>
  </header>
  <main>
    <section>
      <h2>자동화 모듈</h2>
      <div id="modules"></div>
    </section>
    <section>
      <h2>최근 실행 로그</h2>
      <div id="runs"></div>
    </section>
    <section class="grid">
      <div class="panel">
        <h2>실행 상세</h2>
        <div id="detail" class="muted">실행 로그를 선택하세요.</div>
      </div>
    </section>
  </main>
  <script>
    const tokenInput = document.getElementById('token');
    const headers = () => {
      const token = tokenInput.value.trim();
      return token ? {'content-type':'application/json','x-ops-dashboard-token': token} : {'content-type':'application/json'};
    };
    const api = async (url, options = {}) => {
      const res = await fetch(url, {...options, headers: {...headers(), ...(options.headers || {})}});
      const text = await res.text();
      const data = text ? JSON.parse(text) : {};
      if (!res.ok) throw new Error(data.error || res.statusText);
      return data;
    };
    const fmt = (value) => value ? new Date(value).toLocaleString() : '-';
    const esc = (value) => String(value ?? '').replace(/[&<>"]/g, (ch) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[ch]));
    async function load() {
      const state = await api('/api/state');
      renderModules(state.modules || []);
      renderRuns(state.runs || []);
    }
    function renderModules(modules) {
      document.getElementById('modules').innerHTML = '<div class="table-scroll"><table><thead><tr><th>모듈</th><th>상태</th><th>준비도</th><th>스케줄</th><th>최근 실행</th><th>작업</th></tr></thead><tbody>' +
        modules.map((m) => '<tr>' +
          '<td><strong>' + esc(m.title || m.id) + '</strong><br><span class="muted">' + esc(m.id) + '</span><br>' + esc(m.description || '') + '</td>' +
          '<td><span class="status ' + (m.available ? (m.enabled ? 'ok' : 'warn') : 'bad') + '">' + (m.available ? (m.enabled ? '켜짐' : '꺼짐') : '파일 없음') + '</span></td>' +
          '<td>' + (m.readiness?.ready ? '<span class="status ok">준비됨</span>' : '<span class="status bad">환경변수 누락</span><br><span class="muted">' + esc((m.readiness?.missingEnv || []).join(', ')) + '</span>') + '</td>' +
          '<td>' + esc(m.schedule?.type || '-') + '<br><span class="muted">다음 ' + esc(fmt(m.nextDueAt)) + '</span></td>' +
          '<td>' + (m.lastRun ? '<button data-run="' + esc(m.lastRun.id) + '">' + esc(m.lastRun.status) + '</button><br><span class="muted">' + esc(fmt(m.lastRun.startedAt)) + '</span>' : '-') + '</td>' +
          '<td><div class="actions">' +
            '<button data-enable="' + esc(m.id) + '">' + (m.enabled ? '끄기' : '켜기') + '</button>' +
            '<button class="primary" data-runmodule="' + esc(m.id) + '">실행</button>' +
          '</div></td>' +
        '</tr>').join('') + '</tbody></table></div>';
    }
    function renderRuns(runs) {
      document.getElementById('runs').innerHTML = '<div class="table-scroll runs-scroll"><table><thead><tr><th>상태</th><th>실행 ID</th><th>모듈</th><th>시작</th><th>링크</th></tr></thead><tbody>' +
        runs.map((run) => '<tr>' +
          '<td><span class="status ' + (run.status === 'SUCCEEDED' ? 'ok' : run.status === 'FAILED' ? 'bad' : 'warn') + '">' + esc(run.status) + '</span></td>' +
          '<td><button data-run="' + esc(run.id) + '">' + esc(run.id) + '</button></td>' +
          '<td>' + esc(run.moduleId) + '</td>' +
          '<td>' + esc(fmt(run.startedAt)) + '</td>' +
          '<td>' + (run.links?.rawBundlePath ? '<span class="muted">raw</span> ' + esc(run.links.rawBundlePath) : '-') + '</td>' +
        '</tr>').join('') + '</tbody></table></div>';
    }
    async function showRun(id) {
      const detail = await api('/api/runs/' + encodeURIComponent(id));
      document.getElementById('detail').innerHTML = '<div><strong>' + esc(id) + '</strong></div>' +
        '<p>상태: ' + esc(detail.run.status) + ' / exit ' + esc(detail.run.exitCode ?? '-') + '</p>' +
        (detail.links?.rawBundlePath ? '<p>Raw: ' + esc(detail.links.rawBundlePath) + '</p>' : '') +
        (detail.links?.wikiPagePath ? '<p>Wiki: ' + esc(detail.links.wikiPagePath) + '</p>' : '') +
        '<h2>결과 (result.json)</h2><pre>' + esc(detail.resultText || '') + '</pre>' +
        '<h2>표준 출력 (stdout.log)</h2><pre>' + esc(detail.stdout || '') + '</pre>' +
        '<h2>오류 출력 (stderr.log)</h2><pre>' + esc(detail.stderr || '') + '</pre>';
    }
    document.addEventListener('click', async (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      if (target.dataset.run) await showRun(target.dataset.run);
      if (target.dataset.enable) {
        const state = target.textContent === '켜기' ? 'enable' : 'disable';
        await api('/api/modules/' + encodeURIComponent(target.dataset.enable) + '/' + state, {method:'POST', body:'{}'});
        await load();
      }
      if (target.dataset.runmodule) {
        const detail = await api('/api/modules/' + encodeURIComponent(target.dataset.runmodule) + '/run', {method:'POST', body:JSON.stringify({force:true})});
        await load();
        await showRun(detail.run.id);
      }
    });
    document.getElementById('refresh').addEventListener('click', () => load().catch(alert));
    document.getElementById('dispatch').addEventListener('click', async () => { await api('/api/dispatch', {method:'POST', body:JSON.stringify({dryRun:false})}); await load(); });
    load().catch((error) => { document.getElementById('modules').textContent = error.message; });
  </script>
</body>
</html>`;
}

let activeDashboard: StartedOpsDashboard | undefined;

if (import.meta.url === `file://${process.argv[1]}`) {
  startOpsDashboard().then((started) => {
    activeDashboard = started;
    const shutdown = (): void => {
      activeDashboard?.server.close(() => process.exit(0));
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  }).catch((error) => {
    process.stderr.write(`${errorMessage(error)}\n`);
    process.exit(1);
  });
}
