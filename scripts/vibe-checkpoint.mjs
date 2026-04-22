#!/usr/bin/env node
// vibe-checkpoint performs mechanical PreCompact checks.
// Usage: node scripts/vibe-checkpoint.mjs [--json]

import { execSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

const JSON_MODE = process.argv.includes('--json');
const results = [];

function record(id, ok, detail) {
  results.push({ id, ok, detail });
}

function sh(cmd, opts = {}) {
  return execSync(cmd, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', ...opts }).trim();
}

function parseIso(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    return null;
  }

  const time = Date.parse(value);
  return Number.isNaN(time) ? null : new Date(time);
}

function getLastCommitDate() {
  try {
    const value = sh('git log -1 --format=%cI');
    return parseIso(value);
  } catch {
    return null;
  }
}

const handoffPath = resolve('.vibe/agent/handoff.md');
const sessionLogPath = resolve('.vibe/agent/session-log.md');
const statusPath = resolve('.vibe/agent/sprint-status.json');

record('handoff.exists', existsSync(handoffPath), existsSync(handoffPath) ? handoffPath : `missing: ${handoffPath}`);
record('session-log.exists', existsSync(sessionLogPath), existsSync(sessionLogPath) ? sessionLogPath : `missing: ${sessionLogPath}`);

let status = null;
let statusOk = false;
try {
  if (!existsSync(statusPath)) {
    record('status.exists', false, `missing: ${statusPath}`);
  } else {
    status = JSON.parse(readFileSync(statusPath, 'utf8'));
    statusOk = true;
    record('status.exists', true, statusPath);
  }
} catch (e) {
  record('status.exists', false, `${statusPath}: ${e.message}`);
}

try {
  if (!existsSync(handoffPath)) {
    record('handoff.fresh', false, `handoff missing: ${handoffPath}`);
  } else if (!statusOk) {
    record('handoff.fresh', false, 'sprint-status.json unavailable for freshness check');
  } else {
    const updatedAt = parseIso(status?.handoff?.updatedAt);
    const mtime = statSync(handoffPath).mtime;
    const freshest = [updatedAt, mtime]
      .filter(Boolean)
      .sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
    const lastCommit = getLastCommitDate();
    const recentCutoff = Date.now() - (30 * 60 * 1000);
    const freshByTime = freshest ? freshest.getTime() >= recentCutoff : false;
    const freshByCommit = freshest && lastCommit ? freshest.getTime() >= lastCommit.getTime() : false;
    const updatedAtText = updatedAt ? updatedAt.toISOString() : String(status?.handoff?.updatedAt ?? 'n/a');
    const mtimeText = mtime.toISOString();
    const lastCommitText = lastCommit ? lastCommit.toISOString() : 'n/a';

    if (freshByTime || freshByCommit) {
      record('handoff.fresh', true, `updatedAt=${updatedAtText}, mtime=${mtimeText}, lastCommit=${lastCommitText}`);
    } else {
      record('handoff.fresh', false, `handoff stale: updatedAt=${updatedAtText}, mtime=${mtimeText}, lastCommit=${lastCommitText}`);
    }
  }
} catch (e) {
  record('handoff.fresh', false, e.message);
}

try {
  if (!existsSync(sessionLogPath)) {
    record('session-log.not-empty', false, `session-log missing: ${sessionLogPath}`);
  } else {
    const content = readFileSync(sessionLogPath, 'utf8');
    const entriesIndex = content.search(/^## Entries\s*$/m);

    if (entriesIndex === -1) {
      record('session-log.not-empty', false, 'missing "## Entries" section');
    } else {
      const entriesContent = content.slice(entriesIndex);
      const bulletCount = (entriesContent.match(/^- /gm) ?? []).length;
      record('session-log.not-empty', bulletCount > 0, bulletCount > 0 ? `${bulletCount} entries` : 'no bullet entries under ## Entries');
    }
  }
} catch (e) {
  record('session-log.not-empty', false, e.message);
}

try {
  if (!statusOk) {
    record('context.budget', false, 'sprint-status.json unavailable for context budget check');
  } else {
    const budget = status?.handoff?.orchestratorContextBudget;
    const valid = budget === 'low' || budget === 'medium' || budget === 'high';

    if (!valid) {
      record('context.budget', false, `invalid orchestratorContextBudget: ${String(budget)}`);
    } else if (budget === 'high') {
      record('context.budget', true, 'warning: orchestratorContextBudget=high');
    } else {
      record('context.budget', true, `orchestratorContextBudget=${budget}`);
    }
  }
} catch (e) {
  record('context.budget', false, e.message);
}

if (JSON_MODE) {
  process.stdout.write(JSON.stringify(results, null, 2) + '\n');
} else {
  for (const r of results) {
    const mark = r.ok ? 'OK ' : 'FAIL';
    process.stdout.write(`[${mark}] ${r.id} - ${r.detail}\n`);
  }
}

const anyFail = results.some((r) => !r.ok);
if (anyFail) {
  process.stderr.write('PreCompact blocked — update .vibe/agent/handoff.md + session-log.md then retry.\n');
}
process.exit(anyFail ? 1 : 0);
