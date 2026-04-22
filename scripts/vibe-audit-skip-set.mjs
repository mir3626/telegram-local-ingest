#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const configLocalPath = resolve('.vibe/config.local.json');
const sessionLogPath = resolve('.vibe/agent/session-log.md');
const msPerDay = 86_400_000;

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function readJson(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    fail(`failed to parse ${filePath}: ${reason}`);
  }
}

function readSessionLog() {
  if (!existsSync(sessionLogPath)) {
    fail(`session-log.md not found at ${sessionLogPath}`);
  }

  const content = readFileSync(sessionLogPath, 'utf8');
  if (!/(^## Entries\s*$\n?)/m.test(content)) {
    fail("session-log.md lacks '## Entries' heading");
  }
  return content;
}

function appendDecisionEntry(content, entry, fingerprint) {
  if (content.includes(fingerprint)) {
    return { content, appended: false };
  }

  const entriesPattern = /(^## Entries\s*$\n?)/m;
  return {
    content: content.replace(entriesPattern, `$1\n${entry}\n`),
    appended: true,
  };
}

function writeConfig(config) {
  writeFileSync(configLocalPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

function writeConfigSkeleton() {
  const schemaPath = resolve('.vibe/config.local.schema.json');
  const skeleton = existsSync(schemaPath)
    ? { $schema: './config.local.schema.json', userDirectives: {} }
    : { userDirectives: {} };

  writeConfig(skeleton);
  process.stdout.write('created .vibe/config.local.json with default skeleton\n');
  return skeleton;
}

function validateReason(rawReason) {
  if (rawReason.includes('\n') || rawReason.includes('\r')) {
    fail('reason must be single-line');
  }

  const reason = rawReason.trim();
  if (reason.length === 0 || reason.length > 500) {
    fail('reason must be non-empty (1-500 chars)');
  }

  return reason;
}

function validateDuration(rawDuration) {
  if (!/^\d+$/.test(rawDuration)) {
    fail('duration-days must be a positive integer (1-90)');
  }

  const durationDays = Number(rawDuration);
  if (!Number.isInteger(durationDays) || durationDays < 1 || durationDays > 90) {
    fail('duration-days must be a positive integer (1-90)');
  }

  return durationDays;
}

function loadConfigLocal() {
  if (!existsSync(configLocalPath)) {
    return writeConfigSkeleton();
  }

  const config = readJson(configLocalPath);
  if (typeof config !== 'object' || config === null || Array.isArray(config)) {
    fail('config.local.json must contain a JSON object');
  }
  return config;
}

function setAuditSkippedMode(reason, durationDays) {
  const config = loadConfigLocal();
  const sessionLog = readSessionLog();
  const fingerprint = `[decision][audit-skipped-mode] reason=${reason} `;
  const durationFingerprint = ` durationDays=${durationDays}`;
  if (sessionLog.includes(fingerprint) && sessionLog.includes(durationFingerprint)) {
    process.stdout.write('already recorded\n');
    return;
  }

  const recordedAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + durationDays * msPerDay).toISOString();
  const entry = `- ${recordedAt} [decision][audit-skipped-mode] reason=${reason} expiresAt=${expiresAt} durationDays=${durationDays}`;
  const updatedSessionLog = sessionLog.replace(/(^## Entries\s*$\n?)/m, `$1\n${entry}\n`);

  const userDirectives =
    typeof config.userDirectives === 'object' && config.userDirectives !== null && !Array.isArray(config.userDirectives)
      ? config.userDirectives
      : {};

  config.userDirectives = {
    ...userDirectives,
    auditSkippedMode: {
      ...(typeof userDirectives.auditSkippedMode === 'object' &&
      userDirectives.auditSkippedMode !== null &&
      !Array.isArray(userDirectives.auditSkippedMode)
        ? userDirectives.auditSkippedMode
        : {}),
      enabled: true,
      reason,
      expiresAt,
      recordedAt,
    },
  };

  writeConfig(config);
  writeFileSync(sessionLogPath, updatedSessionLog, 'utf8');
  process.stdout.write(`recorded audit-skipped-mode expiresAt=${expiresAt}\n`);
}

function clearAuditSkippedMode() {
  const config = loadConfigLocal();
  const sessionLog = readSessionLog();
  const userDirectives =
    typeof config.userDirectives === 'object' && config.userDirectives !== null && !Array.isArray(config.userDirectives)
      ? config.userDirectives
      : {};
  const existing =
    typeof userDirectives.auditSkippedMode === 'object' &&
    userDirectives.auditSkippedMode !== null &&
    !Array.isArray(userDirectives.auditSkippedMode)
      ? userDirectives.auditSkippedMode
      : {};

  config.userDirectives = {
    ...userDirectives,
    auditSkippedMode: {
      ...existing,
      enabled: false,
    },
  };

  const nowIso = new Date().toISOString();
  const fingerprint = '[decision][audit-skipped-mode-clear]';
  const entry = `- ${nowIso} ${fingerprint}`;
  const updatedSessionLog = appendDecisionEntry(sessionLog, entry, fingerprint);

  writeConfig(config);
  writeFileSync(sessionLogPath, updatedSessionLog.content, 'utf8');
  process.stdout.write(updatedSessionLog.appended ? 'cleared audit-skipped-mode\n' : 'already cleared\n');
}

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--clear') {
  clearAuditSkippedMode();
} else if (args.length === 2) {
  setAuditSkippedMode(validateReason(args[0]), validateDuration(args[1]));
} else {
  fail('usage: node scripts/vibe-audit-skip-set.mjs <reason> <duration-days>\n       node scripts/vibe-audit-skip-set.mjs --clear');
}
