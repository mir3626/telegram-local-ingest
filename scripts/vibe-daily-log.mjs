#!/usr/bin/env node

import { appendFile, mkdir, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const EVENT_TYPES = new Set([
  'session-started',
  'phase-started',
  'phase-completed',
  'sprint-started',
  'sprint-completed',
  'sprint-failed',
  'pending-risk-added',
  'pending-risk-resolved',
  'attention-needed',
  'test-failed',
  'iteration-started',
  'iteration-completed',
  'audit-cleared',
]);

function rootDir() {
  return process.env.VIBE_ROOT ? path.resolve(process.env.VIBE_ROOT) : process.cwd();
}

function dailyDir(root = rootDir()) {
  return path.join(root, '.vibe', 'agent', 'daily');
}

function utcDate() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'UTC',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function parseArgs(argv) {
  const type = argv[0] ?? '';
  const flags = { type, payload: {}, date: utcDate(), sessionId: undefined };

  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--payload') {
      flags.payload = JSON.parse(argv[index + 1] ?? '{}');
      index += 1;
      continue;
    }
    if (token === '--date') {
      flags.date = argv[index + 1] ?? flags.date;
      index += 1;
      continue;
    }
    if (token === '--session-id') {
      flags.sessionId = argv[index + 1];
      index += 1;
    }
  }

  return flags;
}

export async function appendDailyEventCli(input, root = rootDir()) {
  if (!EVENT_TYPES.has(input.type)) {
    throw new Error(`invalid daily event type: ${input.type}`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) {
    throw new Error(`invalid daily event date: ${input.date}`);
  }

  const event = {
    ts: new Date().toISOString(),
    type: input.type,
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    ...(input.payload && Object.keys(input.payload).length > 0 ? { payload: input.payload } : {}),
  };

  await mkdir(dailyDir(root), { recursive: true });
  await appendFile(path.join(dailyDir(root), `${input.date}.jsonl`), `${JSON.stringify(event)}\n`, {
    encoding: 'utf8',
    flag: 'a',
  });
}

export async function listDailyDatesCli(root = rootDir()) {
  try {
    return (await readdir(dailyDir(root)))
      .map((entry) => entry.match(/^(\d{4}-\d{2}-\d{2})\.jsonl$/)?.[1])
      .filter(Boolean)
      .sort((left, right) => right.localeCompare(left));
  } catch {
    return [];
  }
}

export async function readDailyEventsCli(date, root = rootDir(), limit = undefined) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`invalid daily event date: ${date}`);
  }
  try {
    const raw = await readFile(path.join(dailyDir(root), `${date}.jsonl`), 'utf8');
    const events = raw
      .split(/\r?\n/)
      .filter((line) => line.trim() !== '')
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          process.stderr.write(`Warning: malformed daily-log line skipped for ${date}\n`);
          return null;
        }
      })
      .filter(Boolean);
    return limit === undefined ? events : events.slice(-limit);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? '')).href) {
  appendDailyEventCli(parseArgs(process.argv.slice(2))).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
