#!/usr/bin/env node

import { execFileSync, execSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path, { resolve } from 'node:path';

const APP_CODE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.py', '.rs', '.go']);
const DEFAULT_PROJECT_ROOTS = ['src'];
const DEFAULT_PROTOTYPE_LOC_THRESHOLD = 2000;
const SKIP_APP_CODE_DIRS = new Set([
  '.git',
  '.next',
  '.turbo',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'out',
]);

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function sh(command) {
  return execSync(command, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' }).trim();
}

function trySh(command) {
  try {
    return sh(command);
  } catch {
    return null;
  }
}

function tryGit(args) {
  try {
    return execFileSync('git', args, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

function parseArgs(argv) {
  const sprintId = argv.find((arg) => !arg.startsWith('--'));
  const prevCommitArg = argv.find((arg) => arg.startsWith('--prev-commit='));
  return {
    sprintId,
    prevCommit: prevCommitArg?.slice('--prev-commit='.length) ?? null,
  };
}

function diffRange(prevCommit) {
  if (prevCommit) {
    return `${prevCommit}..HEAD`;
  }
  if (tryGit(['rev-parse', '--verify', 'HEAD~1']) !== null) {
    return 'HEAD~1..HEAD';
  }
  if (tryGit(['rev-parse', '--verify', 'HEAD']) !== null) {
    return 'HEAD';
  }
  return null;
}

function parseNumstat(numstat) {
  let added = 0;
  let deleted = 0;
  const extensions = {};
  const files = [];

  for (const line of numstat.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    const [addRaw, delRaw, filePath] = line.split(/\t/);
    const add = Number(addRaw);
    const del = Number(delRaw);
    if (Number.isFinite(add)) {
      added += add;
    }
    if (Number.isFinite(del)) {
      deleted += del;
    }
    if (filePath) {
      files.push(filePath);
      const ext = path.extname(filePath) || '<none>';
      extensions[ext] = (extensions[ext] ?? 0) + 1;
    }
  }

  return {
    filesChanged: files.length,
    added,
    deleted,
    net: added - deleted,
    extensions,
    files,
  };
}

function changedFilesForRange(range) {
  if (!range) {
    return { filesChanged: 0, added: 0, deleted: 0, net: 0, extensions: {}, files: [] };
  }

  const args = range === 'HEAD' ? ['show', '--numstat', '--format=', '--root', 'HEAD'] : ['diff', '--numstat', range];
  const out = tryGit(args);
  return parseNumstat(out ?? '');
}

function commitMessage(range) {
  if (!range) {
    return '';
  }
  if (range === 'HEAD') {
    return tryGit(['show', '-s', '--format=%B', 'HEAD']) ?? '';
  }
  return tryGit(['log', '--format=%B', range]) ?? '';
}

function extractSpecKeywords(message) {
  const pairs = [];
  const pattern = /\b(rate-limit|limit|max|min|cap|ttl|quota)\b\s*[:=]?\s*(\d+\s*(?:\/[a-z]+|m|s|ms|h|d)?)/gi;
  for (const match of message.matchAll(pattern)) {
    const keyword = match[1];
    const value = match[2];
    if (keyword && value) {
      pairs.push({ keyword: keyword.toLowerCase(), value: value.trim() });
    }
  }
  return pairs;
}

function fileContains(filePath, needle) {
  try {
    return readFileSync(resolve(filePath), 'utf8').includes(needle);
  } catch {
    return false;
  }
}

function flagSpecKeywordMismatches(flags, pairs, files) {
  for (const pair of pairs) {
    const numeric = pair.value.match(/\d+/)?.[0] ?? pair.value;
    const found = files.some((filePath) => fileContains(filePath, pair.keyword) || fileContains(filePath, numeric));
    if (!found) {
      flags.push({
        id: 'spec-keyword-mismatch',
        text: `commit mentions ${pair.keyword}=${pair.value}, but touched files do not contain the keyword or value`,
      });
    }
  }
}

function expectedTestPath(srcFile) {
  const base = path.basename(srcFile, path.extname(srcFile));
  return path.join('test', `${base}.test.ts`).replace(/\\/g, '/');
}

function flagMissingTests(flags, files) {
  for (const filePath of files) {
    const normalized = filePath.replace(/\\/g, '/');
    if (!normalized.startsWith('src/') || !normalized.endsWith('.ts')) {
      continue;
    }
    const testPath = expectedTestPath(normalized);
    if (!existsSync(resolve(testPath))) {
      flags.push({
        id: 'missing-src-test',
        text: `${normalized} has no ${testPath}`,
      });
    }
  }
}

function actualLocHistory() {
  const statusPath = resolve('.vibe/agent/sprint-status.json');
  if (!existsSync(statusPath)) {
    return [];
  }
  try {
    const status = JSON.parse(readFileSync(statusPath, 'utf8'));
    return Array.isArray(status.sprints)
      ? status.sprints.map((entry) => entry?.actualLoc?.net).filter((value) => Number.isFinite(value))
      : [];
  } catch {
    return [];
  }
}

function flagLocOutlier(flags, netLoc) {
  const history = actualLocHistory();
  if (history.length < 3) {
    return;
  }
  const mean = history.reduce((sum, value) => sum + value, 0) / history.length;
  const variance = history.reduce((sum, value) => sum + (value - mean) ** 2, 0) / history.length;
  const sigma = Math.sqrt(variance);
  if (sigma > 0 && Math.abs(netLoc - mean) > sigma * 3) {
    flags.push({
      id: 'loc-outlier',
      text: `net LOC ${netLoc} outside historical mean ${mean.toFixed(1)} +/- 3 sigma`,
    });
  }
}

function readJsonIfExists(relativePath) {
  const filePath = resolve(relativePath);
  if (!existsSync(filePath)) {
    return {};
  }

  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return {};
  }
}

function auditSettings() {
  const shared = readJsonIfExists('.vibe/config.json');
  const local = readJsonIfExists('.vibe/config.local.json');
  const sharedAudit = typeof shared?.audit === 'object' && shared.audit !== null ? shared.audit : {};
  const localAudit = typeof local?.audit === 'object' && local.audit !== null ? local.audit : {};
  const audit = { ...sharedAudit, ...localAudit };
  const projectRoots = Array.isArray(audit.projectRoots)
    ? audit.projectRoots.filter((entry) => typeof entry === 'string' && entry.trim().length > 0)
    : DEFAULT_PROJECT_ROOTS;
  const rawThreshold = Number(audit.prototypeLocThreshold);

  return {
    projectRoots: projectRoots.length > 0 ? projectRoots : DEFAULT_PROJECT_ROOTS,
    prototypeLocThreshold: Number.isFinite(rawThreshold)
      ? rawThreshold
      : DEFAULT_PROTOTYPE_LOC_THRESHOLD,
  };
}

function lineCount(filePath) {
  const text = readFileSync(filePath, 'utf8');
  if (text.length === 0) {
    return 0;
  }
  const lines = text.split(/\r?\n/);
  return text.endsWith('\n') ? lines.length - 1 : lines.length;
}

function walkAppCode(filePath, matches) {
  if (!existsSync(filePath)) {
    return;
  }

  const stat = statSync(filePath);
  if (stat.isFile()) {
    if (APP_CODE_EXTENSIONS.has(path.extname(filePath))) {
      matches.add(resolve(filePath));
    }
    return;
  }

  if (!stat.isDirectory()) {
    return;
  }

  for (const entry of readdirSync(filePath, { withFileTypes: true })) {
    if (entry.isDirectory() && SKIP_APP_CODE_DIRS.has(entry.name)) {
      continue;
    }
    walkAppCode(path.join(filePath, entry.name), matches);
  }
}

function appCodeLocSummary() {
  const settings = auditSettings();
  const files = new Set();

  for (const root of settings.projectRoots) {
    walkAppCode(resolve(root), files);
  }

  const total = [...files].reduce((sum, filePath) => sum + lineCount(filePath), 0);
  return {
    projectRoots: settings.projectRoots.map((entry) => entry.replace(/\\/g, '/')),
    prototypeLocThreshold: settings.prototypeLocThreshold,
    files: files.size,
    total,
  };
}

function flagPrototypeLocThreshold(flags, appLoc) {
  if (appLoc.total <= appLoc.prototypeLocThreshold) {
    return;
  }

  flags.push({
    id: 'app-loc-threshold',
    level: 'INFO',
    code: 'LOC_THRESHOLD_BREACH',
    text: `app LOC ${appLoc.total} > ${appLoc.prototypeLocThreshold} across ${appLoc.files} files (${appLoc.projectRoots.join(', ')}) - Evaluator prototype exception is disabled`,
  });
}

function walk(dir, matches) {
  if (!existsSync(dir)) {
    return;
  }
  for (const entry of readdirSync(dir)) {
    const filePath = path.join(dir, entry);
    const stat = statSync(filePath);
    if (stat.isDirectory()) {
      walk(filePath, matches);
    } else if (/^tmp-.*\.(ts|mjs)$/.test(entry)) {
      matches.push(filePath.replace(/\\/g, '/'));
    }
  }
}

function flagTmpScripts(flags) {
  const matches = [];
  walk(resolve('scripts'), matches);
  for (const match of matches) {
    flags.push({
      id: 'tmp-script-residue',
      text: `${path.relative(process.cwd(), match).replace(/\\/g, '/')} remains in scripts/`,
    });
  }
}

function injectRisk(sprintId, flags) {
  if (flags.length === 0) {
    return false;
  }

  const statusPath = resolve('.vibe/agent/sprint-status.json');
  if (!existsSync(statusPath)) {
    return false;
  }

  const status = JSON.parse(readFileSync(statusPath, 'utf8'));
  if (!Array.isArray(status.pendingRisks)) {
    status.pendingRisks = [];
  }

  const id = `lightweight-audit-${sprintId}`;
  if (status.pendingRisks.some((entry) => entry?.id === id)) {
    return false;
  }

  const locThresholdFlag = flags.find((flag) => flag.code === 'LOC_THRESHOLD_BREACH');
  const pendingRisk = {
    id,
    raisedBy: 'vibe-audit-lightweight',
    targetSprint: '*',
    text: flags.map((flag) => flag.text).join('; '),
    status: 'open',
    createdAt: new Date().toISOString(),
  };

  if (locThresholdFlag) {
    pendingRisk.level = locThresholdFlag.level ?? 'INFO';
    pendingRisk.code = locThresholdFlag.code;
    pendingRisk.message = locThresholdFlag.text;
  }

  status.pendingRisks.push(pendingRisk);
  writeFileSync(statusPath, `${JSON.stringify(status, null, 2)}\n`, 'utf8');
  return true;
}

try {
  const { sprintId, prevCommit } = parseArgs(process.argv.slice(2));
  if (!sprintId) {
    fail('Usage: node scripts/vibe-audit-lightweight.mjs <sprintId> [--prev-commit=<sha>]');
  }

  const range = diffRange(prevCommit);
  const diff = changedFilesForRange(range);
  const flags = [];

  const pairs = extractSpecKeywords(commitMessage(range));
  const appLoc = appCodeLocSummary();
  flagSpecKeywordMismatches(flags, pairs, diff.files);
  flagMissingTests(flags, diff.files);
  flagLocOutlier(flags, diff.net);
  flagTmpScripts(flags);
  flagPrototypeLocThreshold(flags, appLoc);

  const risksInjected = injectRisk(sprintId, flags);
  process.stdout.write(
    `${JSON.stringify({ sprintId, diff, appLoc, flags, risksInjected }, null, 2)}\n`,
  );
  process.exit(0);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
