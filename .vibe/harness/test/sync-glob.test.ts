import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { expandHarnessGlob } from '../src/lib/sync.js';

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await import('node:fs/promises').then(({ rm }) => rm(dir, { recursive: true, force: true }));
    }
  }
});

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function writeFixture(root: string, relativePath: string): Promise<void> {
  const target = path.join(root, relativePath);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `${relativePath}\n`, 'utf8');
}

describe('expandHarnessGlob', () => {
  it('expands recursive directory globs with POSIX paths', async () => {
    const upstreamRoot = await makeTempDir('sync-glob-recursive-');
    await writeFixture(upstreamRoot, '.claude/skills/test-patterns/_index.md');
    await writeFixture(upstreamRoot, '.claude/skills/test-patterns/nested/example.md');

    const matches = await expandHarnessGlob(upstreamRoot, '.claude/skills/test-patterns/**');
    assert.deepEqual(matches, [
      '.claude/skills/test-patterns/_index.md',
      '.claude/skills/test-patterns/nested/example.md',
    ]);
  });

  it('matches only one segment for * patterns', async () => {
    const upstreamRoot = await makeTempDir('sync-glob-star-');
    await writeFixture(upstreamRoot, 'docs/reports/a.md');
    await writeFixture(upstreamRoot, 'docs/reports/nested/b.md');
    await writeFixture(upstreamRoot, 'docs/reports/c.txt');

    const matches = await expandHarnessGlob(upstreamRoot, 'docs/reports/*.md');
    assert.deepEqual(matches, ['docs/reports/a.md']);
  });

  it('supports mixed path patterns without crossing extra levels', async () => {
    const upstreamRoot = await makeTempDir('sync-glob-mixed-');
    await writeFixture(upstreamRoot, 'docs/plans/m6/summary.md');
    await writeFixture(upstreamRoot, 'docs/plans/m7/next.md');
    await writeFixture(upstreamRoot, 'docs/plans/archive/2026/old.md');

    const matches = await expandHarnessGlob(upstreamRoot, 'docs/plans/*/*.md');
    assert.deepEqual(matches, [
      'docs/plans/m6/summary.md',
      'docs/plans/m7/next.md',
    ]);
  });
});
