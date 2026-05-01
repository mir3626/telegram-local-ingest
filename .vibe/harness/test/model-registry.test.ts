import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import {
  loadRegistry,
  resolveRoleRef,
  type ModelRegistry,
  type RoleRef,
} from '../src/lib/model-registry.js';

const tempDirs: string[] = [];
const resolverScriptPath = path.resolve('.vibe', 'harness', 'scripts', 'vibe-resolve-model.mjs');
const registryCheckScriptPath = path.resolve('.vibe', 'harness', 'scripts', 'vibe-model-registry-check.mjs');
const gitAvailable = spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0;

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

function runGit(root: string, args: string[]): void {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}

function makeRegistry(schemaVersion: 1 = 1): ModelRegistry {
  return {
    schemaVersion,
    updatedAt: '2026-04-15T00:00:00.000Z',
    source: 'test',
    providers: {
      anthropic: {
        tiers: {
          flagship: 'opus',
          performant: 'sonnet',
          efficient: 'haiku',
        },
        knownModels: {
          opus: {
            apiId: 'claude-opus-4-6',
            release: '2026-04',
          },
          sonnet: {
            apiId: 'claude-sonnet-4-6',
            release: '2026-04',
          },
          haiku: {
            apiId: 'claude-haiku-4-5',
            release: '2025-10',
          },
        },
      },
    },
  };
}

async function writeFixtureRoot(
  roleRef: RoleRef = { provider: 'anthropic', tier: 'flagship' },
): Promise<{ root: string; registry: ModelRegistry }> {
  const root = await makeTempDir('model-registry-');
  const registry = makeRegistry();

  await writeJson(path.join(root, '.vibe', 'model-registry.json'), registry);
  await writeJson(path.join(root, '.vibe', 'config.json'), {
    orchestrator: 'claude-opus',
    sprintRoles: {
      planner: roleRef,
      generator: 'codex',
      evaluator: 'claude-opus',
    },
    sprint: {
      unit: 'feature',
      subAgentPerRole: true,
      freshContextPerSprint: true,
    },
    providers: {},
  });

  return { root, registry };
}

describe('model-registry', () => {
  it('loadRegistry reads a valid fixture', async () => {
    const { root, registry } = await writeFixtureRoot();

    const loaded = await loadRegistry(root);

    assert.deepEqual(loaded, registry);
  });

  it('loadRegistry rejects unsupported schema versions', async () => {
    const root = await makeTempDir('model-registry-schema-');
    await writeJson(path.join(root, '.vibe', 'model-registry.json'), {
      ...makeRegistry(),
      schemaVersion: 2,
    });

    await assert.rejects(
      loadRegistry(root),
      /registry schemaVersion 2 is unsupported; run npm run vibe:sync to refresh the harness registry/,
    );
  });

  it('resolveRoleRef supports legacy passthrough without a registry', () => {
    assert.deepEqual(resolveRoleRef(null, 'claude-opus'), {
      provider: 'claude-opus',
      familyAlias: 'claude-opus',
      apiId: 'claude-opus',
      legacy: true,
    });
  });

  it('resolveRoleRef resolves tier references through the registry', () => {
    assert.deepEqual(
      resolveRoleRef(makeRegistry(), { provider: 'anthropic', tier: 'flagship' }),
      {
        provider: 'anthropic',
        tier: 'flagship',
        familyAlias: 'opus',
        apiId: 'claude-opus-4-6',
        legacy: false,
      },
    );
  });

  it('unknown tier errors include available tiers', () => {
    const registry = makeRegistry();
    delete registry.providers.anthropic?.tiers.flagship;

    assert.throws(
      () => resolveRoleRef(registry, { provider: 'anthropic', tier: 'flagship' }),
      /registry: provider "anthropic" has no tier "flagship" \(available: performant, efficient\)/,
    );
  });

  it('unknown provider errors include available providers', () => {
    assert.throws(
      () => resolveRoleRef(makeRegistry(), { provider: 'openai', tier: 'flagship' }),
      /registry: unknown provider "openai" \(available: anthropic\)/,
    );
  });

  it('keeps CLI resolution in lockstep with the library', async () => {
    const { root, registry } = await writeFixtureRoot();
    const expected = resolveRoleRef(registry, { provider: 'anthropic', tier: 'flagship' });
    const stdout = execFileSync('node', [resolverScriptPath, 'planner', '--json'], {
      cwd: root,
      encoding: 'utf8',
    }).trim();

    assert.equal(
      JSON.stringify(JSON.parse(stdout)),
      JSON.stringify(expected),
    );
  });

  it('model registry check accepts caret upstream refs as version ranges', { skip: !gitAvailable }, async () => {
    const root = await makeTempDir('model-registry-caret-ref-');
    runGit(root, ['init']);
    await writeJson(path.join(root, '.vibe', 'model-registry.json'), {
      ...makeRegistry(),
      schemaVersion: 2,
    });
    runGit(root, ['add', '.']);
    runGit(root, ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-m', 'upstream registry']);
    runGit(root, ['tag', 'v1.0.0']);

    await writeJson(path.join(root, '.vibe', 'model-registry.json'), makeRegistry());
    await writeJson(path.join(root, '.vibe', 'config.json.upstream'), {
      upstream: { type: 'git', ref: '^v1.0.0' },
    });

    const result = spawnSync(process.execPath, [registryCheckScriptPath], {
      cwd: root,
      encoding: 'utf8',
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /model-registry update available/);
  });
});
