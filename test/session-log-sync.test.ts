import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, it } from 'node:test';

const execFile = promisify(execFileCallback);
const tempDirs: string[] = [];
const sessionLogSyncPath = path.resolve('scripts', 'vibe-session-log-sync.mjs');

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

async function writeSessionLog(root: string, content: string): Promise<string> {
  const filePath = path.join(root, '.vibe', 'agent', 'session-log.md');
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, 'utf8');
  return filePath;
}

async function runSync(root: string, extraEnv: Record<string, string> = {}) {
  return execFile('node', [sessionLogSyncPath], {
    cwd: root,
    env: { ...process.env, ...extraEnv },
  });
}

describe('vibe-session-log-sync', () => {
  it('normalizes partial timestamps to UTC with seconds and milliseconds', async () => {
    const root = await makeTempDir('session-log-normalize-');
    const filePath = await writeSessionLog(
      root,
      '# Session Log\n\n## Entries\n- 2026-04-10T08:30 [decision] foo\n',
    );

    await runSync(root);
    const content = await readFile(filePath, 'utf8');

    assert.match(content, /\- 2026-04-10T08:30:00.000Z \[decision\] foo/);
  });

  it('sorts entries descending and preserves archived sections', async () => {
    const root = await makeTempDir('session-log-sort-');
    const filePath = await writeSessionLog(
      root,
      [
        '# Session Log',
        '',
        '## Entries',
        '- 2026-04-09 [decision] oldest',
        '- 2026-04-11T09:00:00Z [decision] newest',
        '- 2026-04-10T08:30 [decision] middle',
        '## Archived (old)',
        '- 2026-04-01T00:00:00.000Z [decision] archived',
        '',
      ].join('\n'),
    );

    await runSync(root);
    const content = await readFile(filePath, 'utf8');
    const newestIndex = content.indexOf('2026-04-11T09:00:00.000Z');
    const middleIndex = content.indexOf('2026-04-10T08:30:00.000Z');
    const oldestIndex = content.indexOf('2026-04-09T00:00:00.000Z');

    assert.equal(newestIndex < middleIndex && middleIndex < oldestIndex, true);
    assert.match(content, /## Archived \(old\)/);
    assert.match(content, /archived/);
  });

  it('deduplicates identical normalized entries', async () => {
    const root = await makeTempDir('session-log-dedup-');
    const filePath = await writeSessionLog(
      root,
      [
        '# Session Log',
        '',
        '## Entries',
        '- 2026-04-10T08:30 [decision] foo',
        '- 2026-04-10T08:30:00.000Z [decision] foo',
        '- 2026-04-10T08:30:00Z [decision] foo',
        '',
      ].join('\n'),
    );

    const { stdout } = await runSync(root);
    const content = await readFile(filePath, 'utf8');
    const occurrences = content.match(/2026-04-10T08:30:00.000Z \[decision\] foo/g) ?? [];

    assert.equal(occurrences.length, 1);
    assert.match(stdout, /deduped=2/);
  });

  it('returns exit 2 while lock file is held', async () => {
    const root = await makeTempDir('session-log-lock-');
    const filePath = await writeSessionLog(root, '# Session Log\n\n## Entries\n');
    await writeFile(`${filePath}.lock`, '', 'utf8');

    try {
      await runSync(root, { VIBE_LOCK_TIMEOUT_MS: '500' });
      assert.fail('expected lock contention failure');
    } catch (error) {
      const stderr =
        error instanceof Error && 'stderr' in error && typeof error.stderr === 'string'
          ? error.stderr
          : '';
      const code =
        error instanceof Error && 'code' in error && typeof error.code === 'number'
          ? error.code
          : null;

      assert.equal(code, 2);
      assert.match(stderr, /lock held by another process/);
    }
  });
});
