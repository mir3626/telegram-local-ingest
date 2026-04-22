#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

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

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function writeJson(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function patchSprintStatus(root) {
  const filePath = path.join(root, '.vibe', 'agent', 'sprint-status.json');
  if (!existsSync(filePath)) {
    return 'missing';
  }

  const status = JSON.parse(readFileSync(filePath, 'utf8'));
  let mutated = false;

  if (!Array.isArray(status.verificationCommands)) {
    status.verificationCommands = isRecord(status.policies) && Array.isArray(status.policies.verificationCommands)
      ? status.policies.verificationCommands
      : [];
    mutated = true;
  }

  if (status.verifiedAt === undefined || (status.verifiedAt !== null && typeof status.verifiedAt !== 'string')) {
    status.verifiedAt = null;
    mutated = true;
  }

  if (isRecord(status.handoff)) {
    if (typeof status.handoff.lastActionSummary !== 'string') {
      status.handoff.lastActionSummary =
        typeof status.handoff.nextAction === 'string' ? status.handoff.nextAction : '';
      mutated = true;
    }
    if (
      status.handoff.orchestratorContextBudget !== 'low' &&
      status.handoff.orchestratorContextBudget !== 'medium' &&
      status.handoff.orchestratorContextBudget !== 'high'
    ) {
      status.handoff.orchestratorContextBudget = 'medium';
      mutated = true;
    }
    if (!Array.isArray(status.handoff.preferencesActive)) {
      status.handoff.preferencesActive = [];
      mutated = true;
    }
    if (typeof status.handoff.updatedAt !== 'string' && typeof status.handoff.lastHandoffAt === 'string') {
      status.handoff.updatedAt = status.handoff.lastHandoffAt;
      mutated = true;
    }
  }

  if (!mutated) {
    return 'idempotent';
  }

  writeJson(filePath, status);
  return 'patched';
}

function updateConfig(root) {
  const filePath = path.join(root, '.vibe', 'config.json');
  if (!existsSync(filePath)) {
    return 'config-missing';
  }

  const config = JSON.parse(readFileSync(filePath, 'utf8'));
  if (compareVersions(config.harnessVersionInstalled, '1.4.0') >= 0) {
    return 'idempotent';
  }

  config.harnessVersionInstalled = '1.4.0';
  writeJson(filePath, config);
  return 'updated';
}

function migrateAgentFiles(root) {
  const oldPath = path.join(root, '.claude', 'agents', 'planner.md');
  const newPath = path.join(root, '.claude', 'agents', 'sprint-planner.md');

  if (!existsSync(oldPath)) {
    return 'idempotent';
  }

  if (existsSync(newPath)) {
    rmSync(oldPath);
    return 'removed-orphan';
  }

  process.stderr.write(
    `[migrate 1.4.0] warning: ${oldPath} exists but ${newPath} is missing; leaving old file in place\n`,
  );
  return 'skipped-missing-replacement';
}

function splitMarkdownRow(line) {
  const cells = [];
  let current = '';

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const previous = index > 0 ? line[index - 1] : '';
    if (char === '|' && previous !== '\\') {
      cells.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }

  cells.push(current.trim());
  return cells.filter((cell, index, array) => !(index === 0 && cell === '') && !(index === array.length - 1 && cell === ''));
}

function formatMarkdownRow(cells) {
  return `| ${cells.join(' | ')} |`;
}

function patchHarnessGaps(root) {
  const filePath = path.join(root, 'docs', 'context', 'harness-gaps.md');
  if (!existsSync(filePath)) {
    return 'missing';
  }

  const content = readFileSync(filePath, 'utf8');
  if (content.includes('| id | symptom | covered_by | status | script-gate | migration-deadline |')) {
    return 'idempotent';
  }

  if (!content.includes('| id | symptom | covered_by | status |')) {
    return 'skipped-parse-mismatch';
  }

  let parseMismatch = false;
  const lines = content.split(/\r?\n/).map((line) => {
    if (line === '| id | symptom | covered_by | status |') {
      return '| id | symptom | covered_by | status | script-gate | migration-deadline |';
    }
    if (line === '|---|---|---|---|') {
      return '|---|---|---|---|---|---|';
    }
    if (!/^\|\s*gap-[\w-]+\s*\|/.test(line)) {
      return line;
    }

    const cells = splitMarkdownRow(line);
    if (cells.length !== 4) {
      parseMismatch = true;
      return line;
    }

    const [id, symptom, currentCoveredBy, currentStatus] = cells;
    let coveredBy = currentCoveredBy;
    let status = currentStatus;
    let scriptGate = status === 'covered' ? 'covered' : 'pending';
    let deadline = '\u2014';

    if (id === 'gap-rule-only-in-md') {
      coveredBy = '`scripts/vibe-rule-audit.mjs` rule scanner (M-harness-gates)';
      status = 'covered';
      scriptGate = 'covered';
    }
    if (id === 'gap-release-tag-automation') {
      coveredBy = '`vibe-sprint-commit.mjs` harness-tag hook (M-harness-gates)';
      status = 'covered';
      scriptGate = 'covered';
    }
    if (id === 'gap-review-catch-wiring-drift') {
      status = 'open';
      scriptGate = 'pending';
      deadline = '+3 sprints';
    }

    return formatMarkdownRow([id, symptom, coveredBy, status, scriptGate, deadline]);
  });

  if (parseMismatch) {
    return 'skipped-parse-mismatch';
  }

  writeFileSync(filePath, lines.join('\n'), 'utf8');
  return 'patched';
}

function main() {
  const root = path.resolve(process.argv[2] ?? process.cwd());
  const actions = [
    `sprintStatus=${patchSprintStatus(root)}`,
    `config=${updateConfig(root)}`,
    `agentFiles=${migrateAgentFiles(root)}`,
    `harnessGaps=${patchHarnessGaps(root)}`,
  ];
  const idempotent = actions.every((entry) => entry.endsWith('=idempotent') || entry.endsWith('=missing'));
  process.stdout.write(`[migrate 1.4.0] ${actions.join(' ')}${idempotent ? ' idempotent' : ''}\n`);
}

try {
  main();
  process.exit(0);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
