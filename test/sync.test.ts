import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import {
  buildSyncPlan,
  computeFileHash,
  jsonDeepMerge,
  lineUnionMerge,
  sectionMerge,
  type HybridFileConfig,
  type SyncManifest,
} from '../src/lib/sync.js';

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

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

describe('sectionMerge', () => {
  const config: HybridFileConfig = {
    strategy: 'section-merge',
    harnessMarkers: ['HARNESS:core'],
    preserveMarkers: ['SPRINT_ROLES'],
  };

  it('replaces harness sections and preserves project sections', () => {
    const local = `Intro
<!-- BEGIN:HARNESS:core -->
old harness
<!-- END:HARNESS:core -->
<!-- BEGIN:SPRINT_ROLES -->
local roles
<!-- END:SPRINT_ROLES -->
<!-- BEGIN:PROJECT:custom -->
local custom
<!-- END:PROJECT:custom -->
`;

    const upstream = `Header
<!-- BEGIN:HARNESS:core -->
new harness
<!-- END:HARNESS:core -->
<!-- BEGIN:SPRINT_ROLES -->
upstream roles
<!-- END:SPRINT_ROLES -->
<!-- BEGIN:PROJECT:custom -->
upstream custom
<!-- END:PROJECT:custom -->
Footer
`;

    const merged = sectionMerge(local, upstream, config);
    assert.equal(merged?.includes('new harness'), true);
    assert.equal(merged?.includes('local roles'), true);
    assert.equal(merged?.includes('local custom'), true);
    assert.equal(merged?.startsWith('Header'), true);
  });

  it('returns null for legacy files without markers', () => {
    assert.equal(sectionMerge('legacy file', 'upstream', config), null);
  });

  it('keeps new upstream sections', () => {
    const local = `<!-- BEGIN:SPRINT_ROLES -->
local roles
<!-- END:SPRINT_ROLES -->`;
    const upstream = `<!-- BEGIN:SPRINT_ROLES -->
upstream roles
<!-- END:SPRINT_ROLES -->
<!-- BEGIN:HARNESS:core -->
new harness
<!-- END:HARNESS:core -->`;

    const merged = sectionMerge(local, upstream, config);
    assert.equal(merged?.includes('new harness'), true);
    assert.equal(merged?.includes('local roles'), true);
  });
});

describe('jsonDeepMerge', () => {
  it('replaces harness keys and preserves project keys', () => {
    const merged = jsonDeepMerge(
      {
        hooks: { a: 1 },
        permissions: { allow: ['x'] },
        keep: true,
      },
      {
        hooks: { b: 2 },
        permissions: { allow: ['y'] },
      },
      {
        strategy: 'json-deep-merge',
        harnessKeys: ['hooks'],
        projectKeys: ['permissions'],
      },
    );

    assert.deepEqual(merged, {
      hooks: { b: 2 },
      permissions: { allow: ['x'] },
      keep: true,
    });
  });

  it('supports scripts.vibe:* glob ownership', () => {
    const merged = jsonDeepMerge(
      {
        scripts: {
          'vibe:doctor': 'old',
          'vibe:sync': 'stale',
          start: 'next start',
        },
      },
      {
        scripts: {
          'vibe:doctor': 'new',
          'vibe:qa': 'qa',
        },
      },
      {
        strategy: 'json-deep-merge',
        harnessKeys: ['scripts.vibe:*'],
      },
    );

    assert.deepEqual(merged, {
      scripts: {
        'vibe:doctor': 'new',
        'vibe:qa': 'qa',
        start: 'next start',
      },
    });
  });
});

describe('lineUnionMerge', () => {
  it('preserves local ignore entries and appends missing upstream entries', () => {
    const local = 'node_modules/\nruntime/\n.env\n';
    const upstream = 'node_modules/\ndist/\n.env\n.vibe/sync-cache.json\n';

    assert.equal(
      lineUnionMerge(local, upstream),
      'node_modules/\nruntime/\n.env\n\ndist/\n.vibe/sync-cache.json\n',
    );
  });
});

describe('computeFileHash', () => {
  it('returns stable hashes for identical content', async () => {
    const dir = await makeTempDir('sync-hash-');
    const fileA = path.join(dir, 'a.txt');
    const fileB = path.join(dir, 'b.txt');
    await writeFile(fileA, 'same', 'utf8');
    await writeFile(fileB, 'same', 'utf8');

    const [hashA, hashB] = await Promise.all([computeFileHash(fileA), computeFileHash(fileB)]);
    assert.equal(hashA, hashB);
  });
});

describe('buildSyncPlan', () => {
  it('creates replace, conflict, new-file and hybrid actions', async () => {
    const localRoot = await makeTempDir('sync-local-');
    const upstreamRoot = await makeTempDir('sync-upstream-');

    const manifest: SyncManifest = {
      manifestVersion: '1.0',
      files: {
        harness: ['scripts/a.mjs', 'scripts/b.mjs', 'scripts/new.mjs'],
        hybrid: {
          'CLAUDE.md': {
            strategy: 'section-merge',
            harnessMarkers: ['HARNESS:core'],
            preserveMarkers: ['SPRINT_ROLES'],
          },
          'package.json': {
            strategy: 'json-deep-merge',
            harnessKeys: ['scripts.vibe:*'],
            projectKeys: ['name'],
          },
          '.gitignore': {
            strategy: 'line-union',
            note: 'preserve project ignore entries',
          },
        },
        project: [],
      },
      migrations: {
        '1.0.0': 'migrations/1.0.0.mjs',
        '1.1.0': 'migrations/1.1.0.mjs',
      },
    };

    await writeJson(path.join(localRoot, '.vibe', 'config.json'), {
      orchestrator: 'x',
      harnessVersionInstalled: '1.0.0',
      sprintRoles: { planner: 'a', generator: 'b', evaluator: 'c' },
      sprint: { unit: 'feature', subAgentPerRole: true, freshContextPerSprint: true },
      providers: {},
    });
    await writeJson(path.join(upstreamRoot, '.vibe', 'config.json'), {
      orchestrator: 'x',
      harnessVersion: '1.1.0',
      sprintRoles: { planner: 'a', generator: 'b', evaluator: 'c' },
      sprint: { unit: 'feature', subAgentPerRole: true, freshContextPerSprint: true },
      providers: {},
    });

    await mkdir(path.join(localRoot, 'scripts'), { recursive: true });
    await mkdir(path.join(upstreamRoot, 'scripts'), { recursive: true });

    await writeFile(path.join(localRoot, 'scripts/a.mjs'), 'same', 'utf8');
    await writeFile(path.join(upstreamRoot, 'scripts/a.mjs'), 'upstream', 'utf8');
    await writeFile(path.join(localRoot, 'scripts/b.mjs'), 'local change', 'utf8');
    await writeFile(path.join(upstreamRoot, 'scripts/b.mjs'), 'upstream', 'utf8');
    await writeFile(path.join(upstreamRoot, 'scripts/new.mjs'), 'new', 'utf8');

    await writeJson(path.join(localRoot, '.vibe', 'sync-hashes.json'), {
      files: {
        'scripts/a.mjs': await computeFileHash(path.join(localRoot, 'scripts/a.mjs')),
        'scripts/b.mjs': 'outdated-hash',
      },
    });

    await writeFile(
      path.join(localRoot, 'CLAUDE.md'),
      '<!-- BEGIN:SPRINT_ROLES -->\nlocal\n<!-- END:SPRINT_ROLES -->',
      'utf8',
    );
    await writeFile(
      path.join(upstreamRoot, 'CLAUDE.md'),
      '<!-- BEGIN:SPRINT_ROLES -->\nupstream\n<!-- END:SPRINT_ROLES -->',
      'utf8',
    );

    await writeJson(path.join(localRoot, 'package.json'), { name: 'local' });
    await writeJson(path.join(upstreamRoot, 'package.json'), {
      name: 'upstream',
      scripts: { 'vibe:sync': 'sync' },
    });
    await writeFile(path.join(localRoot, '.gitignore'), 'node_modules/\nruntime/\n', 'utf8');
    await writeFile(path.join(upstreamRoot, '.gitignore'), 'node_modules/\ndist/\n', 'utf8');

    const plan = await buildSyncPlan(localRoot, upstreamRoot, manifest);

    assert.equal(plan.fromVersion, '1.0.0');
    assert.equal(plan.toVersion, '1.1.0');
    assert.deepEqual(plan.migrations, ['migrations/1.1.0.mjs']);

    assert.equal(plan.actions.some((action) => action.type === 'replace' && action.path === 'scripts/a.mjs'), true);
    assert.equal(plan.actions.some((action) => action.type === 'conflict' && action.path === 'scripts/b.mjs'), true);
    assert.equal(plan.actions.some((action) => action.type === 'new-file' && action.path === 'scripts/new.mjs'), true);
    assert.equal(plan.actions.some((action) => action.type === 'section-merge' && action.path === 'CLAUDE.md'), true);
    assert.equal(plan.actions.some((action) => action.type === 'json-merge' && action.path === 'package.json'), true);
    assert.equal(plan.actions.some((action) => action.type === 'line-merge' && action.path === '.gitignore'), true);
  });

  it('expands glob harness entries and deduplicates exact file paths', async () => {
    const localRoot = await makeTempDir('sync-local-glob-');
    const upstreamRoot = await makeTempDir('sync-upstream-glob-');

    const manifest: SyncManifest = {
      manifestVersion: '1.0',
      files: {
        harness: ['scripts/exact.mjs', 'scripts/**/*.mjs'],
        hybrid: {},
        project: [],
      },
      migrations: {},
    };

    await writeJson(path.join(localRoot, '.vibe', 'config.json'), {
      orchestrator: 'x',
      harnessVersionInstalled: '1.0.0',
      sprintRoles: { planner: 'a', generator: 'b', evaluator: 'c' },
      sprint: { unit: 'feature', subAgentPerRole: true, freshContextPerSprint: true },
      providers: {},
    });
    await writeJson(path.join(upstreamRoot, '.vibe', 'config.json'), {
      orchestrator: 'x',
      harnessVersion: '1.0.0',
      sprintRoles: { planner: 'a', generator: 'b', evaluator: 'c' },
      sprint: { unit: 'feature', subAgentPerRole: true, freshContextPerSprint: true },
      providers: {},
    });

    await mkdir(path.join(localRoot, 'scripts', 'nested'), { recursive: true });
    await mkdir(path.join(upstreamRoot, 'scripts', 'nested'), { recursive: true });

    await writeFile(path.join(localRoot, 'scripts/exact.mjs'), 'same', 'utf8');
    await writeFile(path.join(upstreamRoot, 'scripts/exact.mjs'), 'upstream', 'utf8');
    await writeFile(path.join(upstreamRoot, 'scripts/nested/new.mjs'), 'new', 'utf8');

    await writeJson(path.join(localRoot, '.vibe', 'sync-hashes.json'), {
      files: {
        'scripts/exact.mjs': await computeFileHash(path.join(localRoot, 'scripts/exact.mjs')),
      },
    });

    const plan = await buildSyncPlan(localRoot, upstreamRoot, manifest);
    const exactActions = plan.actions.filter((action) => action.path === 'scripts/exact.mjs');

    assert.equal(exactActions.length, 1);
    assert.equal(exactActions[0]?.type, 'replace');
    assert.equal(
      plan.actions.some((action) => action.type === 'new-file' && action.path === 'scripts/nested/new.mjs'),
      true,
    );
  });
});

describe('sync manifest', () => {
  it('includes M1 schema foundation files and migration', async () => {
    const manifest = JSON.parse(await readFile(path.join(process.cwd(), '.vibe', 'sync-manifest.json'), 'utf8')) as SyncManifest;

    assert.equal(manifest.files.harness.includes('src/lib/sprint-status.ts'), true);
    assert.equal(manifest.files.harness.includes('src/lib/project-map.ts'), true);
    assert.equal(manifest.files.harness.includes('migrations/1.1.0.mjs'), true);
    assert.equal(manifest.files.harness.includes('scripts/vibe-sprint-commit.mjs'), true);
    assert.equal(manifest.files.harness.includes('scripts/vibe-session-log-sync.mjs'), true);
    assert.equal(manifest.files.harness.includes('src/lib/decisions.ts'), true);
    assert.equal(manifest.files.harness.includes('.claude/skills/test-patterns/**'), true);
    assert.equal(manifest.files.harness.includes('.claude/skills/lint-patterns/**'), true);
    assert.equal(manifest.files.harness.includes('scripts/vibe-phase0-seal.mjs'), true);
    assert.equal(manifest.files.harness.includes('scripts/vibe-browser-smoke.mjs'), true);
    assert.equal(manifest.files.harness.includes('src/commands/bundle-size.ts'), true);
    assert.equal(manifest.files.harness.includes('.claude/skills/vibe-init/templates/readme-skeleton.md'), true);
    assert.equal(manifest.files.harness.includes('.gitignore'), false);
    assert.equal(manifest.files.hybrid['.gitignore']?.strategy, 'line-union');
    assert.equal(manifest.files.harness.includes('test/bundle-size.test.ts'), true);
    assert.equal(manifest.files.harness.includes('test/phase0-seal.test.ts'), true);
    assert.equal(manifest.files.harness.includes('test/browser-smoke-contract.test.ts'), true);
    assert.equal(manifest.files.project.includes('.vibe/agent/project-map.json'), true);
    assert.equal(manifest.files.project.includes('.vibe/agent/sprint-api-contracts.json'), true);
    assert.equal(manifest.files.project.includes('.vibe/agent/project-decisions.jsonl'), true);
    assert.equal(manifest.files.project.includes('.vibe/archive/README.md'), true);
    assert.equal(manifest.migrations['1.1.0'], 'migrations/1.1.0.mjs');
  });
});
