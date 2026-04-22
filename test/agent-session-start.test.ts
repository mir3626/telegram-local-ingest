import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

const tempDirs: string[] = [];
const scriptPath = path.resolve('scripts', 'vibe-agent-session-start.mjs');

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

describe('vibe-agent-session-start', () => {
  it('records a session-started daily event without provider-specific hooks', async () => {
    const root = await makeTempDir('agent-session-start-');
    await mkdir(path.join(root, '.vibe'), { recursive: true });
    await writeFile(path.join(root, '.vibe', 'config.json'), '{}\n', 'utf8');

    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: root,
      env: { ...process.env, VIBE_ROOT: root },
      encoding: 'utf8',
    });

    assert.equal(result.status, 0, result.stderr);

    const dailyDir = path.join(root, '.vibe', 'agent', 'daily');
    const [dailyFile] = await readdir(dailyDir);
    assert.match(dailyFile ?? '', /^\d{4}-\d{2}-\d{2}\.jsonl$/);

    const raw = await readFile(path.join(dailyDir, dailyFile ?? ''), 'utf8');
    const event = JSON.parse(raw.trim()) as { type?: string; payload?: { cwd?: string } };
    assert.equal(event.type, 'session-started');
    assert.equal(event.payload?.cwd, root);
  });

  it('can be skipped by env flag for nested provider invocations', async () => {
    const root = await makeTempDir('agent-session-start-skip-');
    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: root,
      env: { ...process.env, VIBE_ROOT: root, VIBE_SKIP_AGENT_SESSION_START: '1' },
      encoding: 'utf8',
    });

    assert.equal(result.status, 0, result.stderr);

    await assert.rejects(readdir(path.join(root, '.vibe', 'agent', 'daily')), {
      code: 'ENOENT',
    });
  });
});
