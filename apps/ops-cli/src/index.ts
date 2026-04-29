#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";

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
  appendJobEvent,
  completeArtifactRendererRun,
  completeAutomationRun,
  createArtifactRendererRun,
  createAutomationRun,
  createVaultTombstone,
  getArtifactRendererRun,
  getAutomationRunByIdempotency,
  getAutomationScheduleState,
  getJob,
  getSourceBundleForJob,
  listArtifactRendererRuns,
  listAllJobOutputs,
  listAutomationModules,
  listAutomationRuns,
  listSourceBundles,
  listVaultTombstones,
  markJobOutputDeleted,
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
  type StoredArtifactRendererRun,
  type StoredJobOutput,
  type StoredSourceBundle,
  type StoredVaultTombstone,
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

type VaultIssueSeverity = "error" | "warn" | "info";

interface VaultReconcileIssue {
  severity: VaultIssueSeverity;
  code: string;
  status: "missing" | "orphan" | "deleted";
  targetType: string;
  targetId: string;
  path: string;
  message: string;
}

interface VaultReconcileReport {
  checkedAt: string;
  issues: VaultReconcileIssue[];
  summary: Record<VaultIssueSeverity, number>;
}

interface ManagedDeletePath {
  path: string;
  kind: "file" | "directory";
  required?: boolean;
}

interface ManagedDeletePlan {
  targetType: "source_bundle" | "derived_artifact";
  targetId: string;
  jobId?: string;
  paths: ManagedDeletePath[];
  metadata: Record<string, unknown>;
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
  if (domain === "vault") {
    await handleVaultCommand(command, args);
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

async function handleVaultCommand(command: string | undefined, args: string[]): Promise<void> {
  if (!command || command === "help" || command === "--help") {
    printVaultHelp();
    return;
  }
  const paths = await resolveRuntimePaths();
  if (!paths.vaultRoot) {
    throw new Error("OBSIDIAN_VAULT_PATH is required for vault commands");
  }
  const vaultPaths: RuntimePaths & { vaultRoot: string } = {
    ...paths,
    vaultRoot: paths.vaultRoot,
  };
  const dbHandle = openIngestDatabase(paths.sqliteDbPath);
  try {
    migrate(dbHandle.db);
    if (command === "reconcile") {
      const limit = parsePositiveInteger(getOptionValue(args, "--limit") ?? "10000", "--limit");
      const report = await buildVaultReconcileReport(vaultPaths, dbHandle.db, limit);
      if (args.includes("--json")) {
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
        return;
      }
      printVaultReconcileReport(report);
      return;
    }
    if (command === "delete") {
      const identifier = requiredArg(args, 0, "vault delete requires a job, source bundle, artifact run, or artifact id");
      const reason = getOptionValue(args, "--reason") ?? "operator managed delete";
      const apply = args.includes("--apply");
      const plan = await buildManagedDeletePlan(vaultPaths, dbHandle.db, identifier);
      if (args.includes("--json")) {
        const result = apply
          ? await applyManagedDeletePlan(vaultPaths, dbHandle.db, plan, reason)
          : { applied: false, plan };
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        return;
      }
      if (!apply) {
        process.stdout.write(`dry-run managed delete ${plan.targetType} ${plan.targetId}\n`);
        for (const item of plan.paths) {
          process.stdout.write(`${item.kind} ${item.path}\n`);
        }
        process.stdout.write("Re-run with --apply to delete files and record a SQLite tombstone.\n");
        return;
      }
      const result = await applyManagedDeletePlan(vaultPaths, dbHandle.db, plan, reason);
      process.stdout.write(`applied managed delete ${plan.targetType} ${plan.targetId}\n`);
      process.stdout.write(`deleted=${result.deleted.length} missing=${result.missing.length} tombstone=${result.tombstone.id}\n`);
      return;
    }
    throw new Error(`Unknown vault command: ${command}`);
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

async function buildVaultReconcileReport(
  paths: RuntimePaths & { vaultRoot: string },
  db: DatabaseSync,
  limit: number,
): Promise<VaultReconcileReport> {
  const checkedAt = new Date().toISOString();
  const issues: VaultReconcileIssue[] = [];
  const tombstones = listVaultTombstones(db, limit);
  const tombstoneIndex = buildTombstoneIndex(tombstones);
  const sourceBundles = listSourceBundles(db, limit);
  const outputs = listAllJobOutputs(db, limit);
  const automationRuns = listAutomationRuns(db, { limit });
  const artifactRuns = listArtifactRendererRuns(db, limit);

  const expectedRawBundlePaths = new Set<string>();
  const expectedWikiSourcePaths = new Set<string>();
  const expectedDerivedBundlePaths = new Set<string>();
  const expectedWikiDerivedPaths = new Set<string>();

  for (const bundle of sourceBundles) {
    const bundlePath = resolveStoredVaultPath(paths, bundle.bundlePath);
    const manifestPath = resolveStoredVaultPath(paths, bundle.manifestPath);
    const sourceMarkdownPath = resolveStoredVaultPath(paths, bundle.sourceMarkdownPath);
    const finalizedPath = path.join(bundlePath, ".finalized");
    const wikiSourcePath = expectedWikiSourcePath(paths, bundle.id);
    expectedRawBundlePaths.add(bundlePath);
    expectedWikiSourcePaths.add(wikiSourcePath);
    await addMissingIssue(issues, tombstoneIndex, "source_bundle", bundle.id, bundlePath, "error", "raw bundle directory is missing");
    await addMissingIssue(issues, tombstoneIndex, "source_bundle", bundle.id, manifestPath, "error", "raw bundle manifest is missing");
    await addMissingIssue(issues, tombstoneIndex, "source_bundle", bundle.id, sourceMarkdownPath, "error", "raw bundle source.md is missing");
    await addMissingIssue(issues, tombstoneIndex, "source_bundle", bundle.id, finalizedPath, "warn", "raw bundle .finalized marker is missing");
    await addMissingIssue(issues, tombstoneIndex, "source_bundle", bundle.id, wikiSourcePath, "warn", "wiki source page is missing");
  }

  const seenAutomationBundles = new Set<string>();
  for (const run of automationRuns) {
    const bundlePath = await readAutomationBundlePath(paths, run);
    if (!bundlePath || seenAutomationBundles.has(bundlePath)) {
      continue;
    }
    seenAutomationBundles.add(bundlePath);
    const bundleId = path.basename(bundlePath);
    const manifestPath = path.join(bundlePath, "manifest.yaml");
    const sourceMarkdownPath = path.join(bundlePath, "source.md");
    const finalizedPath = path.join(bundlePath, ".finalized");
    const wikiSourcePath = expectedWikiSourcePath(paths, bundleId);
    expectedRawBundlePaths.add(bundlePath);
    expectedWikiSourcePaths.add(wikiSourcePath);
    await addMissingIssue(issues, tombstoneIndex, "automation_run", run.id, bundlePath, "error", "automation raw bundle directory is missing");
    await addMissingIssue(issues, tombstoneIndex, "automation_run", run.id, manifestPath, "error", "automation raw bundle manifest is missing");
    await addMissingIssue(issues, tombstoneIndex, "automation_run", run.id, sourceMarkdownPath, "error", "automation raw bundle source.md is missing");
    await addMissingIssue(issues, tombstoneIndex, "automation_run", run.id, finalizedPath, "warn", "automation raw bundle .finalized marker is missing");
    await addMissingIssue(issues, tombstoneIndex, "automation_run", run.id, wikiSourcePath, "warn", "automation wiki source page is missing");
  }

  for (const output of outputs) {
    if (output.deletedAt) {
      continue;
    }
    await addMissingIssue(
      issues,
      tombstoneIndex,
      "job_output",
      output.id,
      resolveStoredProjectPath(paths, output.filePath),
      "warn",
      "downloadable output file is missing but SQLite still marks it active",
    );
  }

  for (const run of artifactRuns) {
    if (run.derivedBundlePath) {
      const bundlePath = resolveStoredVaultPath(paths, run.derivedBundlePath);
      expectedDerivedBundlePaths.add(bundlePath);
      await addMissingIssue(issues, tombstoneIndex, "derived_artifact", run.id, bundlePath, "warn", "derived artifact bundle is missing");
    }
    if (run.wikiPagePath) {
      const wikiPagePath = resolveStoredVaultPath(paths, run.wikiPagePath);
      expectedWikiDerivedPaths.add(wikiPagePath);
      await addMissingIssue(issues, tombstoneIndex, "derived_artifact", run.id, wikiPagePath, "warn", "derived wiki page is missing");
    }
  }

  for (const orphanPath of await listVaultBundleDirs(path.join(paths.vaultRoot, "raw"))) {
    if (!expectedRawBundlePaths.has(orphanPath) && !isTombstonedPath(tombstoneIndex, orphanPath)) {
      issues.push({
        severity: "warn",
        code: "orphan_raw_bundle",
        status: "orphan",
        targetType: "source_bundle",
        targetId: path.basename(orphanPath),
        path: orphanPath,
        message: "raw bundle exists on disk but has no SQLite source_bundles row",
      });
    }
  }

  for (const orphanPath of await listVaultBundleDirs(path.join(paths.vaultRoot, "derived"))) {
    if (!expectedDerivedBundlePaths.has(orphanPath) && !isTombstonedPath(tombstoneIndex, orphanPath)) {
      issues.push({
        severity: "warn",
        code: "orphan_derived_bundle",
        status: "orphan",
        targetType: "derived_artifact",
        targetId: path.basename(orphanPath),
        path: orphanPath,
        message: "derived bundle exists on disk but has no artifact renderer run row",
      });
    }
  }

  for (const sourcePagePath of await listMarkdownFiles(path.join(paths.vaultRoot, "wiki", "sources"))) {
    if (!expectedWikiSourcePaths.has(sourcePagePath) && !isTombstonedPath(tombstoneIndex, sourcePagePath)) {
      issues.push({
        severity: "warn",
        code: "orphan_wiki_source",
        status: "orphan",
        targetType: "source_bundle",
        targetId: path.basename(sourcePagePath, ".md"),
        path: sourcePagePath,
        message: "wiki source page exists without a matching SQLite source bundle",
      });
    }
  }

  for (const derivedPagePath of await listMarkdownFiles(path.join(paths.vaultRoot, "wiki", "derived"))) {
    if (!expectedWikiDerivedPaths.has(derivedPagePath) && !isTombstonedPath(tombstoneIndex, derivedPagePath)) {
      issues.push({
        severity: "warn",
        code: "orphan_wiki_derived",
        status: "orphan",
        targetType: "derived_artifact",
        targetId: path.basename(derivedPagePath, ".md"),
        path: derivedPagePath,
        message: "derived wiki page exists without a matching artifact renderer run row",
      });
    }
  }

  return {
    checkedAt,
    issues,
    summary: summarizeVaultIssues(issues),
  };
}

async function buildManagedDeletePlan(
  paths: RuntimePaths & { vaultRoot: string },
  db: DatabaseSync,
  identifier: string,
): Promise<ManagedDeletePlan> {
  const sourceBundles = listSourceBundles(db, 10000);
  const sourceBundle = sourceBundles.find((bundle) => bundle.id === identifier)
    ?? getSourceBundleForJob(db, identifier);
  if (sourceBundle) {
    return buildSourceBundleDeletePlan(paths, db, sourceBundle);
  }

  const artifactRuns = listArtifactRendererRuns(db, 10000);
  const artifactRun = getArtifactRendererRun(db, identifier)
    ?? artifactRuns.find((run) => run.artifactId === identifier);
  if (artifactRun) {
    return buildDerivedArtifactDeletePlan(paths, artifactRun);
  }

  const knownJob = getJob(db, identifier);
  if (knownJob) {
    throw new Error(`Job has no source bundle to delete: ${identifier}`);
  }
  throw new Error(`No managed delete target found for: ${identifier}`);
}

async function buildSourceBundleDeletePlan(
  paths: RuntimePaths & { vaultRoot: string },
  db: DatabaseSync,
  bundle: StoredSourceBundle,
): Promise<ManagedDeletePlan> {
  const planPaths: ManagedDeletePath[] = [];
  addManagedPath(planPaths, resolveStoredVaultPath(paths, bundle.bundlePath), "directory", true);
  addManagedPath(planPaths, expectedWikiSourcePath(paths, bundle.id), "file");

  const outputs = listAllJobOutputs(db, 10000).filter((output) => output.jobId === bundle.jobId && !output.deletedAt);
  for (const output of outputs) {
    addManagedPath(planPaths, resolveStoredProjectPath(paths, output.filePath), "file");
  }

  const relatedArtifacts: StoredArtifactRendererRun[] = [];
  for (const run of listArtifactRendererRuns(db, 10000)) {
    if (await artifactRunReferencesSource(paths, run, bundle)) {
      relatedArtifacts.push(run);
      if (run.derivedBundlePath) {
        addManagedPath(planPaths, resolveStoredVaultPath(paths, run.derivedBundlePath), "directory");
      }
      if (run.wikiPagePath) {
        addManagedPath(planPaths, resolveStoredVaultPath(paths, run.wikiPagePath), "file");
      }
    }
  }

  return {
    targetType: "source_bundle",
    targetId: bundle.id,
    jobId: bundle.jobId,
    paths: planPaths,
    metadata: {
      sourceBundle: bundle,
      jobOutputIds: outputs.map((output) => output.id),
      relatedArtifactRunIds: relatedArtifacts.map((run) => run.id),
    },
  };
}

function buildDerivedArtifactDeletePlan(
  paths: RuntimePaths & { vaultRoot: string },
  run: StoredArtifactRendererRun,
): ManagedDeletePlan {
  const planPaths: ManagedDeletePath[] = [];
  if (run.derivedBundlePath) {
    addManagedPath(planPaths, resolveStoredVaultPath(paths, run.derivedBundlePath), "directory", true);
  }
  if (run.wikiPagePath) {
    addManagedPath(planPaths, resolveStoredVaultPath(paths, run.wikiPagePath), "file");
  } else {
    addManagedPath(planPaths, path.join(paths.vaultRoot, "wiki", "derived", `${run.artifactId}.md`), "file");
  }
  return {
    targetType: "derived_artifact",
    targetId: run.id,
    paths: planPaths,
    metadata: {
      artifactId: run.artifactId,
      artifactKind: run.artifactKind,
      rendererMode: run.rendererMode,
    },
  };
}

async function applyManagedDeletePlan(
  paths: RuntimePaths & { vaultRoot: string },
  db: DatabaseSync,
  plan: ManagedDeletePlan,
  reason: string,
): Promise<{
  applied: true;
  plan: ManagedDeletePlan;
  deleted: string[];
  missing: string[];
  tombstone: StoredVaultTombstone;
}> {
  for (const item of plan.paths) {
    assertManagedDeletePath(paths, item.path);
  }

  const deleted: string[] = [];
  const missing: string[] = [];
  for (const item of plan.paths) {
    if (await pathExists(item.path)) {
      await fs.rm(item.path, { recursive: item.kind === "directory", force: true });
      deleted.push(item.path);
    } else {
      missing.push(item.path);
    }
  }

  if (plan.targetType === "source_bundle") {
    for (const outputId of stringArrayFromUnknown(plan.metadata.jobOutputIds)) {
      markJobOutputDeleted(db, outputId);
    }
  }

  const tombstone = createVaultTombstone(db, {
    id: buildVaultTombstoneId(plan.targetType, plan.targetId),
    targetType: plan.targetType,
    targetId: plan.targetId,
    ...(plan.jobId ? { jobId: plan.jobId } : {}),
    reason,
    paths: plan.paths.map((item) => item.path),
    metadata: {
      ...plan.metadata,
      deleted,
      missing,
    },
    createdBy: "ops-cli",
  });

  if (plan.jobId) {
    appendJobEvent(db, plan.jobId, "vault.managed_delete", reason, {
      tombstoneId: tombstone.id,
      targetType: plan.targetType,
      targetId: plan.targetId,
      deleted,
      missing,
    });
  }

  return {
    applied: true,
    plan,
    deleted,
    missing,
    tombstone,
  };
}

async function addMissingIssue(
  issues: VaultReconcileIssue[],
  tombstoneIndex: ReturnType<typeof buildTombstoneIndex>,
  targetType: string,
  targetId: string,
  targetPath: string,
  missingSeverity: Exclude<VaultIssueSeverity, "info">,
  message: string,
): Promise<void> {
  if (await pathExists(targetPath)) {
    return;
  }
  const deleted = isTombstoned(tombstoneIndex, targetType, targetId, targetPath);
  issues.push({
    severity: deleted ? "info" : missingSeverity,
    code: deleted ? "tombstoned_missing_path" : "missing_path",
    status: deleted ? "deleted" : "missing",
    targetType,
    targetId,
    path: targetPath,
    message: deleted ? "missing path is covered by a SQLite tombstone" : message,
  });
}

function buildTombstoneIndex(tombstones: StoredVaultTombstone[]): {
  targets: Set<string>;
  paths: Set<string>;
} {
  const targets = new Set<string>();
  const paths = new Set<string>();
  for (const tombstone of tombstones) {
    targets.add(`${tombstone.targetType}:${tombstone.targetId}`);
    for (const tombstonePath of tombstone.paths) {
      paths.add(path.resolve(tombstonePath));
    }
  }
  return { targets, paths };
}

function isTombstoned(
  index: ReturnType<typeof buildTombstoneIndex>,
  targetType: string,
  targetId: string,
  targetPath: string,
): boolean {
  return index.targets.has(`${targetType}:${targetId}`) || isTombstonedPath(index, targetPath);
}

function isTombstonedPath(index: ReturnType<typeof buildTombstoneIndex>, targetPath: string): boolean {
  const resolved = path.resolve(targetPath);
  if (index.paths.has(resolved)) {
    return true;
  }
  for (const tombstonePath of index.paths) {
    if (isPathInside(tombstonePath, resolved)) {
      return true;
    }
  }
  return false;
}

function summarizeVaultIssues(issues: VaultReconcileIssue[]): Record<VaultIssueSeverity, number> {
  return issues.reduce<Record<VaultIssueSeverity, number>>(
    (summary, issue) => {
      summary[issue.severity] += 1;
      return summary;
    },
    { error: 0, warn: 0, info: 0 },
  );
}

function printVaultReconcileReport(report: VaultReconcileReport): void {
  process.stdout.write(`Vault reconcile ${report.checkedAt}\n`);
  process.stdout.write(`issues=${report.issues.length} error=${report.summary.error} warn=${report.summary.warn} info=${report.summary.info}\n`);
  if (report.issues.length === 0) {
    process.stdout.write("No vault/SQLite drift detected.\n");
    return;
  }
  for (const issue of report.issues) {
    process.stdout.write(`${issue.severity} ${issue.code} ${issue.targetType}:${issue.targetId}\n`);
    process.stdout.write(`  ${issue.path}\n`);
    process.stdout.write(`  ${issue.message}\n`);
  }
}

async function artifactRunReferencesSource(
  paths: RuntimePaths & { vaultRoot: string },
  run: StoredArtifactRendererRun,
  bundle: StoredSourceBundle,
): Promise<boolean> {
  const bundlePath = resolveStoredVaultPath(paths, bundle.bundlePath);
  const wikiSourcePath = expectedWikiSourcePath(paths, bundle.id);
  const needles = [
    bundle.id,
    toVaultRelativePath(paths, bundlePath),
    toVaultRelativePath(paths, wikiSourcePath),
  ].filter((value) => value.length > 0);
  const requestText = JSON.stringify(run.request);
  if (needles.some((needle) => requestText.includes(needle))) {
    return true;
  }
  if (!run.derivedBundlePath) {
    return false;
  }
  const derivedBundlePath = resolveStoredVaultPath(paths, run.derivedBundlePath);
  const provenancePath = path.join(derivedBundlePath, "provenance.json");
  try {
    const provenance = await fs.readFile(provenancePath, "utf8");
    return needles.some((needle) => provenance.includes(needle));
  } catch {
    return false;
  }
}

async function readAutomationBundlePath(
  paths: RuntimePaths & { vaultRoot: string },
  run: StoredAutomationRun,
): Promise<string | null> {
  try {
    const resultPath = resolveStoredProjectPath(paths, run.resultPath);
    const parsed = JSON.parse(await fs.readFile(resultPath, "utf8")) as unknown;
    if (!isRecord(parsed) || !isRecord(parsed.moduleResult)) {
      return null;
    }
    const resultStatus = parsed.moduleResult.status;
    const skipReason = parsed.moduleResult.reason;
    if (resultStatus === "skipped" && skipReason !== "raw_bundle_exists") {
      return null;
    }
    const bundlePath = parsed.moduleResult.bundlePath;
    if (typeof bundlePath !== "string" || bundlePath.trim() === "") {
      return null;
    }
    const resolved = resolveStoredVaultPath(paths, bundlePath);
    return isPathInside(paths.vaultRoot, resolved) ? resolved : null;
  } catch {
    return null;
  }
}

async function listVaultBundleDirs(root: string): Promise<string[]> {
  if (!await pathExists(root)) {
    return [];
  }
  const dates = await fs.readdir(root, { withFileTypes: true });
  const results: string[] = [];
  for (const dateEntry of dates) {
    if (!dateEntry.isDirectory()) {
      continue;
    }
    const dateDir = path.join(root, dateEntry.name);
    const bundles = await fs.readdir(dateDir, { withFileTypes: true });
    for (const bundleEntry of bundles) {
      if (bundleEntry.isDirectory()) {
        results.push(path.join(dateDir, bundleEntry.name));
      }
    }
  }
  return results.map((item) => path.resolve(item)).sort();
}

async function listMarkdownFiles(root: string): Promise<string[]> {
  if (!await pathExists(root)) {
    return [];
  }
  const entries = await fs.readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listMarkdownFiles(entryPath));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push(path.resolve(entryPath));
    }
  }
  return files.sort();
}

function addManagedPath(paths: ManagedDeletePath[], targetPath: string, kind: ManagedDeletePath["kind"], required = false): void {
  const resolved = path.resolve(targetPath);
  if (paths.some((item) => item.path === resolved)) {
    return;
  }
  paths.push({
    path: resolved,
    kind,
    ...(required ? { required: true } : {}),
  });
}

function assertManagedDeletePath(paths: RuntimePaths & { vaultRoot: string }, targetPath: string): void {
  const resolved = path.resolve(targetPath);
  const roots = [paths.vaultRoot, paths.runtimeDir].map((root) => path.resolve(root));
  const matchingRoot = roots.find((root) => isPathInside(root, resolved));
  if (!matchingRoot) {
    throw new Error(`Refusing to delete unmanaged path: ${targetPath}`);
  }
  if (resolved === matchingRoot) {
    throw new Error(`Refusing to delete managed root: ${targetPath}`);
  }
}

function isPathInside(root: string, targetPath: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(targetPath));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function expectedWikiSourcePath(paths: RuntimePaths & { vaultRoot: string }, bundleId: string): string {
  return path.resolve(paths.vaultRoot, "wiki", "sources", `${bundleId}.md`);
}

function resolveStoredVaultPath(paths: RuntimePaths & { vaultRoot: string }, storedPath: string): string {
  return path.isAbsolute(storedPath)
    ? path.resolve(storedPath)
    : path.resolve(paths.vaultRoot, storedPath);
}

function resolveStoredProjectPath(paths: RuntimePaths, storedPath: string): string {
  return path.isAbsolute(storedPath)
    ? path.resolve(storedPath)
    : path.resolve(paths.projectRoot, storedPath);
}

function toVaultRelativePath(paths: RuntimePaths & { vaultRoot: string }, targetPath: string): string {
  const relative = path.relative(paths.vaultRoot, targetPath);
  return relative.startsWith("..") || path.isAbsolute(relative) ? "" : relative.replace(/\\/g, "/");
}

function stringArrayFromUnknown(value: unknown): string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function buildVaultTombstoneId(targetType: string, targetId: string): string {
  const safeTarget = targetId.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "") || "target";
  const timestamp = new Date().toISOString().replace(/[-:.]/g, "").replace("T", "_").replace("Z", "z");
  return `vault_${targetType}_${safeTarget}_${timestamp}`;
}

function parsePositiveInteger(value: string, optionName: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${optionName} must be a positive integer`);
  }
  return parsed;
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
    `OnCalendar=*:0/${intervalMinutes}`,
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
    "  npm run tlgi -- vault <command>",
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
    "  vault reconcile [--json] [--limit N]",
    "  vault delete <id> [--apply] [--reason <text>] [--json]",
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

function printVaultHelp(): void {
  process.stdout.write([
    "Usage:",
    "  npm run tlgi -- vault reconcile [--json] [--limit N]",
    "  npm run tlgi -- vault delete <job_or_bundle_or_artifact_id> [--apply] [--reason <text>] [--json]",
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
