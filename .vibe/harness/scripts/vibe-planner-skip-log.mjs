#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const usage = 'usage: node .vibe/harness/scripts/vibe-planner-skip-log.mjs <sprintId> <reason>';
const sprintIdPattern = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/i;

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

const args = process.argv.slice(2);
if (args.length !== 2) {
  fail(usage);
}

const [sprintId, rawReason] = args;
if (!sprintId || !sprintIdPattern.test(sprintId)) {
  fail('invalid sprintId: must be kebab-case (regex: /^[a-z0-9][a-z0-9-]*[a-z0-9]$/)');
}

if (rawReason.includes('\n') || rawReason.includes('\r')) {
  fail('reason must be single-line');
}

const reason = rawReason.trim();
if (reason.length === 0 || reason.length > 500) {
  fail('reason must be non-empty (1-500 chars)');
}

const sessionLogPath = resolve('.vibe/agent/session-log.md');
if (!existsSync(sessionLogPath)) {
  fail(`session-log.md not found at ${sessionLogPath}`);
}

const content = readFileSync(sessionLogPath, 'utf8');
const fingerprint = `[decision][planner-skip] sprint=${sprintId} reason=${reason}`;
if (content.includes(fingerprint)) {
  process.stdout.write('already recorded (idempotent)\n');
  process.exit(0);
}

const entriesPattern = /(^## Entries\s*$\n?)/m;
if (!entriesPattern.test(content)) {
  fail("session-log.md lacks '## Entries' heading");
}

const entry = `- ${new Date().toISOString()} ${fingerprint}`;
writeFileSync(sessionLogPath, content.replace(entriesPattern, `$1\n${entry}\n`), 'utf8');
process.stdout.write(`recorded planner-skip for ${sprintId}\n`);
