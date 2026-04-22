#!/usr/bin/env node

import { spawnSync, execSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path, { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function warn(message) {
  process.stderr.write(`Warning: ${message}\n`);
}

function logStep(name, status, detail = '') {
  const suffix = detail.length > 0 ? ` ${detail}` : '';
  process.stderr.write(`[vibe-sprint-complete] step=${name} status=${status}${suffix}\n`);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function sh(cmd) {
  return execSync(cmd, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' }).trim();
}

function trySh(cmd) {
  try {
    return sh(cmd);
  } catch {
    return null;
  }
}

function parseShortStat(shortstat) {
  const text = shortstat.trim();
  const filesChanged = Number(text.match(/(\d+)\s+files?\s+changed/)?.[1] ?? 0);
  const added = Number(text.match(/(\d+)\s+insertions?\(\+\)/)?.[1] ?? 0);
  const deleted = Number(text.match(/(\d+)\s+deletions?\(-\)/)?.[1] ?? 0);
  return {
    added,
    deleted,
    net: added - deleted,
    filesChanged,
  };
}

function getActualLoc() {
  const hasHead = trySh('git rev-parse --verify HEAD');
  if (!hasHead) {
    return null;
  }

  const hasParent = trySh('git rev-parse --verify HEAD~1');
  const shortstat = hasParent
    ? trySh('git diff --shortstat HEAD~1 HEAD')
    : trySh('git show --shortstat --format= --root HEAD');

  if (shortstat === null) {
    return null;
  }

  return parseShortStat(shortstat);
}

function formatNet(value) {
  return value >= 0 ? `+${value}` : `${value}`;
}

function parseScopeValue(value) {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function readAuditEveryN() {
  const configPath = resolve('.vibe/config.json');
  if (!existsSync(configPath)) {
    return 5;
  }

  try {
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    return Number.isInteger(config?.audit?.everyN) ? config.audit.everyN : 5;
  } catch {
    return 5;
  }
}

function normalizeScopeEntries(entries) {
  const seen = new Set();
  const merged = [];

  for (const rawEntry of entries) {
    const entry = rawEntry.replace(/\\/g, '/');
    if (seen.has(entry)) {
      continue;
    }
    seen.add(entry);
    merged.push(entry);
  }

  return merged;
}

export function parseRoadmapSprintIds(roadmapMd) {
  const lines = roadmapMd.split(/\r?\n/);
  const sprintIds = [];

  for (let index = 0; index < lines.length; index += 1) {
    if (!/^## Sprint M\d+/.test(lines[index] ?? '')) {
      continue;
    }

    let matchedId = null;
    for (let offset = 1; offset <= 12; offset += 1) {
      const line = lines[index + offset];
      if (line === undefined || /^## /.test(line)) {
        break;
      }

      const match = line.match(/^\s*[-*]\s+\*\*id\*\*:\s*`([^`]+)`/);
      if (match?.[1]) {
        matchedId = match[1];
        break;
      }
    }

    if (matchedId) {
      sprintIds.push(matchedId);
    } else {
      process.stderr.write(`[vibe-sprint-complete] warning=roadmap-id-missing headingLine=${index + 1}\n`);
    }
  }

  return sprintIds;
}

function parseCompletedSprintIds(sessionLogMd) {
  const completed = [];
  const seen = new Set();
  const lines = sessionLogMd.split(/\r?\n/);

  for (const line of lines) {
    const match = line.match(/^\-\s+\S+\s+\[sprint-complete\]\s+([^\s]+)\s+\->\s+passed\b/);
    const sprintId = match?.[1];
    if (!sprintId || seen.has(sprintId)) {
      continue;
    }

    seen.add(sprintId);
    completed.push(sprintId);
  }

  return completed;
}

function readIterationCompletionState(sprintId) {
  const iterationPath = resolve('.vibe/agent/iteration-history.json');
  if (!existsSync(iterationPath)) {
    return true;
  }

  try {
    const history = JSON.parse(readFileSync(iterationPath, 'utf8'));
    const iterations = Array.isArray(history.iterations) ? history.iterations : [];
    const current = iterations.find((entry) => entry?.id === history.currentIteration);
    if (!current) {
      return true;
    }

    const planned = Array.isArray(current.plannedSprints) ? current.plannedSprints : [];
    const completed = new Set(
      Array.isArray(current.completedSprints) ? current.completedSprints : [],
    );
    completed.add(sprintId);
    return planned.length === 0 || planned.every((plannedSprintId) => completed.has(plannedSprintId));
  } catch {
    return false;
  }
}

function recordIterationSprintCompletion(sprintId, status) {
  if (status !== 'passed') {
    return false;
  }

  const iterationPath = resolve('.vibe/agent/iteration-history.json');
  if (!existsSync(iterationPath)) {
    return false;
  }

  const history = JSON.parse(readFileSync(iterationPath, 'utf8'));
  const iterations = Array.isArray(history.iterations) ? history.iterations : [];
  const current =
    iterations.find((entry) => entry?.id === history.currentIteration) ??
    iterations.find(
      (entry) =>
        entry?.completedAt === null &&
        Array.isArray(entry.plannedSprints) &&
        entry.plannedSprints.includes(sprintId),
    );

  if (!current) {
    return false;
  }

  if (!Array.isArray(current.completedSprints)) {
    current.completedSprints = [];
  }
  if (current.completedSprints.includes(sprintId)) {
    return false;
  }

  current.completedSprints.push(sprintId);
  writeFileSync(iterationPath, `${JSON.stringify(history, null, 2)}\n`, 'utf8');
  return true;
}

function shouldAutoProjectReport(sprintId, status, noAutoReport) {
  if (noAutoReport || status !== 'passed') {
    return false;
  }

  const roadmapPath = resolve('docs/plans/sprint-roadmap.md');
  if (!existsSync(roadmapPath)) {
    return false;
  }

  const roadmapSprintIds = parseRoadmapSprintIds(readFileSync(roadmapPath, 'utf8'));
  return (
    roadmapSprintIds.length > 0 &&
    roadmapSprintIds[roadmapSprintIds.length - 1] === sprintId &&
    readIterationCompletionState(sprintId)
  );
}

function runProjectReport() {
  const reportScript = resolve('scripts/vibe-project-report.mjs');
  if (!existsSync(reportScript)) {
    logStep('project-report', 'warn', 'detail=script-missing');
    return;
  }

  const result = spawnSync(process.execPath, [reportScript], { stdio: 'inherit' });
  if (result.status === 0) {
    logStep('project-report', 'ok');
    return;
  }
  if (result.error) {
    logStep('project-report', 'warn', `detail=${result.error.message}`);
    return;
  }
  logStep('project-report', 'warn', `detail=exit-${result.status ?? 1}`);
}

function tsxImportSpecifier(scriptDir) {
  const tsxLoader = path.join(scriptDir, '..', 'node_modules', 'tsx', 'dist', 'loader.mjs');
  return existsSync(tsxLoader) ? pathToFileURL(tsxLoader).href : 'tsx';
}

function validateStateOrFail(scriptDir) {
  const result = spawnSync(
    process.execPath,
    ['--import', tsxImportSpecifier(scriptDir), path.join(scriptDir, 'vibe-validate-state.ts')],
    {
      encoding: 'utf8',
    },
  );
  if (result.status === 0) {
    logStep('state-validate', 'ok');
    return;
  }

  const detail = result.stderr || result.stdout || result.error?.message || `exit-${result.status ?? 1}`;
  fail(`state validation failed before sprint completion write: ${detail}`);
}

function runLightweightAudit(scriptDir, sprintId) {
  const scriptPath = path.join(scriptDir, 'vibe-audit-lightweight.mjs');
  if (!existsSync(scriptPath)) {
    logStep('lightweight-audit', 'warn', 'detail=script-missing');
    return;
  }

  const result = spawnSync(process.execPath, [scriptPath, sprintId], {
    encoding: 'utf8',
  });
  if (result.stdout) {
    process.stderr.write(result.stdout);
  }
  if (result.status === 0) {
    logStep('lightweight-audit', 'ok');
    return;
  }

  const detail = result.stderr || result.error?.message || `exit-${result.status ?? 1}`;
  logStep('lightweight-audit', 'warn', `detail=${detail.trim()}`);
}

function emitSprintCompletedDailyEvent(sprintId, status, summary, actualLoc, scriptDir) {
  const eventType =
    status === 'passed' ? 'sprint-completed' : status === 'failed' ? 'sprint-failed' : null;
  if (!eventType) {
    return { stepStatus: 'skip', detail: 'detail=status-not-emitted' };
  }

  const payload = {
    sprintId,
    status,
    summary,
    ...(actualLoc ? { loc: actualLoc } : {}),
  };
  const root = process.cwd();
  const scriptPath = path.join(scriptDir, 'vibe-daily-log.mjs');
  const result = spawnSync(
    process.execPath,
    [scriptPath, eventType, '--payload', JSON.stringify(payload)],
    {
      cwd: root,
      env: { ...process.env, VIBE_ROOT: root },
      stdio: 'ignore',
    },
  );

  if (result.status === 0) {
    return { stepStatus: 'ok', detail: `type=${eventType}` };
  }
  if (result.error) {
    return { stepStatus: 'warn', detail: `detail=${result.error.message}` };
  }
  return { stepStatus: 'warn', detail: `detail=exit-${result.status ?? 1}` };
}

export function computeCurrentPointerBlock(
  roadmapMd,
  sessionLogMd,
  lastSprintId,
  startedDateIso = new Date().toISOString().slice(0, 10),
) {
  const roadmapSprintIds = parseRoadmapSprintIds(roadmapMd);
  const completed = parseCompletedSprintIds(sessionLogMd);
  const completedSet = new Set(completed);
  const lastIndex = roadmapSprintIds.indexOf(lastSprintId);
  const activeSprintId =
    lastIndex >= 0 && lastIndex + 1 < roadmapSprintIds.length
      ? roadmapSprintIds[lastIndex + 1]
      : 'idle';
  const pending = roadmapSprintIds.filter(
    (sprintId) => !completedSet.has(sprintId) && sprintId !== activeSprintId,
  );

  return [
    '<!-- BEGIN:VIBE:CURRENT-SPRINT -->',
    `> **Current**: ${activeSprintId} (not started, started ${startedDateIso})`,
    `> **Completed**: ${completed.length > 0 ? completed.join(', ') : '—'}`,
    `> **Pending**: ${pending.length > 0 ? pending.join(', ') : '—'}`,
    '<!-- END:VIBE:CURRENT-SPRINT -->',
  ].join('\n');
}

function replaceCurrentPointerBlock(roadmapMd, nextBlock) {
  const blockPattern =
    /<!-- BEGIN:VIBE:CURRENT-SPRINT -->[\s\S]*?<!-- END:VIBE:CURRENT-SPRINT -->/;
  if (!blockPattern.test(roadmapMd)) {
    return null;
  }

  return roadmapMd.replace(blockPattern, nextBlock);
}

function moveFileOverwrite(sourcePath, destinationPath) {
  try {
    renameSync(sourcePath, destinationPath);
  } catch (error) {
    if (existsSync(destinationPath)) {
      unlinkSync(destinationPath);
      renameSync(sourcePath, destinationPath);
      return;
    }
    throw error;
  }
}

export function archiveSprintPrompts(sprintId, rootDir = process.cwd()) {
  const promptDir = resolve(rootDir, 'docs/prompts');
  if (!existsSync(promptDir)) {
    return [];
  }

  const archiveDir = resolve(rootDir, '.vibe/archive/prompts');
  mkdirSync(archiveDir, { recursive: true });

  const matches = readdirSync(promptDir).filter((entry) => {
    if (!entry.endsWith('.md')) {
      return false;
    }

    const base = entry.slice(0, -3);
    return base === sprintId || base.startsWith(`${sprintId}-`);
  });
  const archived = [];

  for (const fileName of matches) {
    const sourcePath = path.join(promptDir, fileName);
    const destinationPath = path.join(archiveDir, fileName);
    moveFileOverwrite(sourcePath, destinationPath);
    archived.push(destinationPath.replace(/\\/g, '/'));
  }

  if (archived.length > 0) {
    process.stdout.write(`archived: ${archived.join(', ')}\n`);
  }

  return archived;
}

function updateRoadmapPointer(sprintId, sessionLogPath) {
  const roadmapPath = resolve('docs/plans/sprint-roadmap.md');
  if (!existsSync(roadmapPath)) {
    process.stderr.write(`[vibe-sprint-complete] info=roadmap-missing path=${roadmapPath}\n`);
    return false;
  }

  const roadmapContent = readFileSync(roadmapPath, 'utf8');
  const sessionLogContent = readFileSync(sessionLogPath, 'utf8');
  const nextBlock = computeCurrentPointerBlock(roadmapContent, sessionLogContent, sprintId);
  const updatedRoadmap = replaceCurrentPointerBlock(roadmapContent, nextBlock);

  if (updatedRoadmap === null) {
    process.stderr.write('[vibe-sprint-complete] info=current-pointer-marker-missing\n');
    return false;
  }

  if (updatedRoadmap === roadmapContent) {
    return false;
  }

  writeFileSync(roadmapPath, `${updatedRoadmap}\n`, 'utf8');
  return true;
}

function syncSessionLog(scriptDir) {
  const syncScriptPath = path.join(scriptDir, 'vibe-session-log-sync.mjs');
  const result = spawnSync(process.execPath, [syncScriptPath], {
    stdio: 'inherit',
  });

  if (result.status === 0 || result.status === 2) {
    return result.status ?? 0;
  }

  if (result.error) {
    throw result.error;
  }

  throw new Error(`session-log-sync exited ${result.status ?? 1}`);
}

function runCli() {
  const [, , sprintId, status, ...rest] = process.argv;
  if (!sprintId || !status || !['passed', 'failed'].includes(status)) {
    fail(
      'Usage: node scripts/vibe-sprint-complete.mjs <sprintId> <passed|failed> [--summary "summary text"] [--scope <path1,path2,...>] [--no-auto-report]',
    );
  }

  let summary = '';
  let scope = null;
  let noAutoReport = false;
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] === '--summary') {
      summary = rest[i + 1] ?? '';
      i += 1;
    } else if (rest[i] === '--scope') {
      scope = parseScopeValue(rest[i + 1] ?? '');
      i += 1;
    } else if (rest[i] === '--no-auto-report') {
      noAutoReport = true;
    }
  }

  const nowIso = new Date().toISOString();
  const finalSummary = summary || `Sprint ${sprintId} completed with ${status}`;
  const actualLoc = getActualLoc();

  const statusPath = resolve('.vibe/agent/sprint-status.json');
  const handoffPath = resolve('.vibe/agent/handoff.md');
  const sessionLogPath = resolve('.vibe/agent/session-log.md');
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));

  if (!existsSync(statusPath)) {
    fail(`Missing required file: ${statusPath}`);
  }

  let sprintStatus;
  try {
    sprintStatus = JSON.parse(readFileSync(statusPath, 'utf8'));
  } catch (error) {
    fail(`Failed to parse ${statusPath}: ${error.message}`);
  }

  if (!Array.isArray(sprintStatus.sprints)) {
    sprintStatus.sprints = [];
  }
  if (!Array.isArray(sprintStatus.pendingRisks)) {
    sprintStatus.pendingRisks = [];
  }
  if (!Array.isArray(sprintStatus.lastSprintScope)) {
    sprintStatus.lastSprintScope = [];
  }
  if (!Array.isArray(sprintStatus.lastSprintScopeGlob)) {
    sprintStatus.lastSprintScopeGlob = [];
  }
  if (!Number.isInteger(sprintStatus.sprintsSinceLastAudit)) {
    sprintStatus.sprintsSinceLastAudit = 0;
  }

  const existingSprint = sprintStatus.sprints.find((entry) => entry?.id === sprintId);
  const alreadyClosed = existingSprint?.status === status;
  if (existingSprint) {
    warn(`sprint "${sprintId}" already exists in sprints[] - updating existing entry`);
    existingSprint.name = sprintId;
    if (!alreadyClosed) {
      existingSprint.status = status;
      existingSprint.completedAt = nowIso;
      if (actualLoc) {
        existingSprint.actualLoc = actualLoc;
      } else {
        delete existingSprint.actualLoc;
      }
    }
  } else {
    const nextSprint = {
      id: sprintId,
      name: sprintId,
      status,
      completedAt: nowIso,
    };
    if (actualLoc) {
      nextSprint.actualLoc = actualLoc;
    }
    sprintStatus.sprints.push(nextSprint);
  }

  if (scope !== null) {
    sprintStatus.lastSprintScope = normalizeScopeEntries([
      ...sprintStatus.lastSprintScope,
      ...scope,
    ]);
    sprintStatus.lastSprintScopeGlob = normalizeScopeEntries([
      ...sprintStatus.lastSprintScopeGlob,
      ...scope,
    ]);
  }

  if (status === 'passed' && !alreadyClosed) {
    sprintStatus.sprintsSinceLastAudit += 1;
    const everyN = readAuditEveryN();
    const auditRiskId = `audit-after-${sprintId}`;
    if (
      sprintStatus.sprintsSinceLastAudit >= everyN &&
      !sprintStatus.pendingRisks.some((entry) => entry?.id === auditRiskId)
    ) {
      sprintStatus.pendingRisks.push({
        id: auditRiskId,
        raisedBy: 'vibe-sprint-complete',
        targetSprint: '*',
        text: `Evaluator audit due (sprintsSinceLastAudit=${sprintStatus.sprintsSinceLastAudit}, everyN=${everyN}).`,
        status: 'open',
        createdAt: nowIso,
      });
    }
  }

  if (!alreadyClosed) {
    if (!Array.isArray(sprintStatus.verificationCommands)) {
      sprintStatus.verificationCommands = Array.isArray(sprintStatus.policies?.verificationCommands)
        ? sprintStatus.policies.verificationCommands
        : [];
    }
    sprintStatus.handoff = {
      ...(sprintStatus.handoff ?? {}),
      currentSprintId: 'idle',
      lastActionSummary: finalSummary,
      orchestratorContextBudget:
        sprintStatus.handoff?.orchestratorContextBudget === 'low' ||
        sprintStatus.handoff?.orchestratorContextBudget === 'medium' ||
        sprintStatus.handoff?.orchestratorContextBudget === 'high'
          ? sprintStatus.handoff.orchestratorContextBudget
          : 'medium',
      preferencesActive: Array.isArray(sprintStatus.handoff?.preferencesActive)
        ? sprintStatus.handoff.preferencesActive
        : [],
      updatedAt: nowIso,
    };
    sprintStatus.stateUpdatedAt = nowIso;
    validateStateOrFail(scriptDir);
    writeFileSync(statusPath, `${JSON.stringify(sprintStatus, null, 2)}\n`, 'utf8');
  }

  if (alreadyClosed) {
    logStep('daily-log', 'skip', 'detail=already-closed');
  } else {
    const result = emitSprintCompletedDailyEvent(
      sprintId,
      status,
      finalSummary,
      actualLoc,
      scriptDir,
    );
    logStep('daily-log', result.stepStatus, result.detail);
  }

  if (!existsSync(handoffPath)) {
    warn(`missing ${handoffPath} - skipping handoff update`);
  } else {
    const handoffContent = readFileSync(handoffPath, 'utf8');
    const nextStatusLine = `## 2. Status: IDLE - Sprint ${sprintId} ${status}`;
    let updatedHandoff = handoffContent.replace(/^## 2\. Status:.*$/m, nextStatusLine);

    if (updatedHandoff === handoffContent) {
      warn(`could not find "## 2. Status:" section in ${handoffPath}`);
    }

    const historyRow = `| \`${sprintId}\` | ${sprintId} | ${status} |`;
    const historyPattern = /(^## 3\.[^\n]*\n\n\|.*\n\|[-| ]+\n)((?:\|.*\n)*)/m;
    if (historyPattern.test(updatedHandoff)) {
      updatedHandoff = updatedHandoff.replace(historyPattern, (_, header, rows) => {
        const duplicatePattern = new RegExp(
          `^\\|\\s*\\\`${escapeRegExp(sprintId)}\\\`\\s*\\|.*$`,
          'm',
        );
        const filteredRows = rows
          .split('\n')
          .filter((line) => line && !duplicatePattern.test(line));
        return `${header}${[...filteredRows, historyRow].join('\n')}\n`;
      });
    } else {
      warn(`could not find sprint history table in ${handoffPath}`);
    }

    if (!alreadyClosed && updatedHandoff !== handoffContent) {
      writeFileSync(handoffPath, updatedHandoff, 'utf8');
    }
  }

  if (!existsSync(sessionLogPath)) {
    warn(`missing ${sessionLogPath} - skipping session log update`);
  } else {
    const sessionLogContent = readFileSync(sessionLogPath, 'utf8');
    const locSuffix = actualLoc
      ? ` LOC +${actualLoc.added}/-${actualLoc.deleted} (net ${formatNet(actualLoc.net)})`
      : '';
    const entry = `- ${nowIso} [sprint-complete] ${sprintId} -> ${status}. ${finalSummary}${locSuffix}`;
    const entriesPattern = /(^## Entries\s*$\n?)/m;

    if (!entriesPattern.test(sessionLogContent)) {
      warn(`could not find "## Entries" section in ${sessionLogPath} - skipping append`);
    } else {
      const existingEntryPattern = new RegExp(
        `^\\-\\s+\\S+\\s+\\[sprint-complete\\]\\s+${escapeRegExp(sprintId)}\\s+\\->\\s+${escapeRegExp(status)}\\b`,
        'm',
      );
      if (!alreadyClosed && !existingEntryPattern.test(sessionLogContent)) {
        const updatedSessionLog = sessionLogContent.replace(entriesPattern, `$1\n${entry}\n`);
        writeFileSync(sessionLogPath, updatedSessionLog, 'utf8');
      }
    }
  }

  try {
    if (status === 'passed') {
      archiveSprintPrompts(sprintId);
    }
    logStep('archive-prompts', 'ok');
  } catch (error) {
    logStep('archive-prompts', 'fail', `detail=${error.message}`);
  }

  try {
    updateRoadmapPointer(sprintId, sessionLogPath);
    logStep('current-pointer', 'ok');
  } catch (error) {
    logStep('current-pointer', 'fail', `detail=${error.message}`);
  }

  try {
    if (scope !== null) {
      const reloaded = JSON.parse(readFileSync(statusPath, 'utf8'));
      reloaded.lastSprintScope = normalizeScopeEntries([
        ...(Array.isArray(reloaded.lastSprintScope) ? reloaded.lastSprintScope : []),
        ...scope,
      ]);
      reloaded.lastSprintScopeGlob = normalizeScopeEntries([
        ...(Array.isArray(reloaded.lastSprintScopeGlob) ? reloaded.lastSprintScopeGlob : []),
        ...scope,
      ]);
      writeFileSync(statusPath, `${JSON.stringify(reloaded, null, 2)}\n`, 'utf8');
    }
    logStep('extend-scope', 'ok');
  } catch (error) {
    logStep('extend-scope', 'fail', `detail=${error.message}`);
  }

  try {
    const changed = recordIterationSprintCompletion(sprintId, status);
    logStep('iteration-history', changed ? 'ok' : 'skip');
  } catch (error) {
    logStep('iteration-history', 'warn', `detail=${error.message}`);
  }

  try {
    const syncStatus = syncSessionLog(scriptDir);
    if (syncStatus === 2) {
      logStep('session-log-sync', 'warn', 'detail=lock-held');
    } else {
      logStep('session-log-sync', 'ok');
    }
  } catch (error) {
    logStep('session-log-sync', 'warn', `detail=${error.message}`);
  }

  if (shouldAutoProjectReport(sprintId, status, noAutoReport)) {
    runProjectReport();
  }

  if (!alreadyClosed) {
    runLightweightAudit(scriptDir, sprintId);
  }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  runCli();
}
