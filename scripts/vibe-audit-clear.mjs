#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function usage() {
  fail(
    'Usage: node scripts/vibe-audit-clear.mjs [--resolve-risks] [--note "<text>"]',
  );
}

function sessionLogPath(root) {
  return path.join(root, '.vibe', 'agent', 'session-log.md');
}

function sprintStatusPath(root) {
  return path.join(root, '.vibe', 'agent', 'sprint-status.json');
}

function sanitizeNote(note) {
  return note.trim().replace(/\s+/g, ' ');
}

function loadSprintStatus(root) {
  const statusPath = sprintStatusPath(root);
  if (!existsSync(statusPath)) {
    fail(`Missing required file: ${statusPath}`);
  }

  try {
    return JSON.parse(readFileSync(statusPath, 'utf8'));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    fail(`Failed to parse ${statusPath}: ${reason}`);
  }
}

function saveSprintStatus(root, status) {
  writeFileSync(sprintStatusPath(root), `${JSON.stringify(status, null, 2)}\n`, 'utf8');
}

function resolvePendingRisksByPrefix(status, prefix) {
  let resolvedCount = 0;

  if (!Array.isArray(status.pendingRisks)) {
    status.pendingRisks = [];
    return resolvedCount;
  }

  for (const risk of status.pendingRisks) {
    if (!risk?.id?.startsWith(prefix) || risk.status !== 'open') {
      continue;
    }

    risk.status = 'resolved';
    risk.resolvedAt = new Date().toISOString();
    resolvedCount += 1;
  }

  return resolvedCount;
}

function appendAuditClearEntry(root, resolvedCount, note) {
  const logPath = sessionLogPath(root);
  if (!existsSync(logPath)) {
    fail(`Missing required file: ${logPath}`);
  }

  const current = readFileSync(logPath, 'utf8');
  const marker = /^## Entries\s*$/m;
  if (!marker.test(current)) {
    fail(`Could not find "## Entries" section in ${logPath}`);
  }

  const nowIso = new Date().toISOString();
  const entry = `- ${nowIso} [audit-clear] resolved=${resolvedCount} note=${note}`;
  const updated = current.replace(marker, (matched) => `${matched}\n\n${entry}`);
  writeFileSync(logPath, updated, 'utf8');
}

function main() {
  const args = process.argv.slice(2);
  let resolveRisks = false;
  let note = '';

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--resolve-risks') {
      resolveRisks = true;
      continue;
    }

    if (arg === '--note') {
      if (args[index + 1] === undefined) {
        usage();
      }
      note = sanitizeNote(args[index + 1]);
      index += 1;
      continue;
    }

    usage();
  }

  const root = process.cwd();
  const logNote = note.length > 0 ? note : '-';
  const status = loadSprintStatus(root);
  status.sprintsSinceLastAudit = 0;
  status.stateUpdatedAt = new Date().toISOString();
  const resolvedCount = resolveRisks ? resolvePendingRisksByPrefix(status, 'audit-after-') : 0;
  saveSprintStatus(root, status);
  appendAuditClearEntry(root, resolvedCount, logNote);
  process.stdout.write(
    `[audit-clear] counter=0 resolved=${resolvedCount} note=${logNote}\n`,
  );
}

main();
