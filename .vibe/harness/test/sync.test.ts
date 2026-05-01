import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { promisify } from 'node:util';
import {
  applySyncPlan,
  buildSyncPlan,
  computeFileHash,
  jsonArrayUnionMerge,
  jsonDeepMerge,
  lineUnionMerge,
  sectionMerge,
  type HybridFileConfig,
  type SyncManifest,
} from '../src/lib/sync.js';
import {
  hasVibeInitArtifacts,
  resolveMissingUpstream,
  resolveFloatingRefUpdateCandidate,
  resolvePostSyncTypecheckArgs,
  renderSyncInitGuardMessage,
  resolveUpstreamRef,
} from '../src/commands/sync.js';
import type { VibeConfig } from '../src/lib/config.js';

const tempDirs: string[] = [];
const execFile = promisify(execFileCallback);

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

function minimalConfig(overrides: Partial<VibeConfig> = {}): VibeConfig {
  return {
    orchestrator: 'x',
    harnessVersion: '1.4.3',
    harnessVersionInstalled: '1.4.3',
    upstream: { type: 'git', url: 'https://github.com/mir3626/vibe-doctor.git', ref: 'v1.4.3' },
    sprintRoles: { planner: 'a', generator: 'b', evaluator: 'c' },
    sprint: { unit: 'feature', subAgentPerRole: true, freshContextPerSprint: true },
    providers: {},
    ...overrides,
  };
}

describe('resolveUpstreamRef', () => {
  it('preserves exact semver upstream refs as hard pins', () => {
    assert.equal(resolveUpstreamRef(minimalConfig(), undefined, { latestVersion: 'v1.5.9' }), 'v1.4.3');
  });

  it('floats caret upstream refs to the latest compatible cached version', () => {
    const config = minimalConfig({
      upstream: { type: 'git', url: 'https://github.com/mir3626/vibe-doctor.git', ref: '^v1.4.3' },
    });

    assert.equal(
      resolveUpstreamRef(config, undefined, { latestVersion: 'v2.0.0', versions: ['1.4.3', '1.5.9', '2.0.0'] }),
      'v1.5.9',
    );
  });

  it('uses cached latestVersion for unpinned default sync when the project is behind', () => {
    const config = minimalConfig({
      upstream: { type: 'git', url: 'https://github.com/mir3626/vibe-doctor.git' },
    });

    assert.equal(resolveUpstreamRef(config, undefined, { latestVersion: 'v1.5.9' }), 'v1.5.9');
  });

  it('keeps explicit --ref override as the highest priority', () => {
    assert.equal(resolveUpstreamRef(minimalConfig(), 'v1.4.3', { latestVersion: 'v1.5.9' }), 'v1.4.3');
  });

  it('preserves non-version upstream refs such as main or feature branches', () => {
    const config = minimalConfig({
      upstream: { type: 'git', url: 'https://github.com/mir3626/vibe-doctor.git', ref: 'main' },
    });

    assert.equal(resolveUpstreamRef(config, undefined, { latestVersion: 'v1.5.9' }), 'main');
  });

  it('ignores stale cached latestVersion values', () => {
    assert.equal(resolveUpstreamRef(minimalConfig(), undefined, { latestVersion: 'v1.4.3' }), 'v1.4.3');
  });

  it('reports an update candidate only when a caret range has a compatible newer version', () => {
    assert.deepEqual(
      resolveFloatingRefUpdateCandidate(
        minimalConfig({ upstream: { type: 'git', url: 'https://github.com/mir3626/vibe-doctor.git', ref: '^v1.4.3' } }),
        { latestVersion: 'v2.0.0', versions: ['1.4.3', '1.5.9', '2.0.0'] },
      ),
      {
        rangeRef: '^v1.4.3',
        baseRef: 'v1.4.3',
        latestRef: 'v1.5.9',
      },
    );
    assert.equal(resolveFloatingRefUpdateCandidate(minimalConfig(), { latestVersion: 'v1.5.9' }), undefined);
    assert.equal(
      resolveFloatingRefUpdateCandidate(
        minimalConfig({ upstream: { type: 'git', url: 'https://github.com/mir3626/vibe-doctor.git', ref: '^v1.4.3' } }),
        { latestVersion: 'v2.0.0', versions: ['2.0.0'] },
      ),
      undefined,
    );
    assert.deepEqual(
      resolveFloatingRefUpdateCandidate(
        minimalConfig({ upstream: { type: 'git', url: 'https://github.com/mir3626/vibe-doctor.git', ref: '^1.4.3' } }),
        { latestVersion: 'v1.5.9' },
      ),
      {
        rangeRef: '^1.4.3',
        baseRef: 'v1.4.3',
        latestRef: 'v1.5.9',
      },
    );
    assert.equal(
      resolveFloatingRefUpdateCandidate(
        minimalConfig({ upstream: { type: 'git', url: 'https://github.com/mir3626/vibe-doctor.git', ref: 'main' } }),
        { latestVersion: 'v1.5.9' },
      ),
      undefined,
    );
  });

  it('does not let zero-major caret ranges cross their semver boundary', () => {
    assert.equal(
      resolveUpstreamRef(
        minimalConfig({ upstream: { type: 'git', url: 'https://github.com/mir3626/vibe-doctor.git', ref: '^v0.5.0' } }),
        undefined,
        { latestVersion: 'v0.6.0', versions: ['0.5.0', '0.5.4', '0.6.0'] },
      ),
      'v0.5.4',
    );
    assert.equal(
      resolveUpstreamRef(
        minimalConfig({ upstream: { type: 'git', url: 'https://github.com/mir3626/vibe-doctor.git', ref: '^v0.0.3' } }),
        undefined,
        { latestVersion: 'v0.0.4', versions: ['0.0.3', '0.0.4'] },
      ),
      'v0.0.3',
    );
  });

  it('tracks latestVersion for caret ranges when the cache has no version list yet', () => {
    assert.deepEqual(
      resolveFloatingRefUpdateCandidate(
        minimalConfig({ upstream: { type: 'git', url: 'https://github.com/mir3626/vibe-doctor.git', ref: '^v1.4.3' } }),
        { latestVersion: 'v1.5.9' },
      ),
      {
        rangeRef: '^v1.4.3',
        baseRef: 'v1.4.3',
        latestRef: 'v1.5.9',
      },
    );
  });
});

describe('resolvePostSyncTypecheckArgs', () => {
  it('uses the harness tsconfig when present', async () => {
    const root = await makeTempDir('sync-typecheck-harness-');
    await mkdir(path.join(root, '.vibe', 'harness'), { recursive: true });
    await writeFile(path.join(root, '.vibe', 'harness', 'tsconfig.harness.json'), '{}\n', 'utf8');

    assert.deepEqual(await resolvePostSyncTypecheckArgs(root), [
      'tsc',
      '-p',
      '.vibe/harness/tsconfig.harness.json',
      '--noEmit',
    ]);
  });

  it('supports the legacy root harness tsconfig during migration', async () => {
    const root = await makeTempDir('sync-typecheck-legacy-harness-');
    await writeFile(path.join(root, 'tsconfig.harness.json'), '{}\n', 'utf8');

    assert.deepEqual(await resolvePostSyncTypecheckArgs(root), ['tsc', '-p', 'tsconfig.harness.json', '--noEmit']);
  });

  it('falls back to the legacy root tsconfig command when harness tsconfig is absent', async () => {
    const root = await makeTempDir('sync-typecheck-root-');

    assert.deepEqual(await resolvePostSyncTypecheckArgs(root), ['tsc', '--noEmit']);
  });
});

describe('resolveMissingUpstream', () => {
  it('preserves existing upstream config', () => {
    const upstream = { type: 'git' as const, url: 'https://example.com/custom.git', ref: 'main' };

    assert.deepEqual(resolveMissingUpstream({ upstream }, 'https://github.com/mir3626/vibe-doctor.git', 'app'), upstream);
  });

  it('uses vibe-doctor origin for template-derived dogfood clones', () => {
    assert.deepEqual(
      resolveMissingUpstream({}, 'https://github.com/acme/vibe-doctor.git', 'dogfood10'),
      { type: 'git', url: 'https://github.com/acme/vibe-doctor.git' },
    );
  });

  it('falls back to the default harness upstream for product repositories', () => {
    assert.deepEqual(
      resolveMissingUpstream({}, 'https://github.com/mir3626/telegram-local-ingest.git', 'telegram-local-ingest'),
      { type: 'git', url: 'https://github.com/mir3626/vibe-doctor.git' },
    );
  });

  it('marks the template source checkout as self instead of self-syncing', () => {
    assert.deepEqual(
      resolveMissingUpstream({}, 'https://github.com/mir3626/vibe-doctor.git', 'vibe-doctor'),
      { type: 'git', url: 'https://github.com/mir3626/vibe-doctor.git', self: true },
    );
  });
});

describe('vibe init artifact guard', () => {
  it('explains that sync requires /vibe-init first', () => {
    assert.match(renderSyncInitGuardMessage(), /requires an initialized vibe-doctor project/);
    assert.match(renderSyncInitGuardMessage(), /Run \/vibe-init first/);
  });

  it('rejects missing init artifacts', async () => {
    const root = await makeTempDir('sync-uninitialized-');

    assert.equal(await hasVibeInitArtifacts(root), false);
  });

  it('rejects template sprint state copied into a non-template project', async () => {
    const root = await makeTempDir('sync-template-state-');
    await mkdir(path.join(root, 'docs', 'context'), { recursive: true });
    await writeFile(path.join(root, 'docs', 'context', 'product.md'), '# Product\n\nvibe-doctor template\n', 'utf8');
    await writeJson(path.join(root, '.vibe', 'agent', 'sprint-status.json'), {
      schemaVersion: '0.1',
      project: { name: 'vibe-doctor', createdAt: '2026-04-01T00:00:00.000Z' },
      sprints: [{ id: 'sprint-old', name: 'sprint-old', status: 'passed' }],
      verificationCommands: [],
    });

    assert.equal(await hasVibeInitArtifacts(root), false);
  });

  it('accepts initialized project state with an empty sprint history', async () => {
    const root = await makeTempDir('sync-initialized-');
    await mkdir(path.join(root, 'docs', 'context'), { recursive: true });
    await writeFile(path.join(root, 'docs', 'context', 'product.md'), '# Product\n\nDemo app\n', 'utf8');
    await writeJson(path.join(root, '.vibe', 'agent', 'sprint-status.json'), {
      schemaVersion: '0.1',
      project: { name: 'demo', createdAt: '2026-04-01T00:00:00.000Z' },
      sprints: [],
      verificationCommands: [],
      sprintsSinceLastAudit: 0,
    });

    assert.equal(await hasVibeInitArtifacts(root), true);
  });
});

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

  it('supports exact package script ownership without replacing project scripts', () => {
    const merged = jsonDeepMerge(
      {
        scripts: {
          test: 'vitest',
          'test:ui': 'old-ui',
        },
      },
      {
        scripts: {
          'test:ui': 'node scripts/vibe-playwright-test.mjs',
        },
      },
      {
        strategy: 'json-deep-merge',
        harnessKeys: ['scripts.test:ui'],
      },
    );

    assert.deepEqual(merged, {
      scripts: {
        test: 'vitest',
        'test:ui': 'node scripts/vibe-playwright-test.mjs',
      },
    });
  });
});

describe('jsonArrayUnionMerge', () => {
  it('preserves project array entries and appends upstream recommendations', () => {
    const merged = jsonArrayUnionMerge(
      {
        recommendations: ['project.extension'],
        unwantedRecommendations: ['project.avoid'],
      },
      {
        recommendations: ['EditorConfig.EditorConfig', 'project.extension'],
      },
      {
        strategy: 'json-array-union',
        harnessKeys: ['recommendations'],
      },
    );

    assert.deepEqual(merged, {
      recommendations: ['project.extension', 'EditorConfig.EditorConfig'],
      unwantedRecommendations: ['project.avoid'],
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
          'AGENTS.md': {
            strategy: 'section-merge',
            harnessMarkers: ['HARNESS:agent-memory'],
            preserveMarkers: ['PROJECT:custom-rules'],
          },
          'GEMINI.md': {
            strategy: 'section-merge',
            harnessMarkers: ['HARNESS:agent-memory'],
            preserveMarkers: ['PROJECT:custom-rules'],
          },
          'package.json': {
            strategy: 'json-deep-merge',
            harnessKeys: ['scripts.vibe:*'],
            projectKeys: ['name'],
          },
          '.vscode/extensions.json': {
            strategy: 'json-array-union',
            harnessKeys: ['recommendations'],
          },
          '.env.example': {
            strategy: 'replace-if-unmodified',
          },
          '.github/workflows/ci.yml': {
            strategy: 'replace-if-unmodified',
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
    await writeFile(path.join(localRoot, 'AGENTS.md'), 'legacy agent memory', 'utf8');
    await writeFile(
      path.join(upstreamRoot, 'AGENTS.md'),
      '<!-- BEGIN:HARNESS:agent-memory -->\nagent\n<!-- END:HARNESS:agent-memory -->',
      'utf8',
    );
    await writeFile(path.join(localRoot, 'GEMINI.md'), 'changed legacy memory', 'utf8');
    await writeFile(
      path.join(upstreamRoot, 'GEMINI.md'),
      '<!-- BEGIN:HARNESS:agent-memory -->\ngemini\n<!-- END:HARNESS:agent-memory -->',
      'utf8',
    );

    await writeJson(path.join(localRoot, 'package.json'), { name: 'local' });
    await writeJson(path.join(upstreamRoot, 'package.json'), {
      name: 'upstream',
      scripts: { 'vibe:sync': 'sync' },
    });
    await mkdir(path.join(localRoot, '.github', 'workflows'), { recursive: true });
    await mkdir(path.join(upstreamRoot, '.github', 'workflows'), { recursive: true });
    await writeJson(path.join(localRoot, '.vscode', 'extensions.json'), {
      recommendations: ['project.extension'],
    });
    await writeJson(path.join(upstreamRoot, '.vscode', 'extensions.json'), {
      recommendations: ['EditorConfig.EditorConfig'],
    });
    await writeFile(path.join(localRoot, '.env.example'), 'TOKEN=local\n', 'utf8');
    await writeFile(path.join(upstreamRoot, '.env.example'), 'TOKEN=upstream\n', 'utf8');
    await writeFile(path.join(localRoot, '.github/workflows/ci.yml'), 'local ci change\n', 'utf8');
    await writeFile(path.join(upstreamRoot, '.github/workflows/ci.yml'), 'upstream ci\n', 'utf8');
    await writeFile(path.join(localRoot, '.gitignore'), 'node_modules/\nruntime/\n', 'utf8');
    await writeFile(path.join(upstreamRoot, '.gitignore'), 'node_modules/\ndist/\n', 'utf8');

    await writeJson(path.join(localRoot, '.vibe', 'sync-hashes.json'), {
      files: {
        'scripts/a.mjs': await computeFileHash(path.join(localRoot, 'scripts/a.mjs')),
        'scripts/b.mjs': 'outdated-hash',
        'AGENTS.md': await computeFileHash(path.join(localRoot, 'AGENTS.md')),
        '.env.example': await computeFileHash(path.join(localRoot, '.env.example')),
        '.github/workflows/ci.yml': 'outdated-hash',
      },
    });

    const plan = await buildSyncPlan(localRoot, upstreamRoot, manifest);

    assert.equal(plan.fromVersion, '1.0.0');
    assert.equal(plan.toVersion, '1.1.0');
    assert.deepEqual(plan.migrations, ['migrations/1.1.0.mjs']);

    assert.equal(plan.actions.some((action) => action.type === 'replace' && action.path === 'scripts/a.mjs'), true);
    assert.equal(plan.actions.some((action) => action.type === 'conflict' && action.path === 'scripts/b.mjs'), true);
    assert.equal(plan.actions.some((action) => action.type === 'new-file' && action.path === 'scripts/new.mjs'), true);
    assert.equal(plan.actions.some((action) => action.type === 'section-merge' && action.path === 'CLAUDE.md'), true);
    assert.equal(
      plan.actions.some((action) => action.type === 'replace' && action.path === 'AGENTS.md'),
      true,
    );
    assert.equal(plan.actions.some((action) => action.type === 'skip' && action.path === 'GEMINI.md'), true);
    assert.equal(plan.actions.some((action) => action.type === 'json-merge' && action.path === 'package.json'), true);
    assert.equal(
      plan.actions.some((action) => action.type === 'json-array-union' && action.path === '.vscode/extensions.json'),
      true,
    );
    assert.equal(
      plan.actions.some((action) => action.type === 'replace' && action.path === '.env.example'),
      true,
    );
    assert.equal(
      plan.actions.some((action) => action.type === 'skip' && action.path === '.github/workflows/ci.yml'),
      true,
    );
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

describe('applySyncPlan', () => {
  it('preserves existing non-executable file mode when copying from an executable source', async () => {
    if (process.platform === 'win32') {
      return;
    }

    const localRoot = await makeTempDir('sync-local-mode-');
    const upstreamRoot = await makeTempDir('sync-upstream-mode-');
    const relativePath = 'docs/example.md';
    const localPath = path.join(localRoot, relativePath);
    const upstreamPath = path.join(upstreamRoot, relativePath);

    await mkdir(path.dirname(localPath), { recursive: true });
    await mkdir(path.dirname(upstreamPath), { recursive: true });
    await writeFile(localPath, 'old\n', 'utf8');
    await writeFile(upstreamPath, 'new\n', 'utf8');
    await chmod(localPath, 0o644);
    await chmod(upstreamPath, 0o755);

    await applySyncPlan(
      localRoot,
      upstreamRoot,
      {
        fromVersion: '1.0.0',
        toVersion: '1.0.1',
        migrations: [],
        actions: [{ type: 'replace', path: relativePath, reason: 'test' }],
      },
      {
        manifestVersion: '1.0.1',
        files: { harness: [relativePath], hybrid: {}, project: [] },
        migrations: {},
      },
    );

    assert.equal(await readFile(localPath, 'utf8'), 'new\n');
    assert.equal((await stat(localPath)).mode & 0o777, 0o644);
  });

  it('uses non-executable mode for newly copied files on POSIX filesystems', async () => {
    if (process.platform === 'win32') {
      return;
    }

    const localRoot = await makeTempDir('sync-local-new-mode-');
    const upstreamRoot = await makeTempDir('sync-upstream-new-mode-');
    const relativePath = 'docs/new.md';
    const localPath = path.join(localRoot, relativePath);
    const upstreamPath = path.join(upstreamRoot, relativePath);

    await mkdir(path.dirname(upstreamPath), { recursive: true });
    await writeFile(upstreamPath, 'new\n', 'utf8');
    await chmod(upstreamPath, 0o755);

    await applySyncPlan(
      localRoot,
      upstreamRoot,
      {
        fromVersion: '1.0.0',
        toVersion: '1.0.1',
        migrations: [],
        actions: [{ type: 'new-file', path: relativePath }],
      },
      {
        manifestVersion: '1.0.1',
        files: { harness: [relativePath], hybrid: {}, project: [] },
        migrations: {},
      },
    );

    assert.equal(await readFile(localPath, 'utf8'), 'new\n');
    assert.equal((await stat(localPath)).mode & 0o777, 0o644);
  });

  it('keeps synced shell wrappers executable on POSIX filesystems', async () => {
    if (process.platform === 'win32') {
      return;
    }

    const localRoot = await makeTempDir('sync-local-shell-mode-');
    const upstreamRoot = await makeTempDir('sync-upstream-shell-mode-');
    const relativePath = 'scripts/run-codex.sh';
    const localPath = path.join(localRoot, relativePath);
    const upstreamPath = path.join(upstreamRoot, relativePath);

    await mkdir(path.dirname(localPath), { recursive: true });
    await mkdir(path.dirname(upstreamPath), { recursive: true });
    await writeFile(localPath, '#!/usr/bin/env bash\necho old\n', 'utf8');
    await writeFile(upstreamPath, '#!/usr/bin/env bash\necho new\n', 'utf8');
    await chmod(localPath, 0o644);
    await chmod(upstreamPath, 0o644);

    await applySyncPlan(
      localRoot,
      upstreamRoot,
      {
        fromVersion: '1.0.0',
        toVersion: '1.0.1',
        migrations: [],
        actions: [{ type: 'replace', path: relativePath, reason: 'test' }],
      },
      {
        manifestVersion: '1.0.1',
        files: { harness: [relativePath], hybrid: {}, project: [] },
        migrations: {},
      },
    );

    assert.equal(await readFile(localPath, 'utf8'), '#!/usr/bin/env bash\necho new\n');
    assert.equal((await stat(localPath)).mode & 0o777, 0o755);
  });
});

describe('sync manifest', () => {
  it('keeps harness runtime under .vibe/harness and root code as project-owned', async () => {
    const manifest = JSON.parse(await readFile(path.join(process.cwd(), '.vibe', 'sync-manifest.json'), 'utf8')) as SyncManifest;

    assert.equal(manifest.files.harness.includes('.vibe/harness/src/**'), true);
    assert.equal(manifest.files.harness.includes('.vibe/harness/scripts/**'), true);
    assert.equal(manifest.files.harness.includes('.vibe/harness/test/**'), true);
    assert.equal(manifest.files.harness.includes('.vibe/harness/migrations/**'), true);
    assert.equal(manifest.files.harness.includes('.vibe/harness/tsconfig.harness.json'), true);
    assert.equal(manifest.files.harness.includes('.vibe/harness/playwright.config.ts'), true);
    assert.equal(manifest.files.harness.includes('scripts/vibe-sync-bootstrap.mjs'), true);
    assert.equal(manifest.files.harness.includes('.claude/skills/**'), true);
    assert.equal(manifest.files.harness.includes('.claude/templates/**'), true);
    assert.equal(manifest.files.harness.includes('docs/release/**'), true);
    assert.equal(manifest.files.harness.includes('.codex/skills/**'), true);
    assert.equal(manifest.files.harness.includes('.claude/statusline.mjs'), true);
    assert.equal(manifest.files.harness.includes('src/lib/sprint-status.ts'), false);
    assert.equal(manifest.files.harness.includes('scripts/vibe-sprint-commit.mjs'), false);
    assert.equal(manifest.files.harness.includes('test/checkpoint.test.ts'), false);
    assert.equal(manifest.files.harness.includes('tsconfig.harness.json'), false);
    assert.equal(Boolean(manifest.files.hybrid['tsconfig.json']), false);
    assert.equal(manifest.files.harness.includes('.gitignore'), false);
    assert.equal(manifest.files.harness.includes('.env.example'), false);
    assert.equal(manifest.files.harness.includes('.github/workflows/ci.yml'), false);
    assert.equal(manifest.files.harness.includes('.vscode/settings.json'), false);
    assert.equal(manifest.files.harness.includes('.vscode/extensions.json'), false);
    assert.equal(manifest.files.harness.includes('.editorconfig'), false);
    assert.equal(manifest.files.harness.includes('.gitattributes'), false);
    assert.equal(manifest.files.hybrid['.gitignore']?.strategy, 'line-union');
    assert.equal(manifest.files.hybrid['.env.example']?.strategy, 'replace-if-unmodified');
    assert.equal(manifest.files.hybrid['.github/workflows/ci.yml']?.strategy, 'replace-if-unmodified');
    assert.equal(manifest.files.hybrid['.vscode/settings.json']?.strategy, 'json-deep-merge');
    assert.equal(manifest.files.hybrid['.vscode/extensions.json']?.strategy, 'json-array-union');
    assert.equal(manifest.files.hybrid['.editorconfig']?.strategy, 'line-union');
    assert.equal(manifest.files.hybrid['.gitattributes']?.strategy, 'line-union');
    assert.equal(manifest.files.hybrid['AGENTS.md']?.strategy, 'section-merge');
    assert.equal(manifest.files.hybrid['GEMINI.md']?.strategy, 'section-merge');
    assert.equal(manifest.files.hybrid['.vibe/config.json']?.projectKeys?.includes('audit'), true);
    assert.equal(manifest.files.hybrid['package.json']?.harnessKeys?.includes('scripts.test:ui'), false);
    assert.equal(manifest.files.hybrid['package.json']?.harnessKeys?.includes('scripts.vibe:*'), true);
    assert.equal(manifest.files.project.includes('src/**'), true);
    assert.equal(manifest.files.project.includes('scripts/**'), true);
    assert.equal(manifest.files.project.includes('test/**'), true);
    assert.equal(manifest.files.project.includes('.vibe/agent/project-map.json'), true);
    assert.equal(manifest.files.project.includes('.vibe/agent/sprint-api-contracts.json'), true);
    assert.equal(manifest.files.project.includes('.vibe/agent/project-decisions.jsonl'), true);
    assert.equal(manifest.files.project.includes('.vibe/archive/README.md'), true);
    assert.equal(manifest.migrations['1.1.0'], '.vibe/harness/migrations/1.1.0.mjs');
    assert.equal(manifest.migrations['1.7.0'], '.vibe/harness/migrations/1.7.0.mjs');
  });
});

describe('v1.7.0 migration', () => {
  it('redirects legacy harness-owned test:ui aliases without deleting product scripts', async () => {
    const root = await makeTempDir('vibe-migration-170-');
    const packagePath = path.join(root, 'package.json');
    const bridgePath = path.join(root, 'scripts', 'vibe-sync-bootstrap.mjs');
    const oldScriptPath = path.join(root, 'scripts', 'vibe-preflight.mjs');
    await writeJson(packagePath, {
      scripts: {
        test: 'vitest',
        'test:ui': 'node scripts/vibe-playwright-test.mjs',
      },
    });
    await mkdir(path.dirname(bridgePath), { recursive: true });
    await writeFile(bridgePath, 'bridge\n', 'utf8');
    await writeFile(oldScriptPath, 'old preflight\n', 'utf8');
    await writeJson(path.join(root, '.vibe', 'sync-hashes.json'), {
      files: {
        'scripts/vibe-sync-bootstrap.mjs': await computeFileHash(bridgePath),
        'scripts/vibe-preflight.mjs': await computeFileHash(oldScriptPath),
      },
    });

    await execFile(process.execPath, [path.join(process.cwd(), '.vibe', 'harness', 'migrations', '1.7.0.mjs'), root]);

    const pkg = JSON.parse(await readFile(packagePath, 'utf8')) as { scripts: Record<string, string> };
    assert.equal(pkg.scripts.test, 'vitest');
    assert.equal(pkg.scripts['test:ui'], 'npm run vibe:test-ui');
    assert.equal(await readFile(bridgePath, 'utf8'), 'bridge\n');
    await assert.rejects(readFile(oldScriptPath, 'utf8'), /ENOENT/);
  });
});
