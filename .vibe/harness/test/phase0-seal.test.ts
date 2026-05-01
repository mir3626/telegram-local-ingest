import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const tempDirs: string[] = [];
const phase0SealPath = path.resolve('.vibe', 'harness', 'scripts', 'vibe-phase0-seal.mjs');
const gitEnv = {
  GIT_AUTHOR_DATE: '2026-04-16T00:00:00.000Z',
  GIT_COMMITTER_DATE: '2026-04-16T00:00:00.000Z',
};

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

async function writeText(filePath: string, value: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, value, 'utf8');
}

async function initGitRepo(root: string): Promise<void> {
  await execFile('git', ['init'], { cwd: root, env: { ...process.env, ...gitEnv } });
  await execFile('git', ['config', 'user.name', 'Test User'], { cwd: root });
  await execFile('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
  await execFile('git', ['config', 'commit.gpgsign', 'false'], { cwd: root });
  await writeText(path.join(root, 'package.json'), '{ "name": "fallback-name" }\n');
  await execFile('git', ['add', '.'], { cwd: root });
  await execFile('git', ['commit', '-m', 'init'], {
    cwd: root,
    env: { ...process.env, ...gitEnv },
  });
}

async function runPhase0Seal(root: string, args: string[] = []) {
  return execFile(process.execPath, [phase0SealPath, ...args], {
    cwd: root,
    env: { ...process.env, ...gitEnv },
  });
}

describe('vibe-phase0-seal', () => {
  it('creates a seal commit for Phase 0 candidate files with the expected prefix', async () => {
    const root = await makeTempDir('phase0-seal-commit-');
    await initGitRepo(root);

    await writeText(path.join(root, 'docs', 'context', 'product.md'), '# Demo Project\n\nOne line.\n');
    await writeText(path.join(root, 'docs', 'context', 'architecture.md'), '# Architecture\n');
    await writeText(path.join(root, 'docs', 'context', 'conventions.md'), '# Conventions\n');
    await writeText(path.join(root, 'docs', 'plans', 'sprint-roadmap.md'), '# Roadmap\n');
    await writeText(path.join(root, '.vibe', 'interview-log', 'session.json'), '{"ok":true}\n');

    const before = await execFile('git', ['rev-list', '--count', 'HEAD'], { cwd: root });
    const { stdout } = await runPhase0Seal(root);
    const after = await execFile('git', ['rev-list', '--count', 'HEAD'], { cwd: root });
    const { stdout: subject } = await execFile('git', ['log', '-1', '--format=%s'], { cwd: root });

    assert.equal(Number(after.stdout.trim()), Number(before.stdout.trim()) + 1);
    assert.match(stdout, /\[phase0-seal\] committed:/);
    assert.match(subject, /^chore\(phase0\): /);
    assert.match(subject, /Phase 0 seal/);
    assert.match(subject, /Demo Project\n?$/);
  });

  it('is idempotent when re-run after the seal commit', async () => {
    const root = await makeTempDir('phase0-seal-idempotent-');
    await initGitRepo(root);
    await writeText(path.join(root, 'docs', 'context', 'product.md'), '# Demo Project\n');

    await runPhase0Seal(root);
    const countBefore = await execFile('git', ['rev-list', '--count', 'HEAD'], { cwd: root });
    const { stdout } = await runPhase0Seal(root);
    const countAfter = await execFile('git', ['rev-list', '--count', 'HEAD'], { cwd: root });

    assert.match(stdout, /\[phase0-seal\] already sealed \(no changes\)/);
    assert.equal(countAfter.stdout.trim(), countBefore.stdout.trim());
  });
});
