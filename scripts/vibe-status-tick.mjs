#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const USAGE =
  'Usage: node scripts/vibe-status-tick.mjs --add-tokens <N> --sprint <id> [--elapsed-start <ISO>] | --elapsed-start <ISO>';

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const parsed = {
    addTokens: null,
    elapsedStart: null,
    sprintId: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--add-tokens') {
      parsed.addTokens = argv[index + 1] ?? null;
      index += 1;
      continue;
    }

    if (arg === '--sprint') {
      parsed.sprintId = argv[index + 1] ?? null;
      index += 1;
      continue;
    }

    if (arg === '--elapsed-start') {
      parsed.elapsedStart = argv[index + 1] ?? null;
      index += 1;
      continue;
    }

    fail(USAGE);
  }

  const wantsTokenUpdate = parsed.addTokens !== null || parsed.sprintId !== null;
  if (!wantsTokenUpdate && parsed.elapsedStart === null) {
    fail(USAGE);
  }

  if ((parsed.addTokens === null) !== (parsed.sprintId === null)) {
    fail('--add-tokens and --sprint must be provided together');
  }

  let addTokens = null;
  if (parsed.addTokens !== null) {
    const numeric = Number(parsed.addTokens);
    if (!Number.isInteger(numeric) || numeric < 0) {
      fail('--add-tokens must be a non-negative integer');
    }
    addTokens = numeric;
  }

  if (parsed.sprintId !== null && parsed.sprintId.length === 0) {
    fail('--sprint must not be empty');
  }

  if (parsed.elapsedStart !== null && Number.isNaN(Date.parse(parsed.elapsedStart))) {
    fail('--elapsed-start must be a valid ISO-8601 timestamp');
  }

  return {
    addTokens,
    elapsedStart: parsed.elapsedStart,
    sprintId: parsed.sprintId,
  };
}

function loadTokens(filePath) {
  if (!existsSync(filePath)) {
    return {
      updatedAt: '',
      cumulativeTokens: 0,
      elapsedSeconds: 0,
      sprintTokens: {},
    };
  }

  const parsed = JSON.parse(readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
  return {
    updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : '',
    cumulativeTokens: Number.isInteger(parsed.cumulativeTokens) ? parsed.cumulativeTokens : 0,
    elapsedSeconds: Number.isInteger(parsed.elapsedSeconds) ? parsed.elapsedSeconds : 0,
    sprintTokens:
      parsed.sprintTokens && typeof parsed.sprintTokens === 'object' && !Array.isArray(parsed.sprintTokens)
        ? Object.fromEntries(
            Object.entries(parsed.sprintTokens).filter(
              ([key, value]) => key.length > 0 && Number.isInteger(value),
            ),
          )
        : {},
  };
}

function main() {
  const { addTokens, elapsedStart, sprintId } = parseArgs(process.argv.slice(2));
  const filePath = path.resolve(process.cwd(), '.vibe', 'agent', 'tokens.json');
  mkdirSync(path.dirname(filePath), { recursive: true });

  const tokens = loadTokens(filePath);
  if (addTokens !== null && sprintId !== null) {
    tokens.cumulativeTokens += addTokens;
    tokens.sprintTokens[sprintId] = (tokens.sprintTokens[sprintId] ?? 0) + addTokens;
  }

  if (elapsedStart !== null) {
    tokens.elapsedSeconds = Math.round((Date.now() - Date.parse(elapsedStart)) / 1000);
  }

  tokens.updatedAt = new Date().toISOString();
  writeFileSync(filePath, `${JSON.stringify(tokens, null, 2)}\n`, 'utf8');
}

try {
  main();
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
