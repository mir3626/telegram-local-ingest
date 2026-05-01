import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

const tempDirs: string[] = [];
const scriptPath = path.resolve('.vibe', 'harness', 'scripts', 'vibe-planner-skip-log.mjs');

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

async function writeSessionLog(root: string, content = '# Session Log\n\n## Entries\n'): Promise<void> {
  await mkdir(path.join(root, '.vibe', 'agent'), { recursive: true });
  await writeFile(path.join(root, '.vibe', 'agent', 'session-log.md'), content, 'utf8');
}

function runSkipLog(root: string, sprintId: string, reason: string) {
  return spawnSync(process.execPath, [scriptPath, sprintId, reason], {
    cwd: root,
    encoding: 'utf8',
  });
}

describe('vibe-planner-skip-log', () => {
  it('rejects invalid sprintId', async () => {
    const root = await makeTempDir('planner-skip-invalid-id-');
    await writeSessionLog(root);

    const result = runSkipLog(root, 'foo_bar', 'test reason');

    assert.equal(result.status, 1);
    assert.match(result.stderr, /kebab-case/);
  });

  it('rejects empty reason', async () => {
    const root = await makeTempDir('planner-skip-empty-reason-');
    await writeSessionLog(root);

    const result = runSkipLog(root, 'sprint-M1', '');

    assert.equal(result.status, 1);
    assert.match(result.stderr, /reason must be non-empty/);
  });

  it('rejects multi-line reason', async () => {
    const root = await makeTempDir('planner-skip-multiline-');
    await writeSessionLog(root);

    const result = runSkipLog(root, 'sprint-M1', 'first\nsecond');

    assert.equal(result.status, 1);
    assert.match(result.stderr, /single-line/);
  });

  it('rejects when session-log missing', async () => {
    const root = await makeTempDir('planner-skip-missing-log-');

    const result = runSkipLog(root, 'sprint-M1', 'test reason');

    assert.equal(result.status, 1);
    assert.match(result.stderr, /session-log\.md not found/);
  });

  it('appends well-formed entry to ## Entries', async () => {
    const root = await makeTempDir('planner-skip-append-');
    await writeSessionLog(root);

    const result = runSkipLog(root, 'sprint-M1', 'test reason');
    const sessionLog = await readFile(path.join(root, '.vibe', 'agent', 'session-log.md'), 'utf8');

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /recorded planner-skip for sprint-M1/);
    assert.match(
      sessionLog,
      /^- \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z \[decision\]\[planner-skip\] sprint=sprint-M1 reason=test reason$/m,
    );
    assert.match(sessionLog, /## Entries\n\n- /);
  });

  it('idempotent on duplicate call', async () => {
    const root = await makeTempDir('planner-skip-idempotent-');
    await writeSessionLog(root);

    const first = runSkipLog(root, 'sprint-M1', 'test reason');
    const afterFirst = await readFile(path.join(root, '.vibe', 'agent', 'session-log.md'), 'utf8');
    const second = runSkipLog(root, 'sprint-M1', 'test reason');
    const afterSecond = await readFile(path.join(root, '.vibe', 'agent', 'session-log.md'), 'utf8');

    assert.equal(first.status, 0, first.stderr);
    assert.equal(second.status, 0, second.stderr);
    assert.match(second.stdout, /already recorded \(idempotent\)/);
    assert.equal(afterSecond, afterFirst);
    assert.equal(afterSecond.match(/\[decision\]\[planner-skip\] sprint=sprint-M1 reason=test reason/g)?.length, 1);
  });
});
