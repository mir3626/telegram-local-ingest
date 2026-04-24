import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

const scriptPath = path.resolve('scripts', 'vibe-sync-bootstrap.mjs');
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

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, 'utf8')) as T;
}

async function writeBootstrapFixture(root: string, config: Record<string, unknown>): Promise<void> {
  await writeJson(path.join(root, '.vibe', 'config.json'), config);
  await writeJson(path.join(root, '.vibe', 'sync-manifest.json'), {
    manifestVersion: '1.0',
    files: { harness: [], hybrid: {}, project: [] },
    migrations: {},
  });
}

async function writeInitArtifacts(root: string): Promise<void> {
  await mkdir(path.join(root, 'docs', 'context'), { recursive: true });
  await writeFile(path.join(root, 'docs', 'context', 'product.md'), '# Product\n\nDemo project\n', 'utf8');
  await writeJson(path.join(root, '.vibe', 'agent', 'sprint-status.json'), {
    schemaVersion: '0.1',
    project: { name: 'demo', createdAt: '2026-04-01T00:00:00.000Z' },
    sprints: [],
    verificationCommands: [],
    sprintsSinceLastAudit: 0,
  });
}

describe('vibe-sync-bootstrap', () => {
  it('preserves an existing upstream.ref as a real pin', async () => {
    const localRoot = await makeTempDir('vibe-bootstrap-local-pin-');
    const upstreamRoot = await makeTempDir('vibe-bootstrap-upstream-pin-');
    await writeBootstrapFixture(upstreamRoot, { harnessVersion: '1.5.12' });
    await writeInitArtifacts(localRoot);
    await writeJson(path.join(localRoot, '.vibe', 'config.json'), {
      harnessVersion: '1.4.3',
      harnessVersionInstalled: '1.4.3',
      upstream: { type: 'git', url: 'https://github.com/mir3626/vibe-doctor.git', ref: 'v1.4.3' },
    });

    const result = spawnSync(process.execPath, [scriptPath, upstreamRoot], {
      cwd: localRoot,
      encoding: 'utf8',
    });

    assert.equal(result.status, 0, result.stderr);
    const config = await readJson<{ upstream?: { ref?: string }; harnessVersionInstalled?: string }>(
      path.join(localRoot, '.vibe', 'config.json'),
    );
    assert.equal(config.harnessVersionInstalled, '1.5.12');
    assert.equal(config.upstream?.ref, 'v1.4.3');
  });

  it('does not create a new upstream.ref pin for unpinned projects', async () => {
    const localRoot = await makeTempDir('vibe-bootstrap-local-unpinned-');
    const upstreamRoot = await makeTempDir('vibe-bootstrap-upstream-unpinned-');
    await writeBootstrapFixture(upstreamRoot, { harnessVersion: '1.5.12' });
    await writeInitArtifacts(localRoot);
    await writeJson(path.join(localRoot, '.vibe', 'config.json'), {
      harnessVersion: '1.4.3',
      harnessVersionInstalled: '1.4.3',
      upstream: { type: 'git', url: 'https://github.com/mir3626/vibe-doctor.git' },
    });

    const result = spawnSync(process.execPath, [scriptPath, upstreamRoot], {
      cwd: localRoot,
      encoding: 'utf8',
    });

    assert.equal(result.status, 0, result.stderr);
    const config = await readJson<{ upstream?: { ref?: string }; harnessVersionInstalled?: string }>(
      path.join(localRoot, '.vibe', 'config.json'),
    );
    assert.equal(config.harnessVersionInstalled, '1.5.12');
    assert.equal(config.upstream?.ref, undefined);
  });

  it('creates .vibe/config.json for legacy projects without shared config', async () => {
    const localRoot = await makeTempDir('vibe-bootstrap-local-missing-config-');
    const upstreamRoot = await makeTempDir('vibe-bootstrap-upstream-missing-config-');
    await writeBootstrapFixture(upstreamRoot, { harnessVersion: '1.5.12' });
    await writeInitArtifacts(localRoot);

    const result = spawnSync(process.execPath, [scriptPath, upstreamRoot], {
      cwd: localRoot,
      encoding: 'utf8',
    });

    assert.equal(result.status, 0, result.stderr);
    const config = await readJson<{ upstream?: { type?: string; url?: string }; harnessVersionInstalled?: string }>(
      path.join(localRoot, '.vibe', 'config.json'),
    );
    assert.equal(config.harnessVersionInstalled, '1.5.12');
    assert.deepEqual(config.upstream, {
      type: 'local',
      url: upstreamRoot,
    });
  });

  it('refuses bootstrap before /vibe-init creates project state', async () => {
    const localRoot = await makeTempDir('vibe-bootstrap-local-uninitialized-');
    const upstreamRoot = await makeTempDir('vibe-bootstrap-upstream-uninitialized-');
    await writeBootstrapFixture(upstreamRoot, { harnessVersion: '1.5.12' });

    const result = spawnSync(process.execPath, [scriptPath, upstreamRoot], {
      cwd: localRoot,
      encoding: 'utf8',
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /requires an initialized vibe-doctor project/);
    assert.match(result.stderr, /Run \/vibe-init first/);
  });
});
