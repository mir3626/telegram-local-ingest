import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, it } from 'node:test';

const execFile = promisify(execFileCallback);
const tempDirs: string[] = [];
const preflightPath = path.resolve('.vibe', 'harness', 'scripts', 'vibe-preflight.mjs');
const isWin = process.platform === 'win32';

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

async function initGitRepo(root: string): Promise<void> {
  await execFile('git', ['init'], { cwd: root });
  await execFile('git', ['config', 'user.name', 'Test User'], { cwd: root });
  await execFile('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
  await execFile('git', ['add', '.'], { cwd: root });
  await execFile('git', ['commit', '-m', 'init'], { cwd: root });
}

async function scaffoldRepo(
  root: string,
  options: { includeWrapper: boolean; includeShim: boolean },
): Promise<void> {
  const scriptsDir = path.join(root, 'scripts');
  const binDir = path.join(root, 'bin');

  await mkdir(path.join(root, '.vibe', 'agent'), { recursive: true });
  await mkdir(path.join(root, 'docs', 'context'), { recursive: true });
  await mkdir(scriptsDir, { recursive: true });

  await writeJson(path.join(root, '.vibe', 'config.json'), {
    harnessVersion: '1.1.1',
    harnessVersionInstalled: '1.1.1',
    sprintRoles: {
      planner: 'gemini',
      generator: 'gemini',
      evaluator: 'gemini',
    },
    sprint: {
      unit: 'feature',
      subAgentPerRole: true,
      freshContextPerSprint: true,
    },
    providers: {
      gemini: {
        command: 'gemini',
        args: [],
      },
    },
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
    stateUpdatedAt: '2026-04-01T00:00:00.000Z',
  });
  await writeFile(path.join(root, '.vibe', 'agent', 'handoff.md'), '# handoff\n', 'utf8');
  await writeFile(path.join(root, '.vibe', 'agent', 'session-log.md'), '## Entries\n', 'utf8');
  await writeFile(
    path.join(root, 'docs', 'context', 'product.md'),
    'This stub product document is intentionally long enough to satisfy the phase zero gate in tests.\n',
    'utf8',
  );

  if (options.includeWrapper) {
    const wrapperPath = path.join(scriptsDir, `run-gemini.${isWin ? 'cmd' : 'sh'}`);
    const wrapperBody = isWin ? '@echo off\r\necho gemini 1.0\r\n' : '#!/bin/sh\necho gemini 1.0\n';
    await writeFile(wrapperPath, wrapperBody, 'utf8');
    if (!isWin) {
      await chmod(wrapperPath, 0o755);
    }
  }

  if (options.includeShim) {
    await mkdir(binDir, { recursive: true });
    const shimPath = path.join(binDir, `gemini${isWin ? '.cmd' : ''}`);
    const shimBody = isWin ? '@echo off\r\necho gemini 1.0\r\n' : '#!/bin/sh\necho gemini 1.0\n';
    await writeFile(shimPath, shimBody, 'utf8');
    if (!isWin) {
      await chmod(shimPath, 0o755);
    }
  }

  await initGitRepo(root);
}

async function runPreflightJson(root: string): Promise<Array<{ id: string; detail: string; level: string; ok: boolean }>> {
  const binDir = path.join(root, 'bin');
  const { stdout } = await execFile('node', [preflightPath, '--json'], {
    cwd: root,
    env: {
      ...process.env,
      PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
    },
  });
  return JSON.parse(stdout) as Array<{ id: string; detail: string; level: string; ok: boolean }>;
}

function providerRecord(records: Array<{ id: string; detail: string; level: string; ok: boolean }>) {
  const record = records.find((entry) => entry.id === 'provider.gemini');
  assert.ok(record);
  return record;
}

describe('vibe-preflight provider wrapper detection', () => {
  it('uses run-<provider> wrapper files generically', async () => {
    const root = await makeTempDir('preflight-wrapper-');
    await scaffoldRepo(root, { includeWrapper: true, includeShim: false });

    const record = providerRecord(await runPreflightJson(root));

    assert.equal(record.ok, true);
    assert.equal(record.level, 'ok');
    assert.match(record.detail, /gemini 1\.0/);
  });

  it('falls back to direct provider --version without a wrapper', async () => {
    const root = await makeTempDir('preflight-direct-');
    await scaffoldRepo(root, { includeWrapper: false, includeShim: true });

    const record = providerRecord(await runPreflightJson(root));

    assert.equal(record.ok, true);
    assert.match(record.level, /^(warn|ok)$/);
    assert.match(record.detail, /gemini 1\.0/);
  });
});
