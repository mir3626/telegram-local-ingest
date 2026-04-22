import { execSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import process from 'node:process';
import { getBooleanFlag, getStringFlag, parseArgs } from '../lib/args.js';
import { runMain } from '../lib/cli.js';
import type { VibeConfig } from '../lib/config.js';
import { loadConfig } from '../lib/config.js';
import { readJson, writeJson } from '../lib/fs.js';
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

export function resolveUpstreamRef(config: VibeConfig, refOverride?: string): string {
  if (refOverride) {
    return refOverride;
  }

  if (config.upstream?.ref) {
    return config.upstream.ref;
  }

  if (config.harnessVersion && SEMVER_REF_PATTERN.test(config.harnessVersion)) {
    return `v${config.harnessVersion}`;
  }

  return 'main';
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
  await runCommand('npx', ['tsc', '--noEmit'], { cwd: paths.root });
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

  const config = await loadConfig();
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
      const ref = resolveUpstreamRef(config, refOverride);
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
