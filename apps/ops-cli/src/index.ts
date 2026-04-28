#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  type AutomationDueWindow,
  type AutomationManifest,
  automationManifestSchema,
  buildAutomationRunId,
  discoverAutomationModules,
  getDueAutomationWindows,
  getNextAutomationDueAt,
  getAutomationReadiness,
  runAutomationModule,
  type DiscoveredAutomationModule,
} from "@telegram-local-ingest/automation-core";
import {
  artifactRequestSchema,
  buildArtifactRunId,
  promoteGeneratedRenderer,
  runArtifactRequest,
  type ArtifactRequest,
} from "@telegram-local-ingest/artifact-core";
import { loadNearestEnvFile } from "@telegram-local-ingest/core";
import {
  completeArtifactRendererRun,
  completeAutomationRun,
  createArtifactRendererRun,
  createAutomationRun,
  getArtifactRendererRun,
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
  upsertAutomationScheduleState,
  upsertAutomationModule,
  type StoredAutomationModule,
  type StoredAutomationRun,
  type StoredAutomationScheduleState,
} from "@telegram-local-ingest/db";

interface RuntimePaths {
  projectRoot: string;
  modulesRoot: string;
  renderersRoot: string;
  vaultRoot?: string;
  runtimeDir: string;
  sqliteDbPath: string;
  automationRunsDir: string;
  derivedIngestCommand?: string;
}

async function main(): Promise<void> {
  const [domain, command, ...args] = process.argv.slice(2);
  if (!domain || domain === "help" || domain === "--help") {
    printHelp();
    return;
  }
  if (domain === "artifact") {
    await handleArtifactCommand(command, args);
    return;
  }
  if (domain !== "automation") {
    throw new Error(`Unknown command domain: ${domain}`);
  }
  await handleAutomationCommand(command, args);
}

async function handleAutomationCommand(command: string | undefined, args: string[]): Promise<void> {
  if (!command || command === "help" || command === "--help") {
    printAutomationHelp();
    return;
  }

  const paths = await resolveRuntimePaths();
  const dbHandle = openIngestDatabase(paths.sqliteDbPath);
  try {
    migrate(dbHandle.db);
    const discovered = await discoverAutomationModules(paths.modulesRoot);
    syncModules(dbHandle.db, discovered);

    if (command === "list") {
      const modules = listAutomationModules(dbHandle.db);
      printModuleList(modules);
      return;
    }
    if (command === "enable" || command === "disable") {
      const id = requiredArg(args, 0, `automation ${command} requires a module id`);
      const updated = setAutomationModuleEnabled(dbHandle.db, id, command === "enable");
      process.stdout.write(`${updated.enabled ? "enabled" : "disabled"} ${updated.id}\n`);
      return;
    }
    if (command === "run") {
      const id = requiredArg(args, 0, "automation run requires a module id");
      const force = args.includes("--force");
      const stored = listAutomationModules(dbHandle.db).find((item) => item.id === id);
      if (!stored) {
        throw new Error(`Automation module not registered: ${id}`);
      }
      if (!stored.available) {
        throw new Error(`Automation module is not available on disk: ${id}`);
      }
      if (!stored.enabled && !force) {
        throw new Error(`Automation module is disabled: ${id}. Re-run with --force for an explicit manual run.`);
      }
      const module = mustFindDiscovered(discovered, id);
      const run = await runAndRecordAutomation(paths, module, "manual", dbHandle.db);
      process.stdout.write(`${run.status.toLowerCase()} ${run.id}\n`);
      process.stdout.write(`stdout=${run.stdoutPath}\n`);
      process.stdout.write(`stderr=${run.stderrPath}\n`);
      process.stdout.write(`result=${run.resultPath}\n`);
      if (run.error) {
        process.stdout.write(`error=${run.error}\n`);
      }
      return;
    }
    if (command === "logs") {
      const id = args[0];
      const runs = listAutomationRuns(dbHandle.db, { ...(id ? { moduleId: id } : {}), limit: 20 });
      printRunList(runs);
      return;
    }
    if (command === "dispatch") {
      await dispatchDueAutomations(paths, discovered, dbHandle.db, args);
      return;
    }
    if (command === "timer") {
      await handleTimerCommand(paths, args);
      return;
    }
    throw new Error(`Unknown automation command: ${command}`);
  } finally {
    dbHandle.close();
  }
}

async function handleArtifactCommand(command: string | undefined, args: string[]): Promise<void> {
  if (!command || command === "help" || command === "--help") {
    printArtifactHelp();
    return;
  }
  const paths = await resolveRuntimePaths();
  const dbHandle = openIngestDatabase(paths.sqliteDbPath);
  try {
    migrate(dbHandle.db);
    if (command === "run") {
      const requestFile = requiredArg(args, 0, "artifact run requires a request JSON file");
      if (!paths.vaultRoot) {
        throw new Error("OBSIDIAN_VAULT_PATH is required for artifact run");
      }
      const request = artifactRequestSchema.parse(JSON.parse(await fs.readFile(requestFile, "utf8")) as unknown);
      const sourcePrompt = getOptionValue(args, "--prompt") ?? request.title;
      const artifactId = localArtifactId(request);
      const runId = buildArtifactRunId(artifactId);
      const runDir = path.join(paths.runtimeDir, "wiki-artifacts", "runs", runId);
      createArtifactRendererRun(dbHandle.db, {
        id: runId,
        artifactId,
        artifactKind: request.artifactKind,
        rendererMode: request.renderer.mode,
        ...(request.renderer.mode === "registered" ? { rendererId: request.renderer.id } : {}),
        ...(request.renderer.mode === "generated" ? { rendererLanguage: request.renderer.language } : {}),
        sourcePrompt,
        request,
        runDir,
        outputDir: path.join(runDir, "outputs"),
        stdoutPath: path.join(runDir, "stdout.log"),
        stderrPath: path.join(runDir, "stderr.log"),
        resultPath: path.join(runDir, "result.json"),
      });
      try {
        const result = await runArtifactRequest({
          request,
          runId,
          vaultRoot: paths.vaultRoot,
          runtimeDir: paths.runtimeDir,
          sourcePrompt,
          rendererRegistryRoot: paths.renderersRoot,
          ...(paths.derivedIngestCommand ? { ingestDerivedCommand: paths.derivedIngestCommand } : {}),
          allowGeneratedRenderers: process.env.WIKI_ARTIFACT_ALLOW_GENERATED_RENDERERS !== "0",
          env: process.env,
        });
        completeArtifactRendererRun(dbHandle.db, {
          id: runId,
          status: "SUCCEEDED",
          derivedBundlePath: result.derivedBundlePath,
          ...(result.wikiPageRelative ? { wikiPagePath: path.join(paths.vaultRoot, "wiki", result.wikiPageRelative) } : {}),
          endedAt: result.endedAt,
        });
        process.stdout.write(`succeeded ${runId}\n`);
        process.stdout.write(`bundle=${result.derivedBundlePath}\n`);
        for (const artifact of result.artifacts) {
          process.stdout.write(`artifact=${artifact.path}\n`);
        }
      } catch (error) {
        completeArtifactRendererRun(dbHandle.db, {
          id: runId,
          status: "FAILED",
          error: errorMessage(error),
        });
        throw error;
      }
      return;
    }
    if (command === "logs") {
      printArtifactRunList(listArtifactRendererRuns(dbHandle.db, 30));
      return;
    }
    if (command === "promote") {
      const runId = requiredArg(args, 0, "artifact promote requires a run id");
      const run = getArtifactRendererRun(dbHandle.db, runId);
      if (!run) {
        throw new Error(`Artifact run not found: ${runId}`);
      }
      const request = artifactRequestSchema.parse(run.request);
      const rendererId = getOptionValue(args, "--id");
      const promoted = await promoteGeneratedRenderer({
        runDir: run.runDir,
        request,
        targetRoot: paths.renderersRoot,
        ...(rendererId ? { rendererId } : {}),
      });
      markArtifactRendererRunPromoted(dbHandle.db, runId, promoted.rendererId);
      process.stdout.write(`promoted ${runId} -> ${promoted.rendererId}\n`);
      process.stdout.write(`renderer=${promoted.rendererDir}\n`);
      return;
    }
    throw new Error(`Unknown artifact command: ${command}`);
  } finally {
    dbHandle.close();
  }
}

async function runAndRecordAutomation(
  paths: RuntimePaths,
  module: DiscoveredAutomationModule,
  trigger: string,
  db: Parameters<typeof createAutomationRun>[0],
  options: { idempotencyKey?: string; scheduledAt?: string } = {},
): Promise<ReturnType<typeof completeAutomationRun>> {
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

async function dispatchDueAutomations(
  paths: RuntimePaths,
  discovered: DiscoveredAutomationModule[],
  db: Parameters<typeof createAutomationRun>[0],
  args: string[],
): Promise<void> {
  const now = new Date(getOptionValue(args, "--now") ?? Date.now());
  if (Number.isNaN(now.getTime())) {
    throw new Error("automation dispatch --now must be an ISO timestamp");
  }
  const maxCatchUp = Number.parseInt(getOptionValue(args, "--max-catch-up") ?? "10", 10);
  if (!Number.isInteger(maxCatchUp) || maxCatchUp < 1) {
    throw new Error("automation dispatch --max-catch-up must be a positive integer");
  }
  const dryRun = args.includes("--dry-run");
  const discoveredById = new Map(discovered.map((module) => [module.manifest.id, module]));
  const modules = listAutomationModules(db).filter((module) => module.enabled && module.available);
  let dueCount = 0;
  let runCount = 0;
  let skippedCount = 0;

  for (const stored of modules) {
    const module = discoveredById.get(stored.id);
    if (!module) {
      skippedCount += 1;
      process.stdout.write(`skip ${stored.id} missing-on-disk\n`);
      continue;
    }
    const manifest = automationManifestSchema.parse(stored.manifest);
    if (manifest.schedule.type === "manual") {
      continue;
    }
    const state = getAutomationScheduleState(db, stored.id);
    const windows = getDueAutomationWindows(manifest, state ?? {}, now, maxCatchUp);
    if (windows.length === 0) {
      if (!dryRun) {
        ensureFutureScheduleState(db, manifest, state, now);
      }
      continue;
    }

    for (const window of windows) {
      dueCount += 1;
      const existing = getAutomationRunByIdempotency(db, stored.id, window.idempotencyKey);
      if (existing) {
        skippedCount += 1;
        if (!dryRun) {
          recordScheduleWindow(db, manifest, state, window, existing, now);
        }
        process.stdout.write(`skip ${stored.id} ${window.scheduleKey} existing=${existing.status.toLowerCase()}\n`);
        continue;
      }
      if (dryRun) {
        process.stdout.write(`due ${stored.id} ${window.scheduleKey} at=${window.dueAt}\n`);
        continue;
      }
      const run = await runAndRecordAutomation(paths, module, "scheduled", db, {
        idempotencyKey: window.idempotencyKey,
        scheduledAt: window.dueAt,
      });
      recordScheduleWindow(db, manifest, getAutomationScheduleState(db, stored.id), window, run, now);
      runCount += 1;
      process.stdout.write(`${run.status.toLowerCase()} ${run.id} ${stored.id} ${window.scheduleKey}\n`);
    }
  }

  if (dueCount === 0) {
    process.stdout.write("No automation modules due.\n");
    return;
  }
  process.stdout.write(`dispatch complete due=${dueCount} ran=${runCount} skipped=${skippedCount}\n`);
}

function ensureFutureScheduleState(
  db: Parameters<typeof upsertAutomationScheduleState>[0],
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
  db: Parameters<typeof upsertAutomationScheduleState>[0],
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

async function handleTimerCommand(paths: RuntimePaths, args: string[]): Promise<void> {
  const [subcommand, ...rest] = args;
  if (!subcommand || subcommand === "help" || subcommand === "--help") {
    printTimerHelp();
    return;
  }
  const timerPaths = resolveSystemdTimerPaths();
  if (subcommand === "install") {
    const intervalMinutes = Number.parseInt(getOptionValue(rest, "--interval-minutes") ?? "15", 10);
    if (!Number.isInteger(intervalMinutes) || intervalMinutes < 1) {
      throw new Error("automation timer install --interval-minutes must be a positive integer");
    }
    await fs.mkdir(timerPaths.dir, { recursive: true });
    await fs.writeFile(timerPaths.servicePath, renderAutomationService(paths.projectRoot), "utf8");
    await fs.writeFile(timerPaths.timerPath, renderAutomationTimer(intervalMinutes), "utf8");
    process.stdout.write(`installed ${timerPaths.servicePath}\n`);
    process.stdout.write(`installed ${timerPaths.timerPath}\n`);
    process.stdout.write("run: systemctl --user daemon-reload && systemctl --user enable --now telegram-local-ingest-automation.timer\n");
    return;
  }
  if (subcommand === "uninstall") {
    await fs.rm(timerPaths.servicePath, { force: true });
    await fs.rm(timerPaths.timerPath, { force: true });
    process.stdout.write(`removed ${timerPaths.servicePath}\n`);
    process.stdout.write(`removed ${timerPaths.timerPath}\n`);
    process.stdout.write("run: systemctl --user daemon-reload\n");
    return;
  }
  if (subcommand === "status") {
    const serviceExists = await pathExists(timerPaths.servicePath);
    const timerExists = await pathExists(timerPaths.timerPath);
    process.stdout.write(`service=${serviceExists ? "installed" : "missing"} ${timerPaths.servicePath}\n`);
    process.stdout.write(`timer=${timerExists ? "installed" : "missing"} ${timerPaths.timerPath}\n`);
    return;
  }
  throw new Error(`Unknown automation timer command: ${subcommand}`);
}

function syncModules(db: Parameters<typeof upsertAutomationModule>[0], modules: DiscoveredAutomationModule[]): void {
  for (const module of modules) {
    const existing = listAutomationModules(db).find((item) => item.id === module.manifest.id);
    upsertAutomationModule(db, {
      id: module.manifest.id,
      manifest: module.manifest,
      enabled: existing?.enabled ?? module.manifest.defaultEnabled,
    });
  }
  markAutomationModulesUnavailableExcept(db, modules.map((module) => module.manifest.id));
}

async function resolveRuntimePaths(): Promise<RuntimePaths> {
  const projectRoot = await findProjectRoot(process.cwd());
  loadNearestEnvFile(projectRoot);
  const runtimeDir = path.resolve(projectRoot, process.env.INGEST_RUNTIME_DIR ?? "runtime");
  const sqliteDbPath = path.resolve(projectRoot, process.env.SQLITE_DB_PATH ?? path.join(runtimeDir, "ingest.db"));
  const vaultRoot = process.env.OBSIDIAN_VAULT_PATH?.trim()
    ? path.resolve(process.env.OBSIDIAN_VAULT_PATH)
    : undefined;
  return {
    projectRoot,
    runtimeDir,
    sqliteDbPath,
    modulesRoot: path.resolve(projectRoot, process.env.AUTOMATION_MODULES_DIR ?? "automations"),
    renderersRoot: path.resolve(vaultRoot ?? projectRoot, process.env.WIKI_RENDERERS_DIR ?? "renderers"),
    automationRunsDir: path.resolve(projectRoot, process.env.AUTOMATION_RUNS_DIR ?? path.join(runtimeDir, "automation", "runs")),
    ...(vaultRoot ? { vaultRoot } : {}),
    ...(process.env.WIKI_DERIVED_INGEST_COMMAND?.trim() ? { derivedIngestCommand: process.env.WIKI_DERIVED_INGEST_COMMAND.trim() } : {}),
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
      // continue upward
    }
    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error("Could not find telegram-local-ingest project root");
    }
    current = parent;
  }
}

function printModuleList(modules: StoredAutomationModule[]): void {
  if (modules.length === 0) {
    process.stdout.write("No automation modules registered.\n");
    return;
  }
  for (const module of modules) {
    const manifest = automationManifestSchema.parse(module.manifest);
    const readiness = getAutomationReadiness(manifest);
    const readyLabel = readiness.ready ? "ready" : `missing-env:${readiness.missingEnv.join(",")}`;
    const state = module.available ? (module.enabled ? "on" : "off") : "missing";
    process.stdout.write(`${state} ${module.id} ${readyLabel} ${manifest.title ?? ""}\n`);
  }
}

function printRunList(runs: ReturnType<typeof listAutomationRuns>): void {
  if (runs.length === 0) {
    process.stdout.write("No automation runs recorded.\n");
    return;
  }
  for (const run of runs) {
    process.stdout.write(`${run.status.toLowerCase()} ${run.id} ${run.moduleId} ${run.startedAt} exit=${run.exitCode ?? "-"}\n`);
  }
}

function printArtifactRunList(runs: ReturnType<typeof listArtifactRendererRuns>): void {
  if (runs.length === 0) {
    process.stdout.write("No artifact renderer runs recorded.\n");
    return;
  }
  for (const run of runs) {
    const promoted = run.promotedRendererId ? ` promoted=${run.promotedRendererId}` : "";
    process.stdout.write(`${run.status.toLowerCase()} ${run.id} ${run.rendererMode} ${run.artifactKind} ${run.artifactId}${promoted}\n`);
  }
}

function mustFindDiscovered(modules: DiscoveredAutomationModule[], id: string): DiscoveredAutomationModule {
  const found = modules.find((module) => module.manifest.id === id);
  if (!found) {
    throw new Error(`Automation module not found: ${id}`);
  }
  return found;
}

function requiredArg(args: string[], index: number, message: string): string {
  const value = args[index];
  if (!value || value.startsWith("--")) {
    throw new Error(message);
  }
  return value;
}

function getOptionValue(args: string[], name: string): string | undefined {
  const equalsPrefix = `${name}=`;
  const equalsValue = args.find((arg) => arg.startsWith(equalsPrefix));
  if (equalsValue) {
    return equalsValue.slice(equalsPrefix.length);
  }
  const index = args.indexOf(name);
  if (index === -1) {
    return undefined;
  }
  const value = args[index + 1];
  return value && !value.startsWith("--") ? value : undefined;
}

function resolveSystemdTimerPaths(): { dir: string; servicePath: string; timerPath: string } {
  const configHome = process.env.XDG_CONFIG_HOME
    ? path.resolve(process.env.XDG_CONFIG_HOME)
    : path.join(os.homedir(), ".config");
  const dir = path.join(configHome, "systemd", "user");
  return {
    dir,
    servicePath: path.join(dir, "telegram-local-ingest-automation.service"),
    timerPath: path.join(dir, "telegram-local-ingest-automation.timer"),
  };
}

function renderAutomationService(projectRoot: string): string {
  return [
    "[Unit]",
    "Description=Telegram Local Ingest automation dispatcher",
    "",
    "[Service]",
    "Type=oneshot",
    `WorkingDirectory=${projectRoot}`,
    `ExecStart=/usr/bin/env bash -lc ${shellQuote("npm run tlgi -- automation dispatch")}`,
    "",
  ].join("\n");
}

function renderAutomationTimer(intervalMinutes: number): string {
  return [
    "[Unit]",
    "Description=Run Telegram Local Ingest automation dispatcher",
    "",
    "[Timer]",
    "OnBootSec=2min",
    `OnUnitActiveSec=${intervalMinutes}min`,
    "Unit=telegram-local-ingest-automation.service",
    "Persistent=true",
    "",
    "[Install]",
    "WantedBy=timers.target",
    "",
  ].join("\n");
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function localArtifactId(request: ArtifactRequest): string {
  const suggested = request.renderer.mode === "generated" ? request.renderer.suggestedId : undefined;
  const raw = request.artifactId ?? suggested ?? request.title;
  return raw.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "") || "artifact";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function printHelp(): void {
  process.stdout.write([
    "telegram-local-ingest ops CLI",
    "",
    "Usage:",
    "  npm run tlgi -- automation <command>",
    "  npm run tlgi -- artifact <command>",
    "",
    "Commands:",
    "  automation list",
    "  automation enable <id>",
    "  automation disable <id>",
    "  automation run <id> [--force]",
    "  automation logs [id]",
    "  automation dispatch [--dry-run] [--now ISO] [--max-catch-up N]",
    "  automation timer install [--interval-minutes N]",
    "  automation timer uninstall",
    "  automation timer status",
    "  artifact run <request.json> [--prompt <text>]",
    "  artifact logs",
    "  artifact promote <run_id> [--id <renderer.id>]",
    "",
  ].join("\n"));
}

function printAutomationHelp(): void {
  printHelp();
}

function printArtifactHelp(): void {
  process.stdout.write([
    "Usage:",
    "  npm run tlgi -- artifact run <request.json> [--prompt <text>]",
    "  npm run tlgi -- artifact logs",
    "  npm run tlgi -- artifact promote <run_id> [--id <renderer.id>]",
    "",
  ].join("\n"));
}

function printTimerHelp(): void {
  process.stdout.write([
    "Usage:",
    "  npm run tlgi -- automation timer install [--interval-minutes N]",
    "  npm run tlgi -- automation timer uninstall",
    "  npm run tlgi -- automation timer status",
    "",
  ].join("\n"));
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
