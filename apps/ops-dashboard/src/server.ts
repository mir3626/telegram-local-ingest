import http, { type IncomingMessage, type ServerResponse } from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { DatabaseSync } from "node:sqlite";

import { renderDashboardHtml } from "./dashboard-page.js";
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
import {
  artifactRequestSchema,
  promoteGeneratedRenderer,
} from "@telegram-local-ingest/artifact-core";
import { loadNearestEnvFile } from "@telegram-local-ingest/core";
import {
  completeAutomationRun,
  createAutomationRun,
  getArtifactRendererRun,
  getAutomationRun,
  getAutomationRunByIdempotency,
  getAutomationScheduleState,
  listArtifactRendererRuns,
  listAutomationModules,
  listAutomationRuns,
  markArtifactRendererRunPromoted,
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
  renderersRoot: string;
  runtimeDir: string;
  logsDir: string;
  sqliteDbPath: string;
  automationRunsDir: string;
  artifactRunsDir: string;
  vaultRoot?: string;
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
const LOG_TAIL_DEFAULT_BYTES = 32_000;
const LOG_TAIL_MAX_BYTES = 160_000;
const SSE_STATE_INTERVAL_MS = 3_000;
const SSE_LOG_INTERVAL_MS = 1_000;
const SSE_PING_INTERVAL_MS = 15_000;
const MAX_SSE_LOG_TARGETS = 8;

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
    if (request.method === "GET" && url.pathname === "/api/logs/tail") {
      assertAdminRequest(context, request, url);
      sendJson(response, 200, await readLogTailRequest(context, url));
      return;
    }
    if (request.method === "GET" && url.pathname === "/events") {
      assertAdminRequest(context, request, url);
      streamDashboardEvents(context, request, response, url);
      return;
    }
    if (request.method === "GET" && url.pathname.startsWith("/api/runs/")) {
      const id = decodeURIComponent(url.pathname.slice("/api/runs/".length));
      sendJson(response, 200, await readRunDetail(context, id));
      return;
    }
    if (request.method === "GET" && url.pathname.startsWith("/api/artifacts/runs/")) {
      const id = decodeURIComponent(url.pathname.slice("/api/artifacts/runs/".length));
      sendJson(response, 200, await readArtifactRunDetail(context, id));
      return;
    }
    const artifactPromote = url.pathname.match(/^\/api\/artifacts\/runs\/([^/]+)\/promote$/);
    if (request.method === "POST" && artifactPromote) {
      assertAdminRequest(context, request, url);
      const id = decodeURIComponent(artifactPromote[1] ?? "");
      const body = await readJsonBody(request);
      sendJson(response, 200, await promoteArtifactRun(context, id, typeof body.rendererId === "string" ? body.rendererId : undefined));
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
    const artifactRuns = listArtifactRendererRuns(db, RECENT_RUN_LIMIT);
    return {
      project: {
        root: context.paths.projectRoot,
        sqliteDbPath: context.paths.sqliteDbPath,
        modulesRoot: context.paths.modulesRoot,
        renderersRoot: context.paths.renderersRoot,
        logsDir: context.paths.logsDir,
      },
      modules,
      runs,
      artifactRuns,
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

async function readArtifactRunDetail(context: DashboardContext, runId: string): Promise<unknown> {
  const dbHandle = openIngestDatabase(context.paths.sqliteDbPath);
  try {
    migrate(dbHandle.db);
    const run = getArtifactRendererRun(dbHandle.db, runId);
    if (!run) {
      throw new Error(`Artifact renderer run not found: ${runId}`);
    }
    const [stdout, stderr, resultText, generatedCode] = await Promise.all([
      readSafeRunText(context.paths.artifactRunsDir, run.stdoutPath),
      readSafeRunText(context.paths.artifactRunsDir, run.stderrPath),
      readSafeRunText(context.paths.artifactRunsDir, run.resultPath),
      readGeneratedRendererCode(context.paths.artifactRunsDir, run.runDir),
    ]);
    return {
      run,
      stdout,
      stderr,
      resultText,
      result: parseJson(resultText),
      generatedCode,
    };
  } finally {
    dbHandle.close();
  }
}

interface ResolvedLogTarget {
  target: string;
  label: string;
  path: string;
  root: string;
}

interface LogTailResult {
  target: string;
  label: string;
  path: string;
  cursor: number;
  chunk: string;
  bytesRead: number;
  reset: boolean;
  truncated: boolean;
  missing: boolean;
}

async function readLogTailRequest(context: DashboardContext, url: URL): Promise<LogTailResult> {
  const target = url.searchParams.get("target")?.trim() || "worker";
  const cursorValue = url.searchParams.get("cursor");
  const maxBytesValue = url.searchParams.get("maxBytes");
  const cursor = cursorValue === null || cursorValue === ""
    ? undefined
    : Number.parseInt(cursorValue, 10);
  const maxBytes = maxBytesValue === null || maxBytesValue === ""
    ? undefined
    : Number.parseInt(maxBytesValue, 10);
  const options: { cursor?: number; maxBytes?: number } = {};
  if (typeof cursor === "number" && Number.isFinite(cursor)) {
    options.cursor = cursor;
  }
  if (typeof maxBytes === "number" && Number.isFinite(maxBytes)) {
    options.maxBytes = maxBytes;
  }
  return await readLogTail(context, target, options);
}

async function streamDashboardEvents(
  context: DashboardContext,
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
): Promise<void> {
  const targets = parseSseLogTargets(url);
  const logStates = new Map<string, { cursor: number; missing: boolean }>();
  let closed = false;
  let stateInFlight = false;
  let logsInFlight = false;
  let lastStateJson = "";

  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store, no-transform",
    "connection": "keep-alive",
    "x-accel-buffering": "no",
  });
  response.write(": connected\n\n");

  const sendEvent = (event: string, data: unknown): void => {
    if (closed || response.destroyed) {
      return;
    }
    response.write(`event: ${event}\n`);
    response.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  const sendState = async (force = false): Promise<void> => {
    if (stateInFlight || closed) {
      return;
    }
    stateInFlight = true;
    try {
      const state = await readDashboardState(context);
      const stateJson = JSON.stringify(state);
      if (force || stateJson !== lastStateJson) {
        lastStateJson = stateJson;
        sendEvent("state", { at: new Date().toISOString(), state });
      }
    } catch (error) {
      sendEvent("error", { message: errorMessage(error) });
    } finally {
      stateInFlight = false;
    }
  };

  const sendLogs = async (): Promise<void> => {
    if (logsInFlight || closed) {
      return;
    }
    logsInFlight = true;
    try {
      for (const target of targets) {
        const previous = logStates.get(target);
        try {
          const tail = await readLogTail(context, target, {
            ...(previous ? { cursor: previous.cursor } : {}),
            maxBytes: LOG_TAIL_DEFAULT_BYTES,
          });
          const changed = tail.chunk.length > 0
            || tail.reset
            || tail.truncated
            || tail.missing !== (previous?.missing ?? false);
          logStates.set(target, { cursor: tail.cursor, missing: tail.missing });
          if (changed) {
            sendEvent("log", tail);
          }
        } catch (error) {
          sendEvent("log-error", { target, message: errorMessage(error) });
        }
      }
    } finally {
      logsInFlight = false;
    }
  };

  const stateTimer = setInterval(() => {
    void sendState();
  }, SSE_STATE_INTERVAL_MS);
  const logTimer = setInterval(() => {
    void sendLogs();
  }, SSE_LOG_INTERVAL_MS);
  const pingTimer = setInterval(() => {
    sendEvent("ping", { at: new Date().toISOString() });
  }, SSE_PING_INTERVAL_MS);
  const cleanup = (): void => {
    if (closed) {
      return;
    }
    closed = true;
    clearInterval(stateTimer);
    clearInterval(logTimer);
    clearInterval(pingTimer);
  };
  request.once("close", cleanup);
  response.once("close", cleanup);

  await sendState(true);
  await sendLogs();
}

function parseSseLogTargets(url: URL): string[] {
  const values = [
    ...url.searchParams.getAll("target"),
    ...(url.searchParams.get("targets") ?? "").split(","),
  ];
  const targets = values
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  const unique = Array.from(new Set(targets));
  return (unique.length > 0 ? unique : ["worker"]).slice(0, MAX_SSE_LOG_TARGETS);
}

async function readLogTail(
  context: DashboardContext,
  target: string,
  options: { cursor?: number; maxBytes?: number } = {},
): Promise<LogTailResult> {
  const resolved = await resolveLogTarget(context, target);
  const maxBytes = clampInteger(options.maxBytes ?? LOG_TAIL_DEFAULT_BYTES, 1_024, LOG_TAIL_MAX_BYTES);
  let stat;
  try {
    stat = await fs.stat(resolved.path);
  } catch (error) {
    if (isNotFoundError(error)) {
      return {
        target: resolved.target,
        label: resolved.label,
        path: resolved.path,
        cursor: 0,
        chunk: "",
        bytesRead: 0,
        reset: false,
        truncated: false,
        missing: true,
      };
    }
    throw error;
  }
  if (!stat.isFile()) {
    throw new DashboardHttpError(404, `Log target is not a file: ${target}`);
  }
  const size = stat.size;
  const requestedCursor = options.cursor;
  let start = typeof requestedCursor === "number" && Number.isFinite(requestedCursor)
    ? Math.max(0, Math.floor(requestedCursor))
    : Math.max(0, size - maxBytes);
  let reset = false;
  let truncated = typeof requestedCursor !== "number" && start > 0;
  if (start > size) {
    reset = true;
    start = Math.max(0, size - maxBytes);
    truncated = start > 0;
  } else if (size - start > maxBytes) {
    start = Math.max(0, size - maxBytes);
    truncated = true;
  }
  const length = Math.max(0, size - start);
  if (length === 0) {
    return {
      target: resolved.target,
      label: resolved.label,
      path: resolved.path,
      cursor: size,
      chunk: "",
      bytesRead: 0,
      reset,
      truncated,
      missing: false,
    };
  }
  const file = await fs.open(resolved.path, "r");
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await file.read(buffer, 0, length, start);
    return {
      target: resolved.target,
      label: resolved.label,
      path: resolved.path,
      cursor: size,
      chunk: buffer.subarray(0, bytesRead).toString("utf8"),
      bytesRead,
      reset,
      truncated,
      missing: false,
    };
  } finally {
    await file.close();
  }
}

async function resolveLogTarget(context: DashboardContext, target: string): Promise<ResolvedLogTarget> {
  const normalized = target.trim();
  const namedLogs: Record<string, { label: string; fileName: string }> = {
    "worker": { label: "Worker", fileName: "worker.log" },
    "bot-api": { label: "Telegram Bot API", fileName: "bot-api.log" },
    "ops-dashboard": { label: "Ops Dashboard", fileName: "ops-dashboard.log" },
  };
  const named = namedLogs[normalized];
  if (named) {
    return makeResolvedLogTarget(normalized, named.label, context.paths.logsDir, path.join(context.paths.logsDir, named.fileName));
  }
  const automation = normalized.match(/^automation:([^:]+):(stdout|stderr)$/);
  if (automation) {
    const runId = automation[1] ?? "";
    const stream = automation[2] as "stdout" | "stderr";
    const dbHandle = openIngestDatabase(context.paths.sqliteDbPath);
    try {
      migrate(dbHandle.db);
      const run = getAutomationRun(dbHandle.db, runId);
      if (!run) {
        throw new DashboardHttpError(404, `Automation run not found: ${runId}`);
      }
      const targetPath = stream === "stdout" ? run.stdoutPath : run.stderrPath;
      return makeResolvedLogTarget(normalized, `Automation ${stream}: ${runId}`, context.paths.automationRunsDir, targetPath);
    } finally {
      dbHandle.close();
    }
  }
  const artifact = normalized.match(/^artifact:([^:]+):(stdout|stderr)$/);
  if (artifact) {
    const runId = artifact[1] ?? "";
    const stream = artifact[2] as "stdout" | "stderr";
    const dbHandle = openIngestDatabase(context.paths.sqliteDbPath);
    try {
      migrate(dbHandle.db);
      const run = getArtifactRendererRun(dbHandle.db, runId);
      if (!run) {
        throw new DashboardHttpError(404, `Artifact renderer run not found: ${runId}`);
      }
      const targetPath = stream === "stdout" ? run.stdoutPath : run.stderrPath;
      return makeResolvedLogTarget(normalized, `Artifact ${stream}: ${runId}`, context.paths.artifactRunsDir, targetPath);
    } finally {
      dbHandle.close();
    }
  }
  throw new DashboardHttpError(400, `Unsupported log target: ${target}`);
}

function makeResolvedLogTarget(target: string, label: string, root: string, targetPath: string): ResolvedLogTarget {
  const resolvedRoot = path.resolve(root);
  const resolvedPath = path.resolve(targetPath);
  if (!isPathInside(resolvedRoot, resolvedPath)) {
    throw new DashboardHttpError(403, `Log target is outside allowed root: ${target}`);
  }
  return { target, label, root: resolvedRoot, path: resolvedPath };
}

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.max(min, Math.min(max, Math.floor(value)));
}

async function promoteArtifactRun(context: DashboardContext, runId: string, rendererId?: string): Promise<unknown> {
  const dbHandle = openIngestDatabase(context.paths.sqliteDbPath);
  try {
    migrate(dbHandle.db);
    const run = getArtifactRendererRun(dbHandle.db, runId);
    if (!run) {
      throw new Error(`Artifact renderer run not found: ${runId}`);
    }
    const request = artifactRequestSchema.parse(run.request);
    const promoted = await promoteGeneratedRenderer({
      runDir: run.runDir,
      request,
      targetRoot: context.paths.renderersRoot,
      ...(rendererId ? { rendererId } : {}),
    });
    const updated = markArtifactRendererRunPromoted(dbHandle.db, runId, promoted.rendererId);
    return { run: updated, promoted };
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

async function readGeneratedRendererCode(runsRoot: string, runDir: string): Promise<string> {
  const generatedDir = path.join(runDir, "generated");
  for (const fileName of ["render.py", "render.mjs"]) {
    const candidate = path.join(generatedDir, fileName);
    if (!isPathInside(runsRoot, candidate)) {
      continue;
    }
    try {
      const text = await fs.readFile(candidate, "utf8");
      return text.length > MAX_LOG_CHARS ? `${text.slice(0, MAX_LOG_CHARS)}\n[truncated]` : text;
    } catch (error) {
      if (!isNotFoundError(error)) {
        return `[unavailable: ${errorMessage(error)}]`;
      }
    }
  }
  return "";
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
  const logsDir = path.resolve(projectRoot, env.INGEST_LOG_DIR ?? path.join(runtimeDir, "logs"));
  const sqliteDbPath = path.resolve(projectRoot, env.SQLITE_DB_PATH ?? path.join(runtimeDir, "ingest.db"));
  const vaultRoot = env.OBSIDIAN_VAULT_PATH?.trim() ? path.resolve(env.OBSIDIAN_VAULT_PATH) : undefined;
  return {
    projectRoot,
    runtimeDir,
    logsDir,
    sqliteDbPath,
    modulesRoot: path.resolve(projectRoot, env.AUTOMATION_MODULES_DIR ?? "automations"),
    renderersRoot: path.resolve(vaultRoot ?? projectRoot, env.WIKI_RENDERERS_DIR ?? "renderers"),
    automationRunsDir: path.resolve(projectRoot, env.AUTOMATION_RUNS_DIR ?? path.join(runtimeDir, "automation", "runs")),
    artifactRunsDir: path.resolve(projectRoot, env.WIKI_ARTIFACT_RUNS_DIR ?? path.join(runtimeDir, "wiki-artifacts", "runs")),
    ...(vaultRoot ? { vaultRoot } : {}),
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

function isNotFoundError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

class DashboardHttpError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message);
    this.name = "DashboardHttpError";
  }
}

