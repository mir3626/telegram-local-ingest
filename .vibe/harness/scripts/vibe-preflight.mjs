#!/usr/bin/env node
// vibe-preflight performs mechanical Sprint start checks.
// Replaces the former .vibe/agent/preflight.md runbook.
// Usage: node .vibe/harness/scripts/vibe-preflight.mjs [--json]

import { execFileSync, execSync, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path, { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const JSON_MODE = process.argv.includes('--json');
const BOOTSTRAP_MODE = process.argv.includes('--bootstrap');
const ACK_AUDIT_PREFIX = '--ack-audit-overdue=';
const results = [];
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const statusPath = resolve('.vibe/agent/sprint-status.json');
const handoffPath = resolve('.vibe/agent/handoff.md');
const sessionLogPath = resolve('.vibe/agent/session-log.md');
const iterationHistoryPath = resolve('.vibe/agent/iteration-history.json');

function record(id, ok, detail, level = 'ok') {
  results.push({ id, ok, detail, level });
}

function sh(cmd, opts = {}) {
  return execSync(cmd, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', ...opts }).trim();
}

function shFile(command, args, opts = {}) {
  return execFileSync(command, args, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', ...opts }).trim();
}

function checkProviderHealth(name, provider) {
  const isWin = process.platform === 'win32';
  const ext = isWin ? 'cmd' : 'sh';
  const wrapperPath = resolve('scripts', `run-${name}.${ext}`);
  const candidateWrappers = [];

  if (existsSync(wrapperPath)) {
    if (isWin) {
      candidateWrappers.push({
        command: process.env.ComSpec ?? 'cmd.exe',
        args: ['/d', '/c', wrapperPath, '--health'],
      });
    } else {
      candidateWrappers.push({ command: wrapperPath, args: ['--health'] });
    }
  }

  for (const wrapper of candidateWrappers) {
    try {
      const out = shFile(wrapper.command, wrapper.args);
      return { ok: true, detail: out.split('\n')[0], level: 'ok' };
    } catch (err) {
      const rc = err && typeof err.status === 'number' ? err.status : null;
      if (rc === 1) {
        return { ok: false, detail: `${name} CLI not found in PATH (wrapper --health rc=1)`, level: 'fail' };
      }
      if (rc === 2) {
        return { ok: false, detail: `${name} CLI present but authentication missing (wrapper --health rc=2)`, level: 'fail' };
      }
    }
  }

  try {
    const v = sh(`${provider.command} --version`);
    const hasWrapper = existsSync(wrapperPath);
    return {
      ok: true,
      detail: hasWrapper ? `${v.split('\n')[0]} (direct; wrapper not used)` : v.split('\n')[0],
      level: hasWrapper ? 'warn' : 'ok',
    };
  } catch {
    return {
      ok: false,
      detail: `${provider.command} CLI not found or not authenticated - check: ${provider.command} --version`,
      level: 'fail',
    };
  }
}

function parseIso(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    return null;
  }

  const time = Date.parse(value);
  return Number.isNaN(time) ? null : new Date(time);
}

function parseAckAuditArg() {
  const arg = process.argv.find((entry) => entry.startsWith(ACK_AUDIT_PREFIX));
  if (!arg) {
    return null;
  }

  const raw = arg.slice(ACK_AUDIT_PREFIX.length);
  const colonIndex = raw.indexOf(':');
  if (colonIndex === -1) {
    process.stderr.write('invalid --ack-audit-overdue format (expect <sprintId>:<reason>)\n');
    process.exit(1);
  }

  const sprintId = raw.slice(0, colonIndex).trim();
  const reason = raw.slice(colonIndex + 1).trim();
  if (!sprintId || !reason) {
    process.stderr.write('invalid --ack-audit-overdue format (expect <sprintId>:<reason>)\n');
    process.exit(1);
  }

  return { sprintId, reason };
}

function appendAuditAck(sessionLogFile, sprintId, reason) {
  if (!existsSync(sessionLogFile)) {
    return false;
  }

  const nowIso = new Date().toISOString();
  const entry = `- ${nowIso} [decision][audit-ack] sprint=${sprintId} reason=${reason}`;
  const content = readFileSync(sessionLogFile, 'utf8');
  if (content.includes(`[decision][audit-ack] sprint=${sprintId} reason=${reason}`)) {
    return true;
  }

  const entriesPattern = /(^## Entries\s*$\n?)/m;
  if (!entriesPattern.test(content)) {
    return false;
  }

  writeFileSync(sessionLogFile, content.replace(entriesPattern, `$1\n${entry}\n`), 'utf8');
  return true;
}

function readAuditSkippedModeDirective() {
  const configLocalPath = resolve('.vibe/config.local.json');
  if (!existsSync(configLocalPath)) {
    return { directive: null, note: '' };
  }

  try {
    const localConfig = JSON.parse(readFileSync(configLocalPath, 'utf8'));
    return {
      directive: localConfig?.userDirectives?.auditSkippedMode ?? null,
      note: '',
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      directive: null,
      note: ` config.local.json parse warning: ${message}`,
    };
  }
}

function activeAuditSkippedModeDetail(directive) {
  if (!directive || directive.enabled !== true) {
    return null;
  }

  const expiresAt = typeof directive.expiresAt === 'string' ? directive.expiresAt : '';
  const expiresMs = Date.parse(expiresAt);
  if (Number.isNaN(expiresMs) || expiresMs <= Date.now()) {
    return null;
  }

  const reason = typeof directive.reason === 'string' && directive.reason.trim().length > 0
    ? directive.reason.trim()
    : 'no reason recorded';
  const daysLeft = Math.ceil((expiresMs - Date.now()) / (24 * 60 * 60 * 1000));
  return `skipped by user directive "${reason}" (expires=${expiresAt}, ${daysLeft} day(s) left)`;
}

function runStateValidation() {
  const tsxLoader = [
    path.join(scriptDir, '..', 'node_modules', 'tsx', 'dist', 'loader.mjs'),
    path.join(scriptDir, '..', '..', '..', 'node_modules', 'tsx', 'dist', 'loader.mjs'),
  ].find((candidate) => existsSync(candidate));
  const tsxImport = tsxLoader ? pathToFileURL(tsxLoader).href : 'tsx';
  const validatorUrl = pathToFileURL(path.join(scriptDir, 'vibe-validate-state.ts')).href;
  const validatorImport = `await import(${JSON.stringify(validatorUrl)});`;
  const result = spawnSync(
    process.execPath,
    ['--import', tsxImport, '--input-type=module', '--eval', validatorImport],
    { encoding: 'utf8' },
  );

  if (result.status === 0) {
    record('state.schema', true, 'all present state files valid');
    return;
  }

  let parsed = null;
  try {
    parsed = JSON.parse(result.stderr || result.stdout || '{"errors":[]}');
  } catch {
    const detail = result.stderr || result.stdout || result.error?.message || 'state validation failed';
    record('state.schema', false, detail, 'fail');
    return;
  }

  const errors = Array.isArray(parsed.errors) ? parsed.errors : [];
  if (errors.length === 0) {
    record('state.schema', false, 'state validation failed without structured errors', 'fail');
    return;
  }

  for (const err of errors) {
    const file = typeof err.file === 'string' ? err.file : 'unknown';
    const message = typeof err.message === 'string' ? err.message : 'invalid state file';
    const suggestion = typeof err.fixSuggestion === 'string' ? `\n  suggest: ${err.fixSuggestion}` : '';
    record(`state.schema.${file}`, false, `${message}${suggestion}`, 'fail');
  }
}

function parseRoadmapIds(roadmapContent) {
  return Array.from(roadmapContent.matchAll(/^- \*\*id\*\*: `([^`]+)`/gm), (match) => match[1]).filter(
    (id) => typeof id === 'string' && id.trim() !== '',
  );
}

function parseIterationSections(roadmapContent) {
  const matches = Array.from(roadmapContent.matchAll(/^(#|##)\s+Iteration\s+(?:iter-)?(\d+)\b[^\n]*$/gm));

  return matches.flatMap((match, index) => {
    const startOffset = match.index;
    const iterationNumber = match[2];
    if (startOffset === undefined || iterationNumber === undefined) {
      return [];
    }

    const header = match[0];
    const nextStartOffset = matches[index + 1]?.index ?? roadmapContent.length;
    const bodyStartOffset = startOffset + header.length;
    const body = roadmapContent.slice(bodyStartOffset, nextStartOffset).replace(/^\r?\n/, '');

    return [
      {
        iterationId: `iter-${iterationNumber}`,
        header,
        body,
      },
    ];
  });
}

function normalizeIterationId(iterationId) {
  const match = iterationId.trim().match(/^(?:iter-)?(\d+)$/);
  return match?.[1] ? `iter-${match[1]}` : iterationId.trim();
}

function resolveNextSprintFromRoadmap(roadmapContent, currentIterationId, completedIds) {
  const sections = parseIterationSections(roadmapContent);
  if (sections.length === 0 || currentIterationId === null) {
    return {
      pendingId: parseRoadmapIds(roadmapContent).find((id) => !completedIds.has(id)) ?? null,
      scanScope: 'legacy-flat',
      iterationHeader: null,
    };
  }

  const normalizedCurrentIterationId = normalizeIterationId(currentIterationId);
  const section = sections.find((entry) => entry.iterationId === normalizedCurrentIterationId);
  if (!section) {
    return {
      pendingId: null,
      scanScope: 'iteration-scoped',
      iterationHeader: null,
    };
  }

  return {
    pendingId: parseRoadmapIds(section.body).find((id) => !completedIds.has(id)) ?? null,
    scanScope: 'iteration-scoped',
    iterationHeader: section.header,
  };
}

function readCurrentIterationId() {
  if (!existsSync(iterationHistoryPath)) {
    return null;
  }

  try {
    const history = JSON.parse(readFileSync(iterationHistoryPath, 'utf8'));
    return typeof history?.currentIteration === 'string' && history.currentIteration.trim() !== ''
      ? history.currentIteration.trim()
      : null;
  } catch {
    return null;
  }
}

function findPlannerPromptFile(pendingId) {
  const promptsDir = resolve('docs/prompts');
  if (!existsSync(promptsDir)) {
    return null;
  }

  const prefixes = [`sprint-${pendingId}-`];
  if (pendingId.startsWith('sprint-')) {
    prefixes.unshift(`${pendingId}-`);
  }

  const match = readdirSync(promptsDir)
    .filter((entry) => {
      if (!entry.endsWith('.md')) {
        return false;
      }

      const baseName = entry.slice(0, -'.md'.length);
      return baseName === pendingId || prefixes.some((prefix) => entry.startsWith(prefix));
    })
    .sort()[0];

  return match ? { path: path.join(promptsDir, match), name: match } : null;
}

function hasRecentPlannerSkipEntry(pendingId, stateUpdatedAt) {
  if (!existsSync(sessionLogPath)) {
    return false;
  }

  const stateTime = parseIso(stateUpdatedAt);
  if (!stateTime) {
    return false;
  }

  const content = readFileSync(sessionLogPath, 'utf8');
  return content.split(/\r?\n/).some((line) => {
    if (!line.includes('[decision][planner-skip]') || !line.includes(`sprint=${pendingId}`)) {
      return false;
    }

    const timestamp = line.match(/^- ([^ ]+) /)?.[1];
    const loggedAt = parseIso(timestamp);
    return loggedAt !== null && loggedAt.getTime() > stateTime.getTime();
  });
}

function runPlannerPresenceCheck() {
  try {
    if (BOOTSTRAP_MODE) {
      record('planner.presence', true, 'bootstrap mode - planner presence check skipped');
      return;
    }

    if (!sprintStatus) {
      record('planner.presence', true, 'no sprint-status.json yet (planner presence skipped)');
      return;
    }

    const roadmapPath = resolve('docs/plans/sprint-roadmap.md');
    if (!existsSync(roadmapPath)) {
      record('planner.presence', true, 'no roadmap IDs parseable (planner presence skipped)', 'info');
      return;
    }

    const completedIds = new Set(
      (Array.isArray(sprintStatus.sprints) ? sprintStatus.sprints : [])
        .filter((sprint) => sprint?.status === 'passed' && typeof sprint?.id === 'string')
        .map((sprint) => sprint.id),
    );
    const roadmapContent = readFileSync(roadmapPath, 'utf8');
    const currentIterationId = readCurrentIterationId();
    const resolvedRoadmap = resolveNextSprintFromRoadmap(roadmapContent, currentIterationId, completedIds);
    const pendingId = resolvedRoadmap.pendingId;

    if (resolvedRoadmap.scanScope === 'legacy-flat' && parseRoadmapIds(roadmapContent).length === 0) {
      record('planner.presence', true, 'no roadmap IDs parseable (planner presence skipped)', 'info');
      return;
    }

    if (resolvedRoadmap.scanScope === 'iteration-scoped' && resolvedRoadmap.iterationHeader === null) {
      record(
        'planner.presence',
        true,
        `current iteration ${currentIterationId ?? 'n/a'} not found in roadmap (planner presence skipped)`,
        'info',
      );
      return;
    }

    if (!pendingId) {
      const scopeDetail =
        resolvedRoadmap.scanScope === 'iteration-scoped'
          ? `all roadmap sprints completed for ${currentIterationId} (planner presence skipped)`
          : 'all roadmap sprints completed (planner presence skipped)';
      record('planner.presence', true, scopeDetail);
      return;
    }

    if (hasRecentPlannerSkipEntry(pendingId, sprintStatus.stateUpdatedAt)) {
      record('planner.presence', true, `planner intentionally skipped for ${pendingId} (recorded in session-log)`);
      return;
    }

    const promptFile = findPlannerPromptFile(pendingId);
    if (!promptFile) {
      record(
        'planner.presence',
        true,
        `next sprint ${pendingId} has no prompt file at docs/prompts/sprint-${pendingId}-*.md. Either summon sprint-planner (Agent subagent_type: 'sprint-planner') OR record an explicit skip with: node .vibe/harness/scripts/vibe-planner-skip-log.mjs ${pendingId} "<reason>"`,
        'warn',
      );
      return;
    }

    const stateUpdatedAt = parseIso(sprintStatus.stateUpdatedAt);
    if (stateUpdatedAt) {
      const promptMtime = statSync(promptFile.path).mtime.getTime();
      if (promptMtime <= stateUpdatedAt.getTime()) {
        record(
          'planner.presence',
          true,
          `prompt file is older than last state update (possibly stale from previous sprint - verify it's the intended prompt): docs/prompts/${promptFile.name}`,
          'warn',
        );
        return;
      }
    }

    record('planner.presence', true, `found: docs/prompts/${promptFile.name} (mtime newer than stateUpdatedAt)`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    record('planner.presence', true, `planner presence check errored: ${message} (non-blocking)`, 'info');
  }
}

const auditAck = parseAckAuditArg();

if (BOOTSTRAP_MODE) {
  record('state.schema', true, 'bootstrap mode - state schema check skipped');
} else {
  runStateValidation();
}

// 1. Git work tree
if (BOOTSTRAP_MODE) {
  record('git.worktree', true, 'bootstrap mode - git worktree check skipped');
} else {
  try {
    const inside = sh('git rev-parse --is-inside-work-tree');
    record('git.worktree', inside === 'true', inside || 'not a git repo');
  } catch {
    record(
      'git.worktree',
      false,
      'not a git repo - run: git init && git add -A && git -c commit.gpgsign=false commit -m "chore: initial scaffold"',
    );
  }
}

// 2. Git clean
if (BOOTSTRAP_MODE) {
  record('git.clean', true, 'bootstrap mode - git clean check skipped');
} else {
  try {
    const dirty = sh('git status --short');
    record('git.clean', dirty === '', dirty ? `uncommitted:\n${dirty}` : 'clean');
  } catch (e) {
    record('git.clean', false, e.message);
  }
}

// 3. package.json delta vs HEAD~1 (first-commit aware)
if (BOOTSTRAP_MODE) {
  record('deps.delta', true, 'bootstrap mode - dependency delta check skipped');
} else {
  try {
    const hasPkg = existsSync(resolve('package.json'));
    if (!hasPkg) {
      record('deps.delta', true, 'no package.json (skip)');
    } else {
      let hasParent = false;
      try {
        sh('git rev-parse HEAD~1');
        hasParent = true;
      } catch {
        hasParent = false;
      }

      if (!hasParent) {
        record('deps.delta', true, 'single-commit repo - baseline; run npm install once outside sandbox');
      } else {
        const diff = sh('git diff HEAD~1 HEAD -- package.json');
        record(
          'deps.delta',
          true,
          diff ? 'package.json changed since HEAD~1 - Orchestrator must run npm install outside sandbox' : 'no change',
        );
      }
    }
  } catch (e) {
    record('deps.delta', false, e.message);
  }
}

// 4. Provider health - dynamically from .vibe/config.json (or config.local.json)
const configPaths = [resolve('.vibe/config.local.json'), resolve('.vibe/config.json')];
let cfg = null;
for (const p of configPaths) {
  if (existsSync(p)) {
    try {
      cfg = JSON.parse(readFileSync(p, 'utf8'));
      break;
    } catch {
      // fall through
    }
  }
}

if (!cfg) {
  record('provider.config', false, 'no .vibe/config.json - run /vibe-init');
} else {
  const sprintRoles = cfg.sprintRoles ?? {};
  const providers = cfg.providers ?? {};
  const needed = new Set(
    Object.values(sprintRoles)
      .map((role) =>
        typeof role === 'string'
          ? role
          : role && typeof role === 'object' && typeof role.provider === 'string'
            ? role.provider
            : null,
      )
      .filter(Boolean),
  );
  if (needed.size === 0) {
    record('provider.config', true, 'no sprintRoles configured (skip health check)');
  } else {
    for (const name of needed) {
      const p = providers[name];
      if (!p || !p.command) {
        record(`provider.${name}`, false, `no command configured for "${name}" in .vibe/config.json providers`);
        continue;
      }

      const result = checkProviderHealth(name, p);
      record(`provider.${name}`, result.ok, result.detail, result.level);
    }
  }
}

// 5. Sprint status + handoff presence
let sprintStatus = null;
if (BOOTSTRAP_MODE) {
  record('sprint.status', true, 'bootstrap mode - sprint status check skipped');
} else {
  try {
    if (existsSync(statusPath)) {
      sprintStatus = JSON.parse(readFileSync(statusPath, 'utf8'));
      const vc = Array.isArray(sprintStatus.verificationCommands)
        ? sprintStatus.verificationCommands.length
        : 0;
      record(
        'sprint.status',
        true,
        `${vc} verification commands cumulative; handoff.currentSprintId=${sprintStatus.handoff?.currentSprintId ?? 'n/a'}`,
      );
    } else {
      record('sprint.status', true, 'no sprint-status.json yet (first sprint)');
    }
  } catch (e) {
    record('sprint.status', false, e.message);
  }
}

const hasHandoff = existsSync(handoffPath);
const hasSessionLog = existsSync(sessionLogPath);
if (BOOTSTRAP_MODE) {
  record('sprint.handoff', true, 'bootstrap mode - handoff check skipped');
} else {
  record(
    'sprint.handoff',
    hasHandoff && hasSessionLog,
    hasHandoff && hasSessionLog
      ? `handoff=${handoffPath}; sessionLog=${sessionLogPath}`
      : `missing handoff=${hasHandoff ? 'present' : handoffPath}; sessionLog=${hasSessionLog ? 'present' : sessionLogPath}`,
  );
}

try {
  if (BOOTSTRAP_MODE) {
    record('handoff.stale', true, 'bootstrap mode - handoff freshness check skipped');
  } else if (!existsSync(statusPath)) {
    record('handoff.stale', true, 'no sprint-status.json yet (freshness skipped)');
  } else {
    const updatedAt = parseIso(sprintStatus?.stateUpdatedAt);
    if (!updatedAt) {
      record(
        'handoff.stale',
        true,
        'stateUpdatedAt absent (pre-1.1.0 state - run .vibe/harness/migrations/1.1.0.mjs)',
        'info',
      );
    } else {
      const ageMs = Date.now() - updatedAt.getTime();
      const ageMinutes = Math.floor(ageMs / (60 * 1000));
      if (ageMs <= 5 * 60 * 1000) {
        record('handoff.stale', true, `fresh: stateUpdatedAt=${updatedAt.toISOString()}`);
      } else if (ageMs <= 24 * 60 * 60 * 1000) {
        record(
          'handoff.stale',
          true,
          `stateUpdatedAt=${updatedAt.toISOString()} (age=${ageMinutes} minutes)`,
          'info',
        );
      } else {
        const ageHours = Math.floor(ageMs / (60 * 60 * 1000));
        record(
          'handoff.stale',
          true,
          `stateUpdatedAt=${updatedAt.toISOString()} stale (age=${ageHours} hours). Run vibe-sprint-complete or refresh state.`,
          'warn',
        );
      }
    }
  }
} catch (e) {
  record('handoff.stale', true, `warning: unable to evaluate handoff freshness (${e.message})`, 'info');
}

// 6. product.md existence (Phase 0 gate)
if (BOOTSTRAP_MODE) {
  record('audit.overdue', true, 'bootstrap mode - audit gate skipped');
} else if (sprintStatus) {
  const auditEveryN = Number.isInteger(cfg?.audit?.everyN) ? cfg.audit.everyN : 5;
  const pendingRisks = Array.isArray(sprintStatus.pendingRisks) ? sprintStatus.pendingRisks : [];
  const openAuditRisks = pendingRisks.filter(
    (risk) => risk?.status === 'open' && typeof risk?.id === 'string' && risk.id.startsWith('audit-'),
  );
  const counter = Number.isInteger(sprintStatus.sprintsSinceLastAudit)
    ? sprintStatus.sprintsSinceLastAudit
    : 0;
  const overdueByCount = counter >= auditEveryN;
  const overdueByRisks = openAuditRisks.length > 0;

  if (overdueByCount || overdueByRisks) {
    if (auditAck) {
      const appended = appendAuditAck(sessionLogPath, auditAck.sprintId, auditAck.reason);
      record(
        'audit.overdue',
        appended,
        appended
          ? `acknowledged: sprint=${auditAck.sprintId} reason=${auditAck.reason}`
          : `ack requested but session-log missing or lacks ## Entries: ${sessionLogPath}`,
        appended ? 'warn' : 'fail',
      );
    } else {
      const reason = overdueByCount
        ? `sprintsSinceLastAudit=${counter} >= ${auditEveryN}`
        : `${openAuditRisks.length} open audit-* pendingRisks`;
      const skippedMode = readAuditSkippedModeDirective();
      const skippedDetail = activeAuditSkippedModeDetail(skippedMode.directive);
      if (skippedDetail) {
        record('audit.overdue', true, skippedDetail, 'warn');
      } else {
        record(
          'audit.overdue',
          false,
          `${reason}. audit required - run vibe-audit-clear or acknowledge with --ack-audit-overdue=<sprintId>:<reason>${skippedMode.note}`,
          'fail',
        );
      }
    }
  } else {
    record('audit.overdue', true, `ok (counter=${counter}/${auditEveryN})`);
  }
} else {
  record('audit.overdue', true, 'no sprint-status.json yet (audit gate skipped)');
}

const productPath = resolve('docs/context/product.md');
const hasProduct = existsSync(productPath);
if (hasProduct) {
  const content = readFileSync(productPath, 'utf8').trim();
  record(
    'phase0.product',
    content.length > 50,
    content.length > 50 ? 'product.md present and populated' : 'product.md exists but too short (<50 chars)',
  );
} else {
  record('phase0.product', false, 'missing docs/context/product.md - run Phase 0 native interview (vibe-interview.mjs) first');
}

// 7. Harness version check
try {
  const config = JSON.parse(readFileSync(resolve('.vibe/config.json'), 'utf8'));
  if (config.harnessVersion && config.harnessVersionInstalled) {
    if (config.harnessVersion !== config.harnessVersionInstalled) {
      record(
        'harness.version',
        true,
        `installed: ${config.harnessVersionInstalled}, available: ${config.harnessVersion}. Run: npm run vibe:sync`,
      );
    } else {
      record('harness.version', true, `v${config.harnessVersion}`);
    }
  } else {
    record('harness.version', true, 'no version tracking configured');
  }
} catch {
  record('harness.version', true, 'version check skipped');
}

// 8. Optional orchestration shard presence
const orchestrationPath = resolve('docs/context/orchestration.md');
if (existsSync(orchestrationPath)) {
  record('orchestration.doc', true, 'present');
} else {
  record('orchestration.doc', true, 'missing (optional shard - v1.1.0+)');
}

// 9. Planner presence check (non-blocking warn)
//
// Derives the next pending sprint from sprint-status.json + sprint-roadmap.md.
// If the next sprint has no corresponding docs/prompts/sprint-<id>-*.md whose
// mtime is newer than sprintStatus.stateUpdatedAt, emit WARN with guidance to
// either summon the sprint-planner agent OR record a [decision][planner-skip]
// entry via .vibe/harness/scripts/vibe-planner-skip-log.mjs.
runPlannerPresenceCheck();

if (JSON_MODE) {
  process.stdout.write(JSON.stringify(results, null, 2) + '\n');
} else {
  for (const r of results) {
    const mark = r.ok ? (r.level === 'info' ? 'INFO' : r.level === 'warn' ? 'WARN' : 'OK ') : 'FAIL';
    process.stdout.write(`[${mark}] ${r.id} - ${r.detail}\n`);
  }
}

const anyFail = results.some((r) => !r.ok);
process.exit(anyFail ? 1 : 0);
