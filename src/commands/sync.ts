import { execSync } from 'node:child_process';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import process from 'node:process';
import { getBooleanFlag, getStringFlag, parseArgs } from '../lib/args.js';
import { runMain } from '../lib/cli.js';
import type { VibeConfig } from '../lib/config.js';
import { loadConfig } from '../lib/config.js';
import { readJson, readText, writeJson } from '../lib/fs.js';
import { logger } from '../lib/logger.js';
import { paths } from '../lib/paths.js';
import { runCommand } from '../lib/shell.js';
import {
  applySyncPlan,
  buildSyncPlan,
  createBackup,
  loadManifest,
  runMigrations,
  type SyncAction,
} from '../lib/sync.js';

const SEMVER_REF_PATTERN = /^\d+\.\d+\.\d+$/;
const CARET_SEMVER_TAG_PATTERN = /^\^v?\d+\.\d+\.\d+$/;
const DEFAULT_UPSTREAM_URL = 'https://github.com/mir3626/vibe-doctor.git';

const DEFAULT_SYNC_CONFIG: VibeConfig = {
  orchestrator: 'codex',
  harnessVersionInstalled: '0.0.0',
  sprintRoles: { planner: 'codex', generator: 'codex', evaluator: 'codex' },
  sprint: { unit: 'feature', subAgentPerRole: false, freshContextPerSprint: true },
  providers: {},
};

export function renderSyncInitGuardMessage(): string {
  return [
    'vibe:sync requires an initialized vibe-doctor project.',
    '',
    'Run /vibe-init first, then retry /vibe-sync or npm run vibe:sync.',
    'Sync is blocked before initialization so template sprint history and reports are not treated as project state.',
    '',
  ].join('\n');
}

export interface SyncCache {
  latestVersion?: string | null;
  versions?: string[];
}

export interface FloatingRefUpdateCandidate {
  rangeRef: string;
  baseRef: string;
  latestRef: string;
}

function normalizeGitUrl(value: string | undefined): string {
  return String(value ?? '')
    .trim()
    .replace(/^git@([^:]+):/, 'https://$1/')
    .replace(/^ssh:\/\/git@/i, 'https://')
    .replace(/^https?:\/\//i, '')
    .replace(/\.git$/i, '')
    .replace(/\/+$/g, '')
    .toLowerCase();
}

function isTemplateSelfCheckout(upstreamUrl: string | undefined): boolean {
  return (
    path.basename(paths.root).toLowerCase() === 'vibe-doctor' &&
    normalizeGitUrl(upstreamUrl) === normalizeGitUrl(DEFAULT_UPSTREAM_URL)
  );
}

function isVibeDoctorRemote(upstreamUrl: string | undefined): boolean {
  const normalized = normalizeGitUrl(upstreamUrl);
  return normalized === normalizeGitUrl(DEFAULT_UPSTREAM_URL) || normalized.endsWith('/vibe-doctor');
}

function getOriginUrl(root = paths.root): string | undefined {
  try {
    const output = execSync('git remote get-url origin', {
      cwd: root,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
    }).trim();
    return output || undefined;
  } catch {
    return undefined;
  }
}

export function resolveMissingUpstream(
  config: Pick<VibeConfig, 'upstream'>,
  originUrl: string | undefined,
  rootBasename: string,
): NonNullable<VibeConfig['upstream']> | undefined {
  if (config.upstream?.url || config.upstream?.self) {
    return config.upstream;
  }

  if (originUrl && isVibeDoctorRemote(originUrl)) {
    if (rootBasename.toLowerCase() === 'vibe-doctor' && normalizeGitUrl(originUrl) === normalizeGitUrl(DEFAULT_UPSTREAM_URL)) {
      return { type: 'git', url: originUrl, self: true };
    }
    return { type: 'git', url: originUrl };
  }

  if (rootBasename.toLowerCase() === 'vibe-doctor') {
    return { type: 'git', url: DEFAULT_UPSTREAM_URL, self: true };
  }

  return { type: 'git', url: DEFAULT_UPSTREAM_URL };
}

function normalizeVersion(value: string | undefined | null): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const normalized = value.trim().replace(/^v/i, '');
  return SEMVER_REF_PATTERN.test(normalized) ? normalized : undefined;
}

function compareVersions(left: string, right: string): number {
  const leftParts = left.split('.').map(Number);
  const rightParts = right.split('.').map(Number);
  const length = Math.max(leftParts.length, rightParts.length);

  for (let index = 0; index < length; index += 1) {
    const diff = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (diff !== 0) {
      return diff;
    }
  }

  return 0;
}

function isCaretVersionRange(value: string | undefined): boolean {
  return typeof value === 'string' && CARET_SEMVER_TAG_PATTERN.test(value.trim());
}

function normalizeCaretRange(value: string | undefined): string | undefined {
  if (typeof value !== 'string' || !isCaretVersionRange(value)) {
    return undefined;
  }

  return normalizeVersion(value.trim().slice(1));
}

function getCachedVersions(syncCache?: SyncCache): string[] {
  const versions = new Set<string>();
  const latest = normalizeVersion(syncCache?.latestVersion);
  if (latest) {
    versions.add(latest);
  }

  if (Array.isArray(syncCache?.versions)) {
    for (const version of syncCache.versions) {
      const normalized = normalizeVersion(version);
      if (normalized) {
        versions.add(normalized);
      }
    }
  }

  return Array.from(versions).sort(compareVersions);
}

function satisfiesCaretRange(version: string, base: string): boolean {
  if (compareVersions(version, base) < 0) {
    return false;
  }

  const [major = 0, minor = 0, patch = 0] = base.split('.').map(Number);
  const [candidateMajor = 0, candidateMinor = 0, candidatePatch = 0] = version.split('.').map(Number);

  if (major > 0) {
    return candidateMajor === major;
  }
  if (minor > 0) {
    return candidateMajor === 0 && candidateMinor === minor;
  }
  return candidateMajor === 0 && candidateMinor === 0 && candidatePatch === patch;
}

function resolveLatestCachedRef(config: VibeConfig, syncCache?: SyncCache): string | undefined {
  const latest = normalizeVersion(syncCache?.latestVersion);
  const installed = normalizeVersion(config.harnessVersionInstalled ?? config.harnessVersion);

  if (!latest || !installed || compareVersions(latest, installed) <= 0) {
    return undefined;
  }

  return `v${latest}`;
}

function resolveCaretRangeRef(rangeRef: string, syncCache?: SyncCache): string {
  const base = normalizeCaretRange(rangeRef);
  if (!base) {
    return rangeRef;
  }

  const compatible = getCachedVersions(syncCache)
    .filter((version) => satisfiesCaretRange(version, base))
    .at(-1);

  return `v${compatible ?? base}`;
}

export function resolveFloatingRefUpdateCandidate(
  config: VibeConfig,
  syncCache?: SyncCache,
): FloatingRefUpdateCandidate | undefined {
  const rangeRef = config.upstream?.ref?.trim();
  const base = normalizeCaretRange(rangeRef);

  if (!rangeRef || !base) {
    return undefined;
  }

  const latest = resolveCaretRangeRef(rangeRef, syncCache).replace(/^v/i, '');
  if (compareVersions(latest, base) <= 0) {
    return undefined;
  }

  return {
    rangeRef,
    baseRef: `v${base}`,
    latestRef: `v${latest}`,
  };
}

async function refreshSyncCache(): Promise<void> {
  try {
    await runCommand('node', ['scripts/vibe-version-check.mjs', '--force'], { cwd: paths.root });
  } catch {
    // Sync can still proceed with existing config/cache when the update check is unavailable.
  }
}

async function readSyncCache(): Promise<SyncCache | undefined> {
  try {
    return await readJson<SyncCache>(paths.syncCache);
  } catch {
    return undefined;
  }
}

function hasTemplateProjectState(productMd: string, sprintStatus: unknown, rootBasename: string): boolean {
  if (rootBasename.toLowerCase() === 'vibe-doctor') {
    return false;
  }

  const statusRecord =
    typeof sprintStatus === 'object' && sprintStatus !== null && !Array.isArray(sprintStatus)
      ? (sprintStatus as Record<string, unknown>)
      : {};
  const project =
    typeof statusRecord.project === 'object' && statusRecord.project !== null && !Array.isArray(statusRecord.project)
      ? (statusRecord.project as Record<string, unknown>)
      : {};
  const statusProjectName = typeof project.name === 'string' ? project.name : '';

  return statusProjectName === 'vibe-doctor' || /\*\*vibe-doctor\*\*|^#\s+vibe-doctor\b/im.test(productMd);
}

export async function hasVibeInitArtifacts(root = paths.root): Promise<boolean> {
  const productPath = path.join(root, 'docs', 'context', 'product.md');
  const statusPath = path.join(root, '.vibe', 'agent', 'sprint-status.json');

  if (!(await fileExists(productPath)) || !(await fileExists(statusPath))) {
    return false;
  }

  try {
    const [productMd, sprintStatus] = await Promise.all([
      readText(productPath),
      readJson<unknown>(statusPath),
    ]);
    if (productMd.trim().length === 0) {
      return false;
    }
    return !hasTemplateProjectState(productMd, sprintStatus, path.basename(root));
  } catch {
    return false;
  }
}

async function ensureSyncUpstreamConfig(config: VibeConfig): Promise<VibeConfig> {
  const upstream = resolveMissingUpstream(config, getOriginUrl(paths.root), path.basename(paths.root));
  if (!upstream || upstream === config.upstream) {
    return config;
  }

  const sharedConfig = (await fileExists(paths.sharedConfig))
    ? await readJson<VibeConfig>(paths.sharedConfig)
    : config;
  await writeJson(paths.sharedConfig, { ...sharedConfig, upstream });
  logger.info(`Initialized .vibe/config.json upstream as ${upstream.url}${upstream.self ? ' (self)' : ''}`);
  return { ...config, upstream };
}

export function resolveUpstreamRef(
  config: VibeConfig,
  refOverride?: string,
  syncCache?: SyncCache,
): string {
  if (refOverride) {
    return refOverride;
  }

  if (config.upstream?.ref) {
    if (isCaretVersionRange(config.upstream.ref)) {
      return resolveCaretRangeRef(config.upstream.ref, syncCache);
    }
    return config.upstream.ref;
  }

  const latestCachedRef = resolveLatestCachedRef(config, syncCache);
  if (latestCachedRef) {
    return latestCachedRef;
  }

  if (config.harnessVersion && SEMVER_REF_PATTERN.test(config.harnessVersion)) {
    return `v${config.harnessVersion}`;
  }

  return 'main';
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function resolvePostSyncTypecheckArgs(root = paths.root): Promise<string[]> {
  if (await fileExists(path.join(root, 'tsconfig.harness.json'))) {
    return ['tsc', '-p', 'tsconfig.harness.json', '--noEmit'];
  }

  return ['tsc', '--noEmit'];
}

async function cloneUpstream(url: string, ref: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'vibe-sync-'));
  execSync(`git clone --depth 1 --branch ${JSON.stringify(ref)} ${JSON.stringify(url)} ${JSON.stringify(dir)}`, {
    stdio: 'pipe',
    encoding: 'utf8',
  });
  return dir;
}

function renderPlanTable(actions: SyncAction[]): string {
  const rows = actions.map((action) => {
    let detail = '';
    if ('reason' in action) {
      detail = action.reason;
    } else if ('sections' in action) {
      detail = action.sections.join(', ');
    } else if ('keys' in action) {
      detail = action.keys.join(', ');
    }

    return `| ${action.type} | ${action.path} | ${detail} |`;
  });

  return ['| action | path | detail |', '|---|---|---|', ...rows].join('\n');
}

function renderPlanSummary(actions: SyncAction[]): string {
  const counts = new Map<string, number>();
  for (const action of actions) {
    counts.set(action.type, (counts.get(action.type) ?? 0) + 1);
  }
  const summary = Array.from(counts, ([type, count]) => `${count} ${type}`).join(', ');
  return `Files: ${summary || '0 actions'}`;
}

function acceptAllConflicts(actions: SyncAction[]): SyncAction[] {
  return actions.map((action): SyncAction =>
    action.type === 'conflict' ? { type: 'replace', path: action.path, reason: `forced: ${action.reason}` } : action,
  );
}

function skipAllConflicts(actions: SyncAction[]): SyncAction[] {
  return actions.map((action): SyncAction =>
    action.type === 'conflict' ? { type: 'skip', path: action.path, reason: `kept local copy: ${action.reason}` } : action,
  );
}

async function approveAndResolve(actions: SyncAction[], force: boolean): Promise<SyncAction[]> {
  if (force) {
    return acceptAllConflicts(actions);
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('Sync approval requires an interactive terminal. Re-run with --force to proceed non-interactively.');
  }

  const rl = readline.createInterface({ input, output });
  try {
    const conflicts = actions.filter((action) => action.type === 'conflict');
    if (conflicts.length === 0) {
      for (;;) {
        const answer = (
          await rl.question(`\nNo conflicts. ${actions.length} actions will be applied.\n\nProceed? [Y/n] `)
        ).trim().toLowerCase();
        if (answer === '' || answer === 'y' || answer === 'yes') {
          return actions;
        }
        if (answer === 'n' || answer === 'no') {
          throw new Error('Cancelled by user');
        }
        process.stdout.write('Enter y or n.\n');
      }
    }

    process.stdout.write(
      `\n${conflicts.length} conflict(s) detected (locally modified harness files).\n\n` +
        'Choose:\n' +
        '  [a] Accept all - replace every conflict with upstream changes (local edits lost)\n' +
        '  [i] Individual - review each conflict one by one\n' +
        '  [s] Skip all - keep every local conflict and apply the rest\n' +
        '  [c] Cancel - apply nothing\n\n',
    );

    for (;;) {
      const choice = (await rl.question('> ')).trim().toLowerCase();
      if (choice === 'a') {
        return acceptAllConflicts(actions);
      }
      if (choice === 's') {
        return skipAllConflicts(actions);
      }
      if (choice === 'c') {
        throw new Error('Cancelled by user');
      }
      if (choice === 'i') {
        const resolved: SyncAction[] = [];
        for (const action of actions) {
          if (action.type !== 'conflict') {
            resolved.push(action);
            continue;
          }

          const answer = (await rl.question(`Replace local changes for ${action.path}? [y/N] `)).trim().toLowerCase();
          if (answer === 'y' || answer === 'yes') {
            resolved.push({
              type: 'replace',
              path: action.path,
              reason: `accepted upstream after conflict: ${action.reason}`,
            });
          } else {
            resolved.push({ type: 'skip', path: action.path, reason: `kept local copy: ${action.reason}` });
          }
        }
        return resolved;
      }
      process.stdout.write('Choose a, i, s, or c.\n');
    }
  } finally {
    rl.close();
  }
}

async function verifyPostSync(): Promise<void> {
  await runCommand('npx', await resolvePostSyncTypecheckArgs(paths.root), { cwd: paths.root });
  await runCommand('node', ['scripts/vibe-preflight.mjs', '--bootstrap'], {
    cwd: paths.root,
  });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const dryRun = getBooleanFlag(args, 'dry-run');
  const force = getBooleanFlag(args, 'force');
  const jsonMode = getBooleanFlag(args, 'json');
  const noBackup = getBooleanFlag(args, 'no-backup');
  const noVerify = getBooleanFlag(args, 'no-verify');
  const from = getStringFlag(args, 'from');
  const refOverride = getStringFlag(args, 'ref');

  const initialConfig = (await fileExists(paths.sharedConfig)) ? await loadConfig() : undefined;
  if (
    !from &&
    initialConfig &&
    (initialConfig.upstream?.self || isTemplateSelfCheckout(initialConfig.upstream?.url))
  ) {
    logger.info('Skipping sync: this checkout is marked as the vibe-doctor template source. Use --from to override.');
    return;
  }

  if (!(await hasVibeInitArtifacts(paths.root))) {
    throw new Error(renderSyncInitGuardMessage());
  }

  const config = await ensureSyncUpstreamConfig(initialConfig ?? DEFAULT_SYNC_CONFIG);
  let upstreamRoot: string | null = null;
  let cleanupRequired = false;

  try {
    if (from) {
      upstreamRoot = path.resolve(from);
    } else if (config.upstream?.type === 'local') {
      upstreamRoot = path.resolve(config.upstream.url);
    } else {
      if (!config.upstream?.url) {
        throw new Error('Missing upstream configuration in .vibe/config.json');
      }
      await refreshSyncCache();
      const syncCache = await readSyncCache();
      const floatingCandidate = refOverride ? undefined : resolveFloatingRefUpdateCandidate(config, syncCache);
      const ref = resolveUpstreamRef(config, refOverride, syncCache);
      if (floatingCandidate && !jsonMode) {
        logger.info(
          `Upstream range ${floatingCandidate.rangeRef} resolved to ${floatingCandidate.latestRef}. ` +
            `Use --ref ${floatingCandidate.baseRef} to stay on the base harness for this run.`,
        );
      }
      logger.info(`Cloning upstream ${config.upstream.url}#${ref}`);
      upstreamRoot = await cloneUpstream(config.upstream.url, ref);
      cleanupRequired = true;
    }

    const manifest = await loadManifest(upstreamRoot);
    const plan = await buildSyncPlan(paths.root, upstreamRoot, manifest);
    let finalPlan = { ...plan, actions: force ? acceptAllConflicts(plan.actions) : plan.actions };

    if (jsonMode) {
      process.stdout.write(`${JSON.stringify(finalPlan, null, 2)}\n`);
      if (dryRun) {
        return;
      }
      if (!force && finalPlan.actions.some((action) => action.type === 'conflict')) {
        throw new Error('Conflicts detected. Re-run with --force or use an interactive terminal without --json.');
      }
    } else {
      process.stdout.write(`Sync plan: vibe-doctor ${plan.fromVersion ?? 'unknown'} -> ${plan.toVersion}\n\n`);
      process.stdout.write(`${renderPlanTable(finalPlan.actions)}\n`);
      process.stdout.write(`${renderPlanSummary(finalPlan.actions)}\n`);
      if (plan.migrations.length > 0) {
        process.stdout.write(`Migrations: ${plan.migrations.join(', ')}\n`);
      }
      if (dryRun) {
        return;
      }
      finalPlan = { ...plan, actions: await approveAndResolve(plan.actions, force) };
    }

    const backupTargets = finalPlan.actions
      .filter((action) => action.type !== 'skip' && action.type !== 'conflict' && action.type !== 'new-file')
      .map((action) => action.path);

    if (!noBackup && backupTargets.length > 0) {
      const backupDir = await createBackup(paths.root, backupTargets);
      logger.info(`Backup created at ${backupDir}`);
    }

    await applySyncPlan(paths.root, upstreamRoot, finalPlan, manifest);
    await runMigrations(paths.root, upstreamRoot, finalPlan.migrations);

    const sharedConfig = await readJson<VibeConfig>(paths.sharedConfig);
    sharedConfig.harnessVersionInstalled = finalPlan.toVersion;
    const sharedUpstream = sharedConfig.upstream;
    if (!refOverride && sharedUpstream && isCaretVersionRange(sharedUpstream.ref)) {
      sharedConfig.upstream = {
        ...sharedUpstream,
        ref: `^v${finalPlan.toVersion}`,
      };
    }
    await writeJson(paths.sharedConfig, sharedConfig);

    if (!noVerify) {
      await verifyPostSync();
    }
  } finally {
    if (cleanupRequired && upstreamRoot) {
      await rm(upstreamRoot, { recursive: true, force: true });
    }
  }
}

runMain(main, import.meta.url);
