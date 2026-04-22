#!/usr/bin/env node

import { spawnSync, execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path, { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const META_PREFIXES = [
  '.vibe/archive/',
  'tmp_',
  'node_modules/',
  'dist/',
  '.vibe/runs/',
  '.vibe/sync-backup/',
];
const META_SUFFIXES = ['.log', '.tmp'];
const META_EXACT = [
  '.vibe/sync-cache.json',
  '.vibe/sync-hashes.json',
  '.vibe/agent/session-log.lock',
];
const STATE_FILES = new Set([
  '.vibe/agent/sprint-status.json',
  '.vibe/agent/handoff.md',
  '.vibe/agent/session-log.md',
]);
const LOCKFILE_BLACKLIST = new Set(['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb']);
const LOC_EXTENSION_FALLBACK = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.go', '.rs'];

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function normalizePosix(value) {
  return value.replace(/\\/g, '/');
}

function parseScopeValue(value) {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function parseArgs(argv) {
  const [, , sprintId, status, ...rest] = argv;
  if (!sprintId || !status || !['passed', 'failed'].includes(status)) {
    fail(
      'Usage: node scripts/vibe-sprint-commit.mjs <sprintId> <passed|failed> [--scope <glob,glob,...>] [--message <extra>] [--no-verify-gpg] [--push-tag] [--dry-run]',
    );
  }

  let scope = [];
  let message = '';
  let dryRun = false;
  let disableGpg = false;
  let pushTag = false;

  for (let index = 0; index < rest.length; index += 1) {
    const current = rest[index];
    if (current === '--scope') {
      scope = parseScopeValue(rest[index + 1] ?? '');
      index += 1;
      continue;
    }
    if (current === '--message') {
      message = rest[index + 1] ?? '';
      index += 1;
      continue;
    }
    if (current === '--dry-run') {
      dryRun = true;
      continue;
    }
    if (current === '--no-verify-gpg') {
      disableGpg = true;
      continue;
    }
    if (current === '--push-tag') {
      pushTag = true;
      continue;
    }
  }

  return { sprintId, status, scope, message, dryRun, disableGpg, pushTag };
}

function execGit(args, options = {}) {
  return execFileSync('git', args, {
    encoding: 'utf8',
    ...options,
  }).trim();
}

function gitLines(args) {
  const output = execGit(args);
  return output.length === 0
    ? []
    : output
        .split(/\r?\n/)
        .map((entry) => normalizePosix(entry.trim()))
        .filter((entry) => entry.length > 0);
}

function isMetaPath(relativePath) {
  if (META_EXACT.includes(relativePath)) {
    return true;
  }
  if (META_PREFIXES.some((prefix) => relativePath.startsWith(prefix))) {
    return true;
  }
  return META_SUFFIXES.some((suffix) => relativePath.endsWith(suffix));
}

function unique(entries) {
  const seen = new Set();
  const result = [];

  for (const rawEntry of entries) {
    const entry = normalizePosix(rawEntry);
    if (seen.has(entry)) {
      continue;
    }
    seen.add(entry);
    result.push(entry);
  }

  return result;
}

function detectChangedFiles() {
  const changed = unique([
    ...gitLines(['diff', '--name-only']),
    ...gitLines(['diff', '--cached', '--name-only']),
    ...gitLines(['ls-files', '--others', '--exclude-standard']),
  ]);

  return changed.filter((relativePath) => !isMetaPath(relativePath));
}

function loadSprintStatus(statusPath) {
  return JSON.parse(readFileSync(statusPath, 'utf8'));
}

// CROSS-REF (src/lib/sprint-status.ts:extendLastSprintScope)
// Inline replication intentional — .mjs cannot import compiled TS without a build step.
// Drift detection: test/sprint-commit.test.ts asserts both implementations produce identical
// output for a shared fixture. If this block changes, update the lib AND the test fixture.
export function inlineExtendLastSprintScope(statusPath, mergedScope, mergedGlobs) {
  const sprintStatus = loadSprintStatus(statusPath);
  const previousScope = Array.isArray(sprintStatus.lastSprintScope) ? sprintStatus.lastSprintScope : [];
  const previousGlobs = Array.isArray(sprintStatus.lastSprintScopeGlob)
    ? sprintStatus.lastSprintScopeGlob
    : [];
  const nextScope = unique([...previousScope, ...mergedScope]);
  const nextGlobs = unique([...previousGlobs, ...mergedGlobs]);

  if (
    nextScope.length === previousScope.length &&
    nextGlobs.length === previousGlobs.length &&
    nextScope.every((entry, index) => entry === previousScope[index]) &&
    nextGlobs.every((entry, index) => entry === previousGlobs[index])
  ) {
    return;
  }

  sprintStatus.lastSprintScope = nextScope;
  sprintStatus.lastSprintScopeGlob = nextGlobs;
  writeFileSync(statusPath, `${JSON.stringify(sprintStatus, null, 2)}\n`, 'utf8');
}

function collectTargetedPendingRisks(sprintStatus, sprintId) {
  const risks = Array.isArray(sprintStatus.pendingRisks) ? sprintStatus.pendingRisks : [];
  return risks.filter(
    (risk) =>
      risk?.status === 'open' &&
      (risk.targetSprint === sprintId ||
        (risk.targetSprint === '*' && typeof risk.id === 'string' && risk.id.startsWith('audit-'))),
  );
}

function stageIfTrackedOrChanged(entries, changedFiles) {
  return entries.filter((relativePath) => existsSync(resolve(relativePath)) || changedFiles.includes(relativePath));
}

export function collectArchivedPromptFiles(sprintId) {
  const archiveDir = resolve('.vibe/archive/prompts');
  if (!existsSync(archiveDir)) {
    return [];
  }

  return readdirSync(archiveDir)
    .filter((entry) => {
      if (!entry.endsWith('.md')) {
        return false;
      }
      const baseName = entry.slice(0, -'.md'.length);
      return baseName === sprintId || baseName.startsWith(`${sprintId}-`);
    })
    .map((entry) => normalizePosix(path.join('.vibe/archive/prompts', entry)));
}

function loadLocExtensions() {
  const configPath = resolve('.vibe/config.json');
  if (!existsSync(configPath)) {
    return LOC_EXTENSION_FALLBACK;
  }

  try {
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    return Array.isArray(config?.loc?.extensions) && config.loc.extensions.every((entry) => typeof entry === 'string')
      ? config.loc.extensions
      : LOC_EXTENSION_FALLBACK;
  } catch {
    return LOC_EXTENSION_FALLBACK;
  }
}

function computeLocSummary(codeExtensions) {
  const output = execGit(['diff', '--cached', '--numstat']);
  const lines = output.length === 0 ? [] : output.split(/\r?\n/).filter((entry) => entry.length > 0);
  let added = 0;
  let deleted = 0;

  for (const line of lines) {
    const [addedText, deletedText, filePath] = line.split(/\t/);
    if (!filePath) {
      continue;
    }
    if (LOCKFILE_BLACKLIST.has(path.basename(filePath))) continue;
    if (!codeExtensions.some((extension) => filePath.endsWith(extension))) {
      continue;
    }
    const parsedAdded = Number(addedText);
    const parsedDeleted = Number(deletedText);
    if (Number.isFinite(parsedAdded)) {
      added += parsedAdded;
    }
    if (Number.isFinite(parsedDeleted)) {
      deleted += parsedDeleted;
    }
  }

  return {
    added,
    deleted,
    net: added - deleted,
  };
}

function buildCommitMessage(sprintStatus, sprintId, status, extraMessage, filesChanged, locSummary) {
  const sprintEntry = Array.isArray(sprintStatus.sprints)
    ? sprintStatus.sprints.find((entry) => entry?.id === sprintId)
    : null;
  const autoSummary = sprintEntry?.name ?? sprintId;
  const verifiedAt = typeof sprintStatus.verifiedAt === 'string' ? sprintStatus.verifiedAt : 'pending';
  const lines = [
    `feat(${sprintId}): ${autoSummary}`,
    '',
    `Sprint ${sprintId} close (status=${status}).`,
    `LOC +${locSummary.added}/-${locSummary.deleted} (net ${locSummary.net >= 0 ? `+${locSummary.net}` : `${locSummary.net}`}) across ${filesChanged} file(s).`,
    `Verification: ${verifiedAt}.`,
  ];

  if (extraMessage.length > 0) {
    lines.push('', extraMessage);
  }

  lines.push('', 'Co-authored-by: vibe-sprint-commit <bot@vibe-doctor>');
  return lines.join('\n');
}

function commitStaged(commitMessage, disableGpg) {
  const args = disableGpg
    ? ['-c', 'commit.gpgsign=false', 'commit', '-F', '-']
    : ['commit', '-F', '-'];

  try {
    const output = execFileSync('git', args, {
      encoding: 'utf8',
      input: commitMessage,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    process.stdout.write(output);
  } catch (error) {
    const stderr = typeof error.stderr === 'string' ? error.stderr : '';
    const stdout = typeof error.stdout === 'string' ? error.stdout : '';
    if (stdout.length > 0) {
      process.stdout.write(stdout);
    }
    if (stderr.length > 0) {
      process.stderr.write(stderr);
    }
    if (!disableGpg && /gpg/i.test(stderr)) {
      process.stderr.write('gpg signing failed - re-run with --no-verify-gpg to override\n');
    }
    process.exit(1);
  }
}

function parseHarnessVersionFromConfig(rawConfig) {
  const config = JSON.parse(rawConfig);
  const version = config?.harnessVersion;
  return typeof version === 'string' && /^\d+\.\d+\.\d+$/.test(version) ? version : null;
}

// CROSS-REF (migrations/1.4.0.mjs:compareVersions)
function compareVersions(left, right) {
  const leftParts = String(left ?? '')
    .replace(/^v/, '')
    .split('.')
    .map((part) => Number(part));
  const rightParts = String(right ?? '')
    .replace(/^v/, '')
    .split('.')
    .map((part) => Number(part));
  const length = Math.max(leftParts.length, rightParts.length);

  for (let index = 0; index < length; index += 1) {
    const diff = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (diff !== 0) {
      return diff;
    }
  }

  return 0;
}

function readCommittedHarnessVersion(ref) {
  try {
    return parseHarnessVersionFromConfig(execGit(['show', `${ref}:.vibe/config.json`]));
  } catch {
    return null;
  }
}

function tagExists(tagName) {
  const result = spawnSync('git', ['rev-parse', '--verify', `refs/tags/${tagName}`], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return (result.status ?? 1) === 0;
}

function errorStderr(error) {
  if (typeof error.stderr === 'string') {
    return error.stderr.trim();
  }
  if (Buffer.isBuffer(error.stderr)) {
    return error.stderr.toString('utf8').trim();
  }
  return String(error);
}

function createHarnessVersionTag(sprintId, pushTag) {
  const currentVersion = readCommittedHarnessVersion('HEAD');
  if (!currentVersion) {
    process.stdout.write('[vibe-sprint-commit] harness-tag: skipped (current harnessVersion not parseable)\n');
    return;
  }

  const previousVersion = readCommittedHarnessVersion('HEAD~1');
  if (!previousVersion) {
    process.stdout.write('[vibe-sprint-commit] harness-tag: skipped (no previous config.json to compare)\n');
    return;
  }

  if (compareVersions(currentVersion, previousVersion) <= 0) {
    process.stdout.write(
      `[vibe-sprint-commit] harness-tag: skipped (no upward version delta: ${previousVersion} -> ${currentVersion})\n`,
    );
    return;
  }

  const tagName = `v${currentVersion}`;
  if (tagExists(tagName)) {
    process.stdout.write(`[vibe-sprint-commit] harness-tag: skipped (tag ${tagName} already exists)\n`);
    return;
  }

  try {
    execFileSync('git', ['tag', '-a', tagName, '-m', `auto-tag from sprint-commit ${sprintId}`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    process.stdout.write(`[vibe-sprint-commit] harness-tag: FAILED to create ${tagName}: ${errorStderr(error)}\n`);
    return;
  }

  process.stdout.write(`[vibe-sprint-commit] harness-tag: created ${tagName} (prev=${previousVersion})\n`);

  if (!pushTag) {
    return;
  }

  try {
    execFileSync('git', ['push', 'origin', `refs/tags/${tagName}`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    process.stdout.write(`[vibe-sprint-commit] harness-tag: FAILED to push ${tagName}: ${errorStderr(error)}\n`);
  }
}

function main() {
  try {
    execGit(['rev-parse', '--show-toplevel']);
  } catch {
    fail('not a git repo');
  }

  const { sprintId, status, scope: cliScope, message, dryRun, disableGpg, pushTag } = parseArgs(process.argv);
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const completeScript = path.join(scriptDir, 'vibe-sprint-complete.mjs');
  const statusPath = resolve('.vibe/agent/sprint-status.json');
  const initialSprintStatus = loadSprintStatus(statusPath);
  const initialBlockedRisks = collectTargetedPendingRisks(initialSprintStatus, sprintId);

  if (initialBlockedRisks.length > 0) {
    process.stderr.write(
      `Refusing to commit: ${initialBlockedRisks.length} open pendingRisk(s) target this sprint. Resolve via resolvePendingRisk() or acknowledge first:\n`,
    );
    for (const risk of initialBlockedRisks) {
      process.stderr.write(`- ${risk.id}: ${risk.text}\n`);
    }
    process.exit(1);
  }

  const completeArgs = [completeScript, sprintId, status];
  if (cliScope.length > 0) {
    completeArgs.push('--scope', cliScope.join(','));
  }

  const delegated = spawnSync(process.execPath, completeArgs, { stdio: 'inherit' });
  if ((delegated.status ?? 1) !== 0) {
    process.exit(delegated.status ?? 1);
  }

  const changedFiles = detectChangedFiles();
  const detectedScope = changedFiles.filter(
    (relativePath) =>
      !STATE_FILES.has(relativePath) &&
      !relativePath.startsWith('.vibe/archive/') &&
      !relativePath.startsWith('.vibe/agent/daily/'),
  );
  const mergedScope = unique([...cliScope, ...detectedScope]);
  const mergedGlobs = unique(cliScope);

  inlineExtendLastSprintScope(statusPath, mergedScope, mergedGlobs);

  const sprintStatus = loadSprintStatus(statusPath);
  const blockedRisks = collectTargetedPendingRisks(sprintStatus, sprintId);
  if (blockedRisks.length > 0) {
    process.stderr.write(
      `Refusing to commit: ${blockedRisks.length} open pendingRisk(s) target this sprint. Resolve via resolvePendingRisk() or acknowledge first:\n`,
    );
    for (const risk of blockedRisks) {
      process.stderr.write(`- ${risk.id}: ${risk.text}\n`);
    }
    process.exit(1);
  }

  const stagedTargets = unique([
    '.vibe/agent/sprint-status.json',
    '.vibe/agent/handoff.md',
    '.vibe/agent/session-log.md',
    ...stageIfTrackedOrChanged(
      [
        '.vibe/agent/project-map.json',
        '.vibe/agent/sprint-api-contracts.json',
        '.vibe/agent/project-decisions.jsonl',
        'docs/plans/sprint-roadmap.md',
      ],
      changedFiles,
    ),
    ...collectArchivedPromptFiles(sprintId),
    ...changedFiles,
  ]);

  if (stagedTargets.length > 0) {
    execFileSync('git', ['add', '--', ...stagedTargets], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }

  const cachedQuiet = spawnSync('git', ['diff', '--cached', '--quiet'], { stdio: 'ignore' });
  if ((cachedQuiet.status ?? 1) === 0) {
    process.stdout.write('nothing to commit (already closed?)\n');
    process.exit(0);
  }

  const locSummary = computeLocSummary(loadLocExtensions());
  const stagedFileCount = gitLines(['diff', '--cached', '--name-only']).length;
  const commitMessage = buildCommitMessage(
    loadSprintStatus(statusPath),
    sprintId,
    status,
    message,
    stagedFileCount,
    locSummary,
  );

  if (dryRun) {
    process.stdout.write(
      `would commit: sprint=${sprintId} files=${stagedTargets.join(', ')} message="${commitMessage.split('\n')[0]}"\n`,
    );
    process.exit(0);
  }

  commitStaged(commitMessage, disableGpg);
  createHarnessVersionTag(sprintId, pushTag);
  const shortSha = execGit(['rev-parse', '--short', 'HEAD']);
  process.stdout.write(`[vibe-sprint-commit] committed ${shortSha} for ${sprintId}\n`);
}

const entryHref = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';

if (import.meta.url === entryHref) {
  try {
    main();
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}
