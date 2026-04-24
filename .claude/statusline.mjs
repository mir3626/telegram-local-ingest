#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

const emojiTarget = '\u{1F3AF}';
const emojiThought = '\u{1F4AD}';
const emojiWrench = '\u{1F527}';
const emojiStopwatch = '\u23F1\uFE0F';
const emojiWarning = '\u26A0\uFE0F';
const emojiLabel = '\u{1F3F7}\uFE0F';

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
}

function readJsonOptional(filePath) {
  try {
    return readJson(filePath);
  } catch {
    return undefined;
  }
}

function getString(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function isTemplateProjectStatus(root, status) {
  const projectName = getString(status?.project?.name);
  if (projectName !== 'vibe-doctor') {
    return false;
  }

  return path.basename(root).toLowerCase() !== 'vibe-doctor';
}

function normalizeStatusForDisplay(root, status) {
  if (!isTemplateProjectStatus(root, status)) {
    return status;
  }

  return {
    ...status,
    handoff: {
      ...(status && typeof status === 'object' && !Array.isArray(status) ? status.handoff : undefined),
      currentSprintId: 'idle',
    },
    sprints: [],
    pendingRisks: [],
  };
}

function parseStatuslineInput(raw) {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  const parsed = JSON.parse(trimmed);
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : undefined;
}

async function readStatuslineInput() {
  try {
    const stat = fs.fstatSync(0);
    if (stat.isCharacterDevice()) {
      return undefined;
    }

    const raw = await new Promise((resolve) => {
      let settled = false;
      let value = '';
      const finish = () => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        process.stdin.off('data', onData);
        process.stdin.off('end', finish);
        process.stdin.off('error', finish);
        process.stdin.pause();
        resolve(value);
      };
      const onData = (chunk) => {
        value += chunk;
      };
      const timer = setTimeout(finish, 25);
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', onData);
      process.stdin.on('end', finish);
      process.stdin.on('error', finish);
      process.stdin.resume();
    });

    return parseStatuslineInput(raw);
  } catch {
    return undefined;
  }
}

function getFiniteNumber(value) {
  return Number.isFinite(value) ? value : 0;
}

function getUsageTotal(usage) {
  return usage && typeof usage === 'object' && !Array.isArray(usage)
    ? getFiniteNumber(usage.input_tokens) + getFiniteNumber(usage.output_tokens)
    : 0;
}

function getClaudeTokens(input) {
  const transcriptPath = getString(input?.transcript_path);
  if (!transcriptPath) {
    return undefined;
  }

  try {
    if (!fs.statSync(transcriptPath).isFile()) {
      return undefined;
    }

    let total = 0;
    for (const line of fs.readFileSync(transcriptPath, 'utf8').split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed.length === 0) {
        continue;
      }
      try {
        const entry = JSON.parse(trimmed);
        total += getUsageTotal(entry?.message?.usage ?? entry?.usage);
      } catch {
        // Ignore malformed transcript records; statusline must never block the UI.
      }
    }
    return total;
  } catch {
    return undefined;
  }
}

function normalizeVersion(version) {
  return version.trim().replace(/^v/i, '');
}

function toVersionParts(version) {
  const normalized = normalizeVersion(version);
  if (!/^\d+(?:\.\d+)*$/.test(normalized)) {
    return undefined;
  }

  return normalized.split('.').map((part) => Number.parseInt(part, 10));
}

function compareVersions(left, right) {
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = left[index] ?? 0;
    const rightPart = right[index] ?? 0;
    if (leftPart !== rightPart) {
      return leftPart > rightPart ? 1 : -1;
    }
  }

  return 0;
}

function isExactVersionRef(value) {
  return typeof value === 'string' && /^v?\d+\.\d+\.\d+$/.test(value.trim());
}

function getVersionSuffix(root) {
  const config = readJsonOptional(path.join(root, '.vibe', 'config.json'));
  const installedRaw = getString(config?.harnessVersionInstalled) ?? getString(config?.harnessVersion);
  const installedParts = installedRaw ? toVersionParts(installedRaw) : undefined;
  if (!installedRaw || !installedParts) {
    return undefined;
  }

  const installedVersion = normalizeVersion(installedRaw);
  const syncCache = readJsonOptional(path.join(root, '.vibe', 'sync-cache.json'));
  const latestRaw = getString(syncCache?.latestVersion);
  const latestParts = latestRaw ? toVersionParts(latestRaw) : undefined;
  if (latestRaw && latestParts && compareVersions(installedParts, latestParts) < 0) {
    if (isExactVersionRef(config?.upstream?.ref)) {
      return `v${installedVersion} pinned`;
    }
    return `v${installedVersion} \u26A0 v${normalizeVersion(latestRaw)} (/vibe-sync)`;
  }

  return `v${installedVersion}`;
}

async function main() {
  const root = process.cwd();
  const statusPath = path.join(root, '.vibe', 'agent', 'sprint-status.json');
  if (!fs.existsSync(statusPath)) {
    process.exit(0);
  }

  const status = normalizeStatusForDisplay(root, readJson(statusPath));
  const statuslineInput = await readStatuslineInput();
  const claudeTokens = getClaudeTokens(statuslineInput);
  const sprints = Array.isArray(status.sprints) ? status.sprints : [];
  const pendingRisks = Array.isArray(status.pendingRisks) ? status.pendingRisks : [];
  const currentSprintId =
    typeof status.handoff?.currentSprintId === 'string' && status.handoff.currentSprintId.length > 0
      ? status.handoff.currentSprintId
      : 'idle';
  const passedCount = sprints.filter((entry) => entry?.status === 'passed').length;
  const totalCount = sprints.length;
  const openRisks = pendingRisks.filter((entry) => entry?.status === 'open').length;
  const parts = [`${emojiTarget} ${currentSprintId} (${passedCount}/${totalCount})`];

  const tokensPath = path.join(root, '.vibe', 'agent', 'tokens.json');
  if (fs.existsSync(tokensPath)) {
    const tokens = readJson(tokensPath);
    const elapsedSeconds = Number.isFinite(tokens.elapsedSeconds) ? tokens.elapsedSeconds : 0;
    const cumulativeTokens = Number.isFinite(tokens.cumulativeTokens) ? tokens.cumulativeTokens : 0;
    parts.push(`${emojiStopwatch} ${Math.round(elapsedSeconds / 60)}m`);
    if (typeof claudeTokens === 'number') {
      parts.push(`${emojiThought} Claude ${Math.floor(claudeTokens / 1000)}K`);
    }
    parts.push(`${emojiWrench} Codex ${Math.floor(cumulativeTokens / 1000)}K`);
  } else if (typeof claudeTokens === 'number') {
    parts.push(`${emojiThought} Claude ${Math.floor(claudeTokens / 1000)}K`);
  }

  parts.push(`${emojiWarning} ${openRisks}`);
  const versionSuffix = getVersionSuffix(root);
  if (versionSuffix) {
    parts.push(`${emojiLabel} ${versionSuffix}`);
  }
  process.stdout.write(parts.join(' | '));
}

try {
  await main();
} catch {
  process.exit(0);
}
