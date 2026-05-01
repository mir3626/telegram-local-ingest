import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, it } from 'node:test';

const execFile = promisify(execFileCallback);
const tempDirs: string[] = [];
const preflightPath = path.resolve('.vibe', 'harness', 'scripts', 'vibe-preflight.mjs');

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

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function scaffoldRepo(root: string, stateUpdatedAt: string): Promise<void> {
  await mkdir(path.join(root, '.vibe', 'agent'), { recursive: true });
  await mkdir(path.join(root, 'docs', 'context'), { recursive: true });
  await writeJson(path.join(root, '.vibe', 'config.json'), {
    harnessVersion: '1.1.1',
    harnessVersionInstalled: '1.1.1',
    sprintRoles: {},
    providers: {},
  });
  await writeJson(path.join(root, '.vibe', 'agent', 'sprint-status.json'), {
    schemaVersion: '0.1',
    project: {
      name: 'test-project',
      createdAt: '2026-04-01T00:00:00.000Z',
    },
    sprints: [],
    verificationCommands: [],
    pendingRisks: [],
    lastSprintScope: [],
    lastSprintScopeGlob: [],
    sprintsSinceLastAudit: 0,
    stateUpdatedAt,
  });
  await writeFile(path.join(root, '.vibe', 'agent', 'handoff.md'), '# handoff\n', 'utf8');
  await writeFile(path.join(root, '.vibe', 'agent', 'session-log.md'), '## Entries\n', 'utf8');
  await writeFile(
    path.join(root, 'docs', 'context', 'product.md'),
    'This stub product document is intentionally long enough to satisfy the phase zero gate in tests.\n',
    'utf8',
  );

  await execFile('git', ['init'], { cwd: root });
  await execFile('git', ['config', 'user.name', 'Test User'], { cwd: root });
  await execFile('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
  await execFile('git', ['add', '.'], { cwd: root });
  await execFile('git', ['commit', '-m', 'init'], { cwd: root });
}

async function runPreflightJson(root: string): Promise<Array<{ id: string; detail: string; level: string; ok: boolean }>> {
  const { stdout } = await execFile('node', [preflightPath, '--json'], { cwd: root });
  return JSON.parse(stdout) as Array<{ id: string; detail: string; level: string; ok: boolean }>;
}

function handoffRecord(records: Array<{ id: string; detail: string; level: string; ok: boolean }>) {
  const record = records.find((entry) => entry.id === 'handoff.stale');
  assert.ok(record);
  return record;
}

describe('vibe-preflight handoff stale', () => {
  it('reports recent stateUpdatedAt as fresh ok', async () => {
    const root = await makeTempDir('preflight-fresh-');
    await scaffoldRepo(root, new Date(Date.now() - 2 * 60 * 1000).toISOString());

    const record = handoffRecord(await runPreflightJson(root));

    assert.equal(record.ok, true);
    assert.equal(record.level, 'ok');
    assert.match(record.detail, /fresh/);
  });

  it('reports 30 minute age as info', async () => {
    const root = await makeTempDir('preflight-info-');
    await scaffoldRepo(root, new Date(Date.now() - 30 * 60 * 1000).toISOString());

    const record = handoffRecord(await runPreflightJson(root));

    assert.equal(record.ok, true);
    assert.equal(record.level, 'info');
    assert.match(record.detail, /age=/);
  });

  it('reports multi-day age as warn without failing', async () => {
    const root = await makeTempDir('preflight-warn-');
    await scaffoldRepo(root, new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString());

    const record = handoffRecord(await runPreflightJson(root));

    assert.equal(record.ok, true);
    assert.equal(record.level, 'warn');
    assert.match(record.detail, /stale/);
  });
});
