import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

const checkpointScriptPath = path.resolve('scripts', 'vibe-checkpoint.mjs');
const tempDirs: string[] = [];

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

describe('vibe-checkpoint', () => {
  it('uses provider-neutral checkpoint wording on failure', async () => {
    const root = await makeTempDir('checkpoint-missing-state-');

    const result = spawnSync(process.execPath, [checkpointScriptPath], {
      cwd: root,
      encoding: 'utf8',
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /Checkpoint blocked/);
    assert.doesNotMatch(result.stderr, /PreCompact blocked/);
  });
});
