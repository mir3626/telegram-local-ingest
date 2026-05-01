import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const tempDirs: string[] = [];
const statusTickPath = path.resolve('.vibe', 'harness', 'scripts', 'vibe-status-tick.mjs');

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

async function readTokens(root: string): Promise<{
  updatedAt: string;
  cumulativeTokens: number;
  elapsedSeconds: number;
  sprintTokens: Record<string, number>;
}> {
  return JSON.parse(
    await readFile(path.join(root, '.vibe', 'agent', 'tokens.json'), 'utf8'),
  ) as {
    updatedAt: string;
    cumulativeTokens: number;
    elapsedSeconds: number;
    sprintTokens: Record<string, number>;
  };
}

async function runStatusTick(root: string, args: string[]) {
  return execFile(process.execPath, [statusTickPath, ...args], {
    cwd: root,
    env: process.env,
  });
}

describe('vibe-status-tick', () => {
  it('creates tokens.json from scratch when adding tokens', async () => {
    const root = await makeTempDir('status-tick-create-');

    await runStatusTick(root, ['--add-tokens', '500', '--sprint', 'M9']);
    const tokens = await readTokens(root);

    assert.equal(tokens.cumulativeTokens, 500);
    assert.equal(tokens.sprintTokens.M9, 500);
    assert.equal(Number.isNaN(Date.parse(tokens.updatedAt)), false);
  });

  it('increments existing totals across repeated runs', async () => {
    const root = await makeTempDir('status-tick-increment-');

    await runStatusTick(root, ['--add-tokens', '500', '--sprint', 'M9']);
    await runStatusTick(root, ['--add-tokens', '500', '--sprint', 'M9']);
    const tokens = await readTokens(root);

    assert.equal(tokens.cumulativeTokens, 1_000);
    assert.equal(tokens.sprintTokens.M9, 1_000);
  });

  it('computes elapsed seconds from the supplied start time', async () => {
    const root = await makeTempDir('status-tick-elapsed-');
    const elapsedStart = new Date(Date.now() - 30_000).toISOString();

    await runStatusTick(root, ['--elapsed-start', elapsedStart]);
    const tokens = await readTokens(root);

    assert.equal(tokens.elapsedSeconds >= 25 && tokens.elapsedSeconds <= 35, true);
  });

  it('exits with code 1 on bad args', async () => {
    const root = await makeTempDir('status-tick-bad-args-');

    await assert.rejects(runStatusTick(root, []), (error: unknown) => {
      assert.equal(typeof error, 'object');
      assert.equal((error as { code?: number }).code, 1);
      assert.match((error as { stderr?: string }).stderr ?? '', /Usage:/);
      return true;
    });
  });
});
