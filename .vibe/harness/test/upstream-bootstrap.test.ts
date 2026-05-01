import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';

const DEFAULT_UPSTREAM_URL = 'https://github.com/mir3626/vibe-doctor.git';
const gitAvailable = spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0;
const versionCheckPath = path.resolve('.vibe', 'harness', 'scripts', 'vibe-version-check.mjs');
const sessionStartPath = path.resolve('.vibe', 'harness', 'scripts', 'vibe-agent-session-start.mjs');
const initPath = path.resolve('.vibe', 'harness', 'src', 'commands', 'init.ts');
const syncPath = path.resolve('.vibe', 'harness', 'src', 'commands', 'sync.ts');
const tsxLoader = pathToFileURL(path.resolve('node_modules', 'tsx', 'dist', 'loader.mjs')).href;
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

function runGit(root: string, args: string[]): void {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}

async function initRepoWithOrigin(root: string, origin = DEFAULT_UPSTREAM_URL): Promise<void> {
  runGit(root, ['init']);
  runGit(root, ['remote', 'add', 'origin', origin]);
}

async function writeMinimalConfig(root: string, extra: Record<string, unknown> = {}): Promise<void> {
  await writeJson(path.join(root, '.vibe', 'config.json'), {
    harnessVersion: '1.5.7',
    harnessVersionInstalled: '1.5.7',
    orchestrator: 'claude-opus',
    sprintRoles: { planner: 'claude-opus', generator: 'codex', evaluator: 'claude-opus' },
    sprint: { unit: 'feature', subAgentPerRole: true, freshContextPerSprint: true },
    providers: {},
    ...extra,
  });
}

async function initTaggedHarnessUpstream(root: string, version: string): Promise<void> {
  runGit(root, ['init']);
  await writeJson(path.join(root, '.vibe', 'sync-manifest.json'), {
    manifestVersion: '1.0',
    files: { harness: [], hybrid: {}, project: [] },
    migrations: {},
  });
  await addHarnessVersionTag(root, version);
}

async function addHarnessVersionTag(root: string, version: string): Promise<void> {
  await writeJson(path.join(root, '.vibe', 'config.json'), { harnessVersion: version });
  await writeJson(path.join(root, '.vibe', 'sync-manifest.json'), {
    manifestVersion: '1.0',
    files: { harness: [], hybrid: {}, project: [] },
    migrations: {},
  });
  runGit(root, ['add', '.']);
  runGit(root, ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-m', `release ${version}`]);
  runGit(root, ['tag', `v${version}`]);
}

describe('upstream bootstrap', { skip: !gitAvailable }, () => {
  it('session-start infers upstream from git remote origin before version cache exits', async () => {
    const root = await makeTempDir('vibe-upstream-session-');
    await initRepoWithOrigin(root);
    await writeMinimalConfig(root);
    await writeJson(path.join(root, '.vibe', 'sync-cache.json'), {
      lastCheckedAt: new Date().toISOString(),
      latestVersion: null,
    });

    const result = spawnSync(process.execPath, [sessionStartPath], {
      cwd: root,
      env: { ...process.env, VIBE_ROOT: root },
      encoding: 'utf8',
    });

    assert.equal(result.status, 0, result.stderr);

    const config = await readJson<{ upstream?: { type?: string; url?: string } }>(path.join(root, '.vibe', 'config.json'));
    assert.deepEqual(config.upstream, {
      type: 'git',
      url: DEFAULT_UPSTREAM_URL,
    });
  });

  it('preserves an existing upstream during session-start bootstrap', async () => {
    const root = await makeTempDir('vibe-upstream-preserve-');
    const existing = { type: 'git', url: 'https://example.com/custom/vibe.git', ref: 'main' };
    await initRepoWithOrigin(root);
    await writeMinimalConfig(root, { upstream: existing });

    const result = spawnSync(process.execPath, [versionCheckPath, '--ensure-upstream-only'], {
      cwd: root,
      env: { ...process.env, VIBE_ROOT: root },
      encoding: 'utf8',
    });

    assert.equal(result.status, 0, result.stderr);

    const config = await readJson<{ upstream?: unknown }>(path.join(root, '.vibe', 'config.json'));
    assert.deepEqual(config.upstream, existing);
  });

  it('force refresh ignores a fresh stale sync cache during explicit sync', async () => {
    const root = await makeTempDir('vibe-version-force-local-');
    const upstream = await makeTempDir('vibe-version-force-upstream-');
    await initTaggedHarnessUpstream(upstream, '1.6.3');
    await writeMinimalConfig(root, {
      harnessVersion: '1.5.15',
      harnessVersionInstalled: '1.5.15',
      upstream: { type: 'git', url: upstream, ref: 'v1.5.15' },
    });
    await writeJson(path.join(root, '.vibe', 'sync-cache.json'), {
      lastCheckedAt: new Date().toISOString(),
      latestVersion: '1.5.15',
    });

    const result = spawnSync(process.execPath, [versionCheckPath, '--force'], {
      cwd: root,
      env: { ...process.env, VIBE_ROOT: root },
      encoding: 'utf8',
    });

    assert.equal(result.status, 0, result.stderr);

    const cache = await readJson<{ latestVersion?: string; versions?: string[] }>(path.join(root, '.vibe', 'sync-cache.json'));
    assert.equal(cache.latestVersion, '1.6.3');
    assert.deepEqual(cache.versions, ['1.6.3']);
  });

  it('version check caches all semver tags and suppresses exact-pin update notices', async () => {
    const root = await makeTempDir('vibe-version-list-local-');
    const upstream = await makeTempDir('vibe-version-list-upstream-');
    await initTaggedHarnessUpstream(upstream, '1.5.15');
    await addHarnessVersionTag(upstream, '1.6.3');
    await addHarnessVersionTag(upstream, '2.0.0');
    await writeMinimalConfig(root, {
      harnessVersion: '1.5.15',
      harnessVersionInstalled: '1.5.15',
      upstream: { type: 'git', url: upstream, ref: 'v1.5.15' },
    });

    const result = spawnSync(process.execPath, [versionCheckPath, '--force'], {
      cwd: root,
      env: { ...process.env, VIBE_ROOT: root },
      encoding: 'utf8',
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '');

    const cache = await readJson<{ latestVersion?: string; versions?: string[] }>(path.join(root, '.vibe', 'sync-cache.json'));
    assert.equal(cache.latestVersion, '2.0.0');
    assert.deepEqual(cache.versions, ['1.5.15', '1.6.3', '2.0.0']);
  });

  it('falls back to the default harness upstream when origin is unavailable', async () => {
    const root = await makeTempDir('vibe-upstream-no-origin-');
    await writeMinimalConfig(root);

    const result = spawnSync(process.execPath, [versionCheckPath, '--ensure-upstream-only'], {
      cwd: root,
      env: { ...process.env, VIBE_ROOT: root },
      encoding: 'utf8',
    });

    assert.equal(result.status, 0, result.stderr);

    const config = await readJson<{ upstream?: unknown }>(path.join(root, '.vibe', 'config.json'));
    assert.deepEqual(config.upstream, {
      type: 'git',
      url: DEFAULT_UPSTREAM_URL,
    });
  });

  it('uses the default harness upstream instead of a product repository origin', async () => {
    const root = await makeTempDir('vibe-upstream-product-origin-');
    await initRepoWithOrigin(root, 'https://github.com/mir3626/telegram-local-ingest.git');
    await writeMinimalConfig(root);

    const result = spawnSync(process.execPath, [versionCheckPath, '--ensure-upstream-only'], {
      cwd: root,
      env: { ...process.env, VIBE_ROOT: root },
      encoding: 'utf8',
    });

    assert.equal(result.status, 0, result.stderr);

    const config = await readJson<{ upstream?: unknown }>(path.join(root, '.vibe', 'config.json'));
    assert.deepEqual(config.upstream, {
      type: 'git',
      url: DEFAULT_UPSTREAM_URL,
    });
  });

  it('does not auto-bootstrap the template source checkout as its own upstream', async () => {
    const parent = await makeTempDir('vibe-upstream-self-parent-');
    const root = path.join(parent, 'vibe-doctor');
    await mkdir(root, { recursive: true });
    await initRepoWithOrigin(root);
    await writeMinimalConfig(root);

    const result = spawnSync(process.execPath, [versionCheckPath, '--ensure-upstream-only'], {
      cwd: root,
      env: { ...process.env, VIBE_ROOT: root },
      encoding: 'utf8',
    });

    assert.equal(result.status, 0, result.stderr);

    const config = await readJson<{ upstream?: unknown }>(path.join(root, '.vibe', 'config.json'));
    assert.deepEqual(config.upstream, {
      type: 'git',
      url: DEFAULT_UPSTREAM_URL,
      self: true,
    });
  });

  it('/vibe-init runs the same upstream bootstrap best-effort', async () => {
    const root = await makeTempDir('vibe-upstream-init-');
    await initRepoWithOrigin(root);
    await writeMinimalConfig(root);
    await writeJson(path.join(root, '.vibe', 'config.local.example.json'), {
      orchestrator: 'claude-opus',
      sprintRoles: { planner: 'claude-opus', generator: 'codex', evaluator: 'claude-opus' },
      sprint: { unit: 'feature', subAgentPerRole: true, freshContextPerSprint: true },
      providers: {},
    });
    await writeFile(path.join(root, '.env.example'), 'TOKEN=\n', 'utf8');
    await mkdir(path.join(root, 'scripts'), { recursive: true });
    await copyFile(versionCheckPath, path.join(root, 'scripts', 'vibe-version-check.mjs'));

    const result = spawnSync(process.execPath, ['--import', tsxLoader, initPath, '--from-agent-skill', '--mode=human'], {
      cwd: root,
      env: { ...process.env, VIBE_ROOT: root },
      input: '',
      encoding: 'utf8',
    });

    assert.equal(result.status, 0, result.stderr);

    const config = await readJson<{ upstream?: { type?: string; url?: string } }>(path.join(root, '.vibe', 'config.json'));
    assert.deepEqual(config.upstream, {
      type: 'git',
      url: DEFAULT_UPSTREAM_URL,
    });
  });

  it('skips self-sync unless an explicit source override is supplied', async () => {
    const parent = await makeTempDir('vibe-upstream-sync-parent-');
    const root = path.join(parent, 'vibe-doctor');
    await mkdir(root, { recursive: true });
    await writeMinimalConfig(root, {
      upstream: { type: 'git', url: DEFAULT_UPSTREAM_URL },
    });

    const result = spawnSync(process.execPath, ['--import', tsxLoader, syncPath, '--dry-run'], {
      cwd: root,
      env: { ...process.env, VIBE_ROOT: root },
      encoding: 'utf8',
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Skipping sync: this checkout is marked as the vibe-doctor template source/);
  });

  it('/vibe-sync refuses to run before /vibe-init creates project state', async () => {
    const root = await makeTempDir('vibe-sync-uninitialized-');

    const result = spawnSync(process.execPath, ['--import', tsxLoader, syncPath, '--dry-run'], {
      cwd: root,
      env: { ...process.env, VIBE_ROOT: root },
      encoding: 'utf8',
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /requires an initialized vibe-doctor project/);
    assert.match(result.stderr, /Run \/vibe-init first/);
  });
});
