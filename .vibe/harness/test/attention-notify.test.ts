import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

async function tempRoot(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), 'vibe-attention-'));
}

function runNotify(rootDir: string, input: string): Promise<{ exit: number; stderr: string }> {
  const child = spawn(process.execPath, ['.vibe/harness/scripts/vibe-attention-notify.mjs'], {
    cwd: process.cwd(),
    env: { ...process.env, VIBE_ROOT: rootDir },
    stdio: ['pipe', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += String(chunk);
  });
  child.stdin.end(input);
  return new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', (code) => resolve({ exit: code ?? 1, stderr }));
  });
}

async function readFirstAttention(rootDir: string): Promise<Record<string, unknown>> {
  const raw = await readFile(path.join(rootDir, '.vibe', 'agent', 'attention.jsonl'), 'utf8');
  return JSON.parse(raw.trim().split(/\r?\n/)[0] ?? '{}') as Record<string, unknown>;
}

test('stdin payload is parsed into an urgent attention event', async () => {
  const rootDir = await tempRoot();
  const result = await runNotify(rootDir, JSON.stringify({ session_id: 's1', message: 'Allow tool?' }));
  assert.equal(result.exit, 0);

  const event = await readFirstAttention(rootDir);
  assert.equal(typeof event.id, 'string');
  assert.equal(typeof event.ts, 'string');
  assert.equal(event.severity, 'urgent');
  assert.equal(event.source, 'claude-code-notification');
  assert.equal(event.detail, 'Allow tool?');
});

test('empty stdin still produces a minimal event', async () => {
  const rootDir = await tempRoot();
  const result = await runNotify(rootDir, '');
  assert.equal(result.exit, 0);

  const event = await readFirstAttention(rootDir);
  assert.equal(event.detail, 'Permission prompt');
});

test('idle notification is recorded as a non-urgent Claude attention event', async () => {
  const rootDir = await tempRoot();
  const result = await runNotify(
    rootDir,
    JSON.stringify({
      notification_type: 'idle_prompt',
      title: 'Claude is ready',
      message: 'Claude is waiting for your next prompt',
    }),
  );
  assert.equal(result.exit, 0);

  const event = await readFirstAttention(rootDir);
  assert.equal(event.severity, 'info');
  assert.equal(event.source, 'claude-code-notification');
  assert.equal(event.provider, 'claude');
  assert.equal(event.title, 'Claude is ready');
  assert.equal(event.detail, 'Claude is waiting for your next prompt');
  assert.equal((event.payload as Record<string, unknown>).notificationType, 'idle_prompt');
});

test('write failure exits 0', async () => {
  const rootFile = path.join(await tempRoot(), 'not-a-dir');
  await writeFile(rootFile, 'file', 'utf8');

  const result = await runNotify(rootFile, '');
  assert.equal(result.exit, 0);
  assert.match(result.stderr, /ENOTDIR|not a directory|no such file/i);
});
