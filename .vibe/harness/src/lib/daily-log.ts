import { appendFile, mkdir, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { paths } from './paths.js';

export interface DailyEvent {
  ts: string;
  type: DailyEventType;
  sessionId?: string;
  payload?: Record<string, unknown>;
}

export type DailyEventType =
  | 'session-started'
  | 'phase-started'
  | 'phase-completed'
  | 'sprint-started'
  | 'sprint-completed'
  | 'sprint-failed'
  | 'pending-risk-added'
  | 'pending-risk-resolved'
  | 'attention-needed'
  | 'test-failed'
  | 'iteration-started'
  | 'iteration-completed'
  | 'audit-cleared';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAILY_FILE_RE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;

function resolveRoot(rootDir?: string): string {
  return rootDir ?? paths.root;
}

function dailyDir(rootDir?: string): string {
  return path.join(resolveRoot(rootDir), '.vibe', 'agent', 'daily');
}

function dailyPath(date: string, rootDir?: string): string {
  if (!DATE_RE.test(date)) {
    throw new Error(`Invalid daily-log date: ${date}`);
  }
  return path.join(dailyDir(rootDir), `${date}.jsonl`);
}

function currentUtcDate(): string {
  // Dashboard history uses UTC day shards so every process agrees on the same boundary.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'UTC',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isDailyEventType(value: unknown): value is DailyEventType {
  return (
    value === 'session-started' ||
    value === 'phase-started' ||
    value === 'phase-completed' ||
    value === 'sprint-started' ||
    value === 'sprint-completed' ||
    value === 'sprint-failed' ||
    value === 'pending-risk-added' ||
    value === 'pending-risk-resolved' ||
    value === 'attention-needed' ||
    value === 'test-failed' ||
    value === 'iteration-started' ||
    value === 'iteration-completed' ||
    value === 'audit-cleared'
  );
}

function parseDailyEvent(line: string, filePath: string, lineNumber: number): DailyEvent | null {
  try {
    const parsed: unknown = JSON.parse(line);
    if (!isRecord(parsed) || typeof parsed.ts !== 'string' || !isDailyEventType(parsed.type)) {
      process.stderr.write(`Warning: skipping malformed daily-log line ${filePath}:${lineNumber}\n`);
      return null;
    }

    return {
      ts: parsed.ts,
      type: parsed.type,
      ...(typeof parsed.sessionId === 'string' ? { sessionId: parsed.sessionId } : {}),
      ...(isRecord(parsed.payload) ? { payload: parsed.payload } : {}),
    };
  } catch {
    process.stderr.write(`Warning: skipping malformed daily-log line ${filePath}:${lineNumber}\n`);
    return null;
  }
}

export async function appendDailyEvent(input: {
  type: DailyEventType;
  payload?: Record<string, unknown>;
  date?: string;
  sessionId?: string;
  rootDir?: string;
}): Promise<void> {
  const date = input.date ?? currentUtcDate();
  const event: DailyEvent = {
    ts: new Date().toISOString(),
    type: input.type,
    ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
    ...(input.payload === undefined ? {} : { payload: input.payload }),
  };

  await mkdir(dailyDir(input.rootDir), { recursive: true });
  await appendFile(dailyPath(date, input.rootDir), `${JSON.stringify(event)}\n`, {
    encoding: 'utf8',
    flag: 'a',
  });
}

export async function readDailyEvents(
  date: string,
  options: { rootDir?: string; limit?: number } = {},
): Promise<DailyEvent[]> {
  const filePath = dailyPath(date, options.rootDir);
  let raw = '';
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (error) {
    const code = isRecord(error) && typeof error.code === 'string' ? error.code : '';
    if (code === 'ENOENT') {
      return [];
    }
    throw error;
  }

  const events = raw
    .split(/\r?\n/)
    .map((line, index) => (line.trim() === '' ? null : parseDailyEvent(line, filePath, index + 1)))
    .filter((entry): entry is DailyEvent => entry !== null);

  return options.limit === undefined ? events : events.slice(-Math.max(0, options.limit));
}

export async function listAvailableDates(rootDir?: string): Promise<string[]> {
  let entries: string[] = [];
  try {
    entries = await readdir(dailyDir(rootDir));
  } catch (error) {
    const code = isRecord(error) && typeof error.code === 'string' ? error.code : '';
    if (code === 'ENOENT') {
      return [];
    }
    throw error;
  }

  return entries
    .map((entry) => entry.match(DAILY_FILE_RE)?.[1])
    .filter((date): date is string => date !== undefined)
    .sort((left, right) => right.localeCompare(left));
}
