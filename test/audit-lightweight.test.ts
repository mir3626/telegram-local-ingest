import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

const tempDirs: string[] = [];
const auditPath = path.resolve('scripts', 'vibe-audit-lightweight.mjs');

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

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function git(root: string, args: string[]): void {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}

async function scaffoldRepo(root: string): Promise<void> {
  await writeJson(path.join(root, '.vibe', 'agent', 'sprint-status.json'), {
    schemaVersion: '0.1',
    project: {
      name: 'test-project',
      createdAt: '2026-04-01T00:00:00.000Z',
    },
    sprints: [
      { id: 'a', name: 'a', status: 'passed' },
      { id: 'b', name: 'b', status: 'passed' },
      { id: 'c', name: 'c', status: 'passed' },
    ],
    verificationCommands: [],
    pendingRisks: [],
    lastSprintScope: [],
    lastSprintScopeGlob: [],
    sprintsSinceLastAudit: 0,
    stateUpdatedAt: '2026-04-01T00:00:00.000Z',
  });
  await writeFile(path.join(root, 'README.md'), 'initial\n', 'utf8');
  git(root, ['init']);
  git(root, ['config', 'user.name', 'Test User']);
  git(root, ['config', 'user.email', 'test@example.com']);
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'init']);
}

async function commitFile(root: string, filePath: string, content: string, message = 'change'): Promise<void> {
  const abs = path.join(root, filePath);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, content, 'utf8');
  git(root, ['add', '.']);
  git(root, ['commit', '-m', message]);
}

function runAudit(root: string) {
  return spawnSync(process.execPath, [auditPath, 'sprint-test'], {
    cwd: root,
    encoding: 'utf8',
  });
}

async function pendingRiskCount(root: string): Promise<number> {
  const status = JSON.parse(
    await readFile(path.join(root, '.vibe', 'agent', 'sprint-status.json'), 'utf8'),
  ) as { pendingRisks?: unknown[] };
  return status.pendingRisks?.length ?? 0;
}

describe('vibe-audit-lightweight', () => {
  it('emits zero flags for a normal non-src diff', async () => {
    const root = await makeTempDir('audit-light-normal-');
    await scaffoldRepo(root);
    await commitFile(root, 'README.md', 'initial\nupdate\n');

    const result = runAudit(root);
    const output = JSON.parse(result.stdout) as { flags: unknown[]; risksInjected: boolean };

    assert.equal(result.status, 0);
    assert.equal(output.flags.length, 0);
    assert.equal(output.risksInjected, false);
    assert.equal(await pendingRiskCount(root), 0);
  });

  it('flags scripts/tmp-* residue and injects a pendingRisk', async () => {
    const root = await makeTempDir('audit-light-tmp-');
    await scaffoldRepo(root);
    await commitFile(root, 'scripts/tmp-debug.ts', 'export const value = 1;\n');

    const result = runAudit(root);
    const output = JSON.parse(result.stdout) as { flags: Array<{ id: string }>; risksInjected: boolean };

    assert.equal(result.status, 0);
    assert.equal(output.flags.some((flag) => flag.id === 'tmp-script-residue'), true);
    assert.equal(output.risksInjected, true);
    assert.equal(await pendingRiskCount(root), 1);
  });

  it('flags new src files that lack matching test files', async () => {
    const root = await makeTempDir('audit-light-test-');
    await scaffoldRepo(root);
    await commitFile(root, 'src/lib/foo.ts', 'export const foo = 1;\n');

    const result = runAudit(root);
    const output = JSON.parse(result.stdout) as { flags: Array<{ id: string }>; risksInjected: boolean };

    assert.equal(result.status, 0);
    assert.equal(output.flags.some((flag) => flag.id === 'missing-src-test'), true);
    assert.equal(output.risksInjected, true);
    assert.equal(await pendingRiskCount(root), 1);
  });
});
