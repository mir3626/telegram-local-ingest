import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  appendDailyEvent,
  listAvailableDates,
  readDailyEvents,
} from '../src/lib/daily-log.js';

async function tempRoot(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), 'vibe-daily-log-'));
}

function runChildAppend(rootDir: string, date: string): Promise<void> {
  const code = [
    "import { appendDailyEvent } from './src/lib/daily-log.ts';",
    "await appendDailyEvent({ type: 'session-started', rootDir: process.env.ROOT, date: process.env.DATE, payload: { child: true } });",
  ].join('\n');
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], {
    cwd: process.cwd(),
    env: { ...process.env, ROOT: rootDir, DATE: date },
    stdio: 'ignore',
  });
  return new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`child exited ${code ?? 1}`));
    });
  });
}

test('appendDailyEvent creates daily directory when missing', async () => {
  const rootDir = await tempRoot();
  await appendDailyEvent({
    type: 'session-started',
    rootDir,
    date: '2026-04-16',
    payload: { cwd: rootDir },
  });

  const raw = await readFile(path.join(rootDir, '.vibe', 'agent', 'daily', '2026-04-16.jsonl'), 'utf8');
  assert.match(raw, /"type":"session-started"/);
});

test('concurrent appendDailyEvent calls produce parseable lines', async () => {
  const rootDir = await tempRoot();
  await Promise.all([
    runChildAppend(rootDir, '2026-04-16'),
    runChildAppend(rootDir, '2026-04-16'),
  ]);

  const events = await readDailyEvents('2026-04-16', { rootDir });
  assert.equal(events.length, 2);
  assert.ok(events.every((event) => event.type === 'session-started'));
});

test('readDailyEvents skips malformed lines and warns', async () => {
  const rootDir = await tempRoot();
  const dailyDir = path.join(rootDir, '.vibe', 'agent', 'daily');
  await mkdir(dailyDir, { recursive: true });
  await writeFile(
    path.join(dailyDir, '2026-04-16.jsonl'),
    [
      '{"ts":"2026-04-16T00:00:00.000Z","type":"session-started"}',
      'not json',
      '{"ts":"2026-04-16T00:00:01.000Z","type":"audit-cleared"}',
      '',
    ].join('\n'),
    'utf8',
  );

  const writes: string[] = [];
  const originalWrite = process.stderr.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    writes.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    const events = await readDailyEvents('2026-04-16', { rootDir });
    assert.deepEqual(events.map((event) => event.type), ['session-started', 'audit-cleared']);
  } finally {
    process.stderr.write = originalWrite;
  }
  assert.ok(writes.some((entry) => entry.includes('malformed daily-log line')));
});

test('listAvailableDates returns descending date shards', async () => {
  const rootDir = await tempRoot();
  const dailyDir = path.join(rootDir, '.vibe', 'agent', 'daily');
  await mkdir(dailyDir, { recursive: true });
  await writeFile(path.join(dailyDir, '2026-04-15.jsonl'), '', 'utf8');
  await writeFile(path.join(dailyDir, '2026-04-16.jsonl'), '', 'utf8');
  await writeFile(path.join(dailyDir, 'notes.txt'), '', 'utf8');

  assert.deepEqual(await listAvailableDates(rootDir), ['2026-04-16', '2026-04-15']);
});

test('date override is respected', async () => {
  const rootDir = await tempRoot();
  await appendDailyEvent({ type: 'audit-cleared', rootDir, date: '2026-01-02' });

  assert.equal((await readDailyEvents('2026-01-02', { rootDir }))[0]?.type, 'audit-cleared');
});
