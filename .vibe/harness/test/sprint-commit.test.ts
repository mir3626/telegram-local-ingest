import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, it } from 'node:test';
import { extendLastSprintScope } from '../src/lib/sprint-status.js';

const execFile = promisify(execFileCallback);
const tempDirs: string[] = [];
const sprintCommitPath = path.resolve('.vibe', 'harness', 'scripts', 'vibe-sprint-commit.mjs');
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

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
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
  await execFile('git', ['add', '.'], { cwd: root });
  await execFile('git', ['commit', '-m', 'init'], {
    cwd: root,
    env: { ...process.env, ...gitEnv },
  });
}

async function scaffoldRepo(
  root: string,
  options: {
    sprintIds?: string[];
    locExtensions?: string[];
    pendingRisks?: Array<Record<string, unknown>>;
    includeRoadmap?: boolean;
    includePrompt?: boolean;
  } = {},
): Promise<void> {
  const sprintIds = options.sprintIds ?? ['test-sprint', 'next-sprint'];
  const includeRoadmap = options.includeRoadmap ?? false;
  const includePrompt = options.includePrompt ?? false;
  const config: Record<string, unknown> = {
    harnessVersion: '1.1.1',
    harnessVersionInstalled: '1.1.1',
    sprintRoles: {},
    sprint: {
      unit: 'feature',
      subAgentPerRole: true,
      freshContextPerSprint: true,
    },
    providers: {},
    audit: {
      everyN: 99,
    },
  };

  if (options.locExtensions) {
    config.loc = { extensions: options.locExtensions };
  }

  await writeJson(path.join(root, '.vibe', 'config.json'), config);
  await writeJson(path.join(root, '.vibe', 'agent', 'sprint-status.json'), {
    schemaVersion: '0.1',
    project: {
      name: 'test-project',
      createdAt: '2026-04-01T00:00:00.000Z',
    },
    sprints: [],
    verificationCommands: [],
    pendingRisks: options.pendingRisks ?? [],
    lastSprintScope: [],
    lastSprintScopeGlob: [],
    sprintsSinceLastAudit: 0,
    stateUpdatedAt: '2026-04-01T00:00:00.000Z',
    handoff: {
      currentSprintId: 'idle',
      lastActionSummary: 'ready',
      orchestratorContextBudget: 'low',
      preferencesActive: [],
      handoffDocPath: '.vibe/agent/handoff.md',
      updatedAt: '2026-04-01T00:00:00.000Z',
    },
  });
  await writeText(
    path.join(root, '.vibe', 'agent', 'handoff.md'),
    [
      '# Handoff',
      '',
      '## 2. Status: IDLE',
      '',
      '## 3. Sprint History',
      '',
      '| Sprint | Summary | Status |',
      '|---|---|---|',
      '',
    ].join('\n'),
  );
  await writeText(path.join(root, '.vibe', 'agent', 'session-log.md'), '# Session Log\n\n## Entries\n');
  await writeJson(path.join(root, '.vibe', 'agent', 'project-map.json'), {
    schemaVersion: '0.1',
    updatedAt: '2026-04-01T00:00:00.000Z',
    modules: {},
    activePlatformRules: [],
  });
  await writeJson(path.join(root, '.vibe', 'agent', 'sprint-api-contracts.json'), {
    schemaVersion: '0.1',
    updatedAt: '2026-04-01T00:00:00.000Z',
    contracts: {},
  });
  await writeText(path.join(root, '.vibe', 'agent', 'project-decisions.jsonl'), '');

  if (includeRoadmap) {
    const roadmapLines = [
      '# Roadmap',
      '',
      '<!-- BEGIN:VIBE:CURRENT-SPRINT -->',
      '> **Current**: idle (not started, started 2026-04-01)',
      '> **Completed**: \u2014',
      `> **Pending**: ${sprintIds.join(', ')}`,
      '<!-- END:VIBE:CURRENT-SPRINT -->',
      '',
    ];
    sprintIds.forEach((sprintId, index) => {
      roadmapLines.push(`## Sprint M${index + 1}`);
      roadmapLines.push(`- **id**: \`${sprintId}\``);
      roadmapLines.push('');
    });
    await writeText(path.join(root, 'docs', 'plans', 'sprint-roadmap.md'), roadmapLines.join('\n'));
  }

  if (includePrompt) {
    await writeText(
      path.join(root, 'docs', 'prompts', `${sprintIds[0]}-plan.md`),
      `# ${sprintIds[0]}\n`,
    );
  }

  await initGitRepo(root);
}

async function runSprintCommit(
  root: string,
  args: string[],
  extraEnv: Record<string, string> = {},
) {
  return execFile('node', [sprintCommitPath, ...args], {
    cwd: root,
    env: { ...process.env, ...gitEnv, ...extraEnv },
  });
}

async function loadSprintCompleteHelpers(): Promise<{
  parseRoadmapSprintIds: (roadmapMd: string) => string[];
  computeCurrentPointerBlock: (
    roadmapMd: string,
    sessionLogMd: string,
    lastSprintId: string,
    startedDateIso?: string,
  ) => string;
}> {
  return import(pathToFileURL(path.resolve('.vibe', 'harness', 'scripts', 'vibe-sprint-complete.mjs')).href) as Promise<{
    parseRoadmapSprintIds: (roadmapMd: string) => string[];
    computeCurrentPointerBlock: (
      roadmapMd: string,
      sessionLogMd: string,
      lastSprintId: string,
      startedDateIso?: string,
    ) => string;
  }>;
}

async function loadSprintCommitHelpers(): Promise<{
  collectArchivedPromptFiles: (sprintId: string) => string[];
  inlineExtendLastSprintScope: (
    statusPath: string,
    mergedScope: string[],
    mergedGlobs: string[],
  ) => void;
}> {
  return import(pathToFileURL(path.resolve('.vibe', 'harness', 'scripts', 'vibe-sprint-commit.mjs')).href) as Promise<{
    collectArchivedPromptFiles: (sprintId: string) => string[];
    inlineExtendLastSprintScope: (
      statusPath: string,
      mergedScope: string[],
      mergedGlobs: string[],
    ) => void;
  }>;
}

describe('collectArchivedPromptFiles', () => {
  it('includes suffix-less and suffixed archived prompt files', async () => {
    const { collectArchivedPromptFiles } = await loadSprintCommitHelpers();
    const root = await makeTempDir('sprint-commit-archive-basic-');
    await writeText(path.join(root, '.vibe', 'archive', 'prompts', 'sprint-example.md'), '# base\n');
    await writeText(path.join(root, '.vibe', 'archive', 'prompts', 'sprint-example-plan.md'), '# plan\n');
    await writeText(path.join(root, '.vibe', 'archive', 'prompts', 'sprint-example.txt'), 'ignore\n');
    const previousCwd = process.cwd();

    try {
      process.chdir(root);
      assert.deepEqual(collectArchivedPromptFiles('sprint-example').sort(), [
        '.vibe/archive/prompts/sprint-example-plan.md',
        '.vibe/archive/prompts/sprint-example.md',
      ].sort());
    } finally {
      process.chdir(previousCwd);
    }
  });

  it('keeps dash-delimited prefix collision protection', async () => {
    const { collectArchivedPromptFiles } = await loadSprintCommitHelpers();
    const root = await makeTempDir('sprint-commit-archive-collision-');
    await writeText(path.join(root, '.vibe', 'archive', 'prompts', 'sprint-M.md'), '# base\n');
    await writeText(path.join(root, '.vibe', 'archive', 'prompts', 'sprint-M1.md'), '# collision\n');
    await writeText(path.join(root, '.vibe', 'archive', 'prompts', 'sprint-M-audit.md'), '# audit\n');
    const previousCwd = process.cwd();

    try {
      process.chdir(root);
      assert.deepEqual(collectArchivedPromptFiles('sprint-M').sort(), [
        '.vibe/archive/prompts/sprint-M-audit.md',
        '.vibe/archive/prompts/sprint-M.md',
      ].sort());
    } finally {
      process.chdir(previousCwd);
    }
  });
});

describe('computeCurrentPointerBlock', () => {
  it('parses delayed roadmap id bullets and warns when ids are missing', async () => {
    const { parseRoadmapSprintIds } = await loadSprintCompleteHelpers();
    const originalWrite = process.stderr.write;
    const chunks: string[] = [];
    process.stderr.write = ((chunk: string | Uint8Array) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;

    try {
      const delayedIdRoadmap = [
        '# Roadmap\n\n## Sprint M1 - Schema foundation (state files)\n\n- **goal**: create schema state files',
        '- **outputs**:\n  - status json\n  - handoff markdown\n\nnotes before id',
        '- **id**: `sprint-M1-schema-foundation`',
      ].join('\n');

      assert.deepEqual(parseRoadmapSprintIds(delayedIdRoadmap), ['sprint-M1-schema-foundation']);
      assert.equal(chunks.join(''), '');
      assert.deepEqual(parseRoadmapSprintIds('## Sprint M1\n\n- **goal**: missing id'), []);
      assert.match(chunks.join(''), /warning=roadmap-id-missing headingLine=1/);
    } finally {
      process.stderr.write = originalWrite;
    }
  });

  it('computes current, completed, and pending lists from roadmap and session log', async () => {
    const { computeCurrentPointerBlock } = await loadSprintCompleteHelpers();
    const roadmap = [
      '# Roadmap',
      '',
      '<!-- BEGIN:VIBE:CURRENT-SPRINT -->',
      '> stale',
      '<!-- END:VIBE:CURRENT-SPRINT -->',
      '',
      '## Sprint M1',
      '- **id**: `sprint-M1`',
      '',
      '## Sprint M2',
      '- **id**: `sprint-M2`',
      '',
      '## Sprint M3',
      '- **id**: `sprint-M3`',
      '',
    ].join('\n');
    const sessionLog = [
      '# Session Log',
      '',
      '## Entries',
      '- 2026-04-16T00:00:00.000Z [sprint-complete] sprint-M2 -> passed.',
      '- 2026-04-15T00:00:00.000Z [sprint-complete] sprint-M1 -> passed.',
      '',
    ].join('\n');

    const block = computeCurrentPointerBlock(roadmap, sessionLog, 'sprint-M2', '2026-04-16');

    assert.equal(
      block,
      [
        '<!-- BEGIN:VIBE:CURRENT-SPRINT -->',
        '> **Current**: sprint-M3 (not started, started 2026-04-16)',
        '> **Completed**: sprint-M2, sprint-M1',
        '> **Pending**: \u2014',
        '<!-- END:VIBE:CURRENT-SPRINT -->',
      ].join('\n'),
    );
  });
});

describe('vibe-sprint-commit', () => {
  it('supports dry-run and includes detected scope in output', async () => {
    const root = await makeTempDir('sprint-commit-dry-run-');
    await scaffoldRepo(root);
    await writeText(path.join(root, 'src', 'foo.ts'), 'export const foo = 1;\n');
    await execFile('git', ['add', 'src/foo.ts'], { cwd: root });

    const { stdout } = await runSprintCommit(root, [
      'test-sprint',
      'passed',
      '--scope',
      'src/foo.ts',
      '--dry-run',
    ]);

    assert.match(stdout, /would commit:/);
    assert.match(stdout, /src\/foo\.ts/);
  });

  it('is idempotent when re-run after a successful commit', async () => {
    const root = await makeTempDir('sprint-commit-idempotent-');
    await scaffoldRepo(root);
    await writeText(path.join(root, 'src', 'foo.ts'), 'export const foo = 1;\n');
    await execFile('git', ['add', 'src/foo.ts'], { cwd: root });

    await runSprintCommit(root, ['test-sprint', 'passed', '--scope', 'src/foo.ts', '--no-verify-gpg']);
    const { stdout } = await runSprintCommit(root, [
      'test-sprint',
      'passed',
      '--scope',
      'src/foo.ts',
      '--no-verify-gpg',
    ]);

    assert.match(stdout, /nothing to commit \(already closed\?\)/);
  });

  it('creates an annotated harness tag when harnessVersion increases', async () => {
    const root = await makeTempDir('sprint-commit-tag-create-');
    await scaffoldRepo(root);
    await writeJson(path.join(root, '.vibe', 'config.json'), {
      harnessVersion: '1.2.0',
      harnessVersionInstalled: '1.1.1',
      sprintRoles: {},
      sprint: {
        unit: 'feature',
        subAgentPerRole: true,
        freshContextPerSprint: true,
      },
      providers: {},
      audit: {
        everyN: 99,
      },
    });

    const { stdout } = await runSprintCommit(root, [
      'test-sprint',
      'passed',
      '--scope',
      '.vibe/config.json',
      '--no-verify-gpg',
    ]);
    const { stdout: tags } = await execFile('git', ['tag', '-l', 'v1.2.0'], { cwd: root });

    assert.match(stdout, /harness-tag: created v1\.2\.0 \(prev=1\.1\.1\)/);
    assert.equal(tags.trim(), 'v1.2.0');
  });

  it('does not tag when harnessVersion is unchanged', async () => {
    const root = await makeTempDir('sprint-commit-tag-unchanged-');
    await scaffoldRepo(root);
    await writeText(path.join(root, 'src', 'foo.ts'), 'export const foo = 1;\n');
    await execFile('git', ['add', 'src/foo.ts'], { cwd: root });

    const { stdout } = await runSprintCommit(root, [
      'test-sprint',
      'passed',
      '--scope',
      'src/foo.ts',
      '--no-verify-gpg',
    ]);
    const { stdout: tags } = await execFile('git', ['tag', '-l', 'v1.1.1'], { cwd: root });

    assert.match(stdout, /no upward version delta: 1\.1\.1 -> 1\.1\.1/);
    assert.equal(tags.trim(), '');
  });

  it('skips harness tag creation when the candidate tag already exists', async () => {
    const root = await makeTempDir('sprint-commit-tag-existing-');
    await scaffoldRepo(root);
    await execFile('git', ['tag', '-a', 'v1.2.0', '-m', 'existing tag'], {
      cwd: root,
      env: { ...process.env, ...gitEnv },
    });
    await writeJson(path.join(root, '.vibe', 'config.json'), {
      harnessVersion: '1.2.0',
      harnessVersionInstalled: '1.1.1',
      sprintRoles: {},
      sprint: {
        unit: 'feature',
        subAgentPerRole: true,
        freshContextPerSprint: true,
      },
      providers: {},
      audit: {
        everyN: 99,
      },
    });

    const { stdout } = await runSprintCommit(root, [
      'test-sprint',
      'passed',
      '--scope',
      '.vibe/config.json',
      '--no-verify-gpg',
    ]);
    const { stdout: tags } = await execFile('git', ['tag', '-l', 'v1.2.0'], { cwd: root });

    assert.match(stdout, /tag v1\.2\.0 already exists/);
    assert.equal(tags.trim(), 'v1.2.0');
  });

  it('blocks commit when an open pending risk targets the sprint', async () => {
    const root = await makeTempDir('sprint-commit-risk-');
    await scaffoldRepo(root, {
      pendingRisks: [
        {
          id: 'risk-1',
          raisedBy: 'test',
          targetSprint: 'test-sprint',
          text: 'resolve me first',
          status: 'open',
          createdAt: '2026-04-15T00:00:00.000Z',
        },
      ],
    });
    await writeText(path.join(root, 'src', 'foo.ts'), 'export const foo = 1;\n');
    await execFile('git', ['add', 'src/foo.ts'], { cwd: root });
    const before = await readFile(path.join(root, '.vibe', 'agent', 'sprint-status.json'), 'utf8');

    try {
      await runSprintCommit(root, ['test-sprint', 'passed', '--scope', 'src/foo.ts']);
      assert.fail('expected pending risk to block commit');
    } catch (error) {
      const stderr =
        typeof error === 'object' &&
        error !== null &&
        'stderr' in error &&
        typeof error.stderr === 'string'
          ? error.stderr
          : '';
      assert.match(stderr, /risk-1/);
    }

    const after = await readFile(path.join(root, '.vibe', 'agent', 'sprint-status.json'), 'utf8');
    assert.equal(after, before);
  });

  it('filters LOC totals to configured code extensions while counting all changed files', async () => {
    const root = await makeTempDir('sprint-commit-loc-');
    await scaffoldRepo(root, { locExtensions: ['.ts'] });
    await writeText(path.join(root, 'src', 'foo.ts'), ['a', 'b', 'c', 'd', 'e'].join('\n'));
    await writeText(
      path.join(root, 'docs', 'foo.md'),
      Array.from({ length: 10 }, (_, index) => `${index}`).join('\n'),
    );
    await execFile('git', ['add', 'src/foo.ts', 'docs/foo.md'], { cwd: root });

    await runSprintCommit(root, ['test-sprint', 'passed', '--scope', 'src/foo.ts', '--no-verify-gpg']);
    const { stdout: body } = await execFile('git', ['log', '-1', '--format=%B'], { cwd: root });

    assert.match(body, /LOC \+5\/-0 \(net \+5\)/);
    assert.match(body, /across \d+ file\(s\)\./);
  });

  it('extends lastSprintScope across sequential sprint commits without rewriting prior entries', async () => {
    const root = await makeTempDir('sprint-commit-scope-');
    await scaffoldRepo(root, {
      sprintIds: ['sprint-a', 'sprint-b'],
    });
    await writeText(path.join(root, 'src', 'a.ts'), 'export const a = 1;\n');
    await execFile('git', ['add', 'src/a.ts'], { cwd: root });
    await runSprintCommit(root, ['sprint-a', 'passed', '--scope', 'src/a.ts', '--no-verify-gpg']);

    await writeText(path.join(root, 'src', 'b.ts'), 'export const b = 2;\n');
    await execFile('git', ['add', 'src/b.ts'], { cwd: root });
    await runSprintCommit(root, ['sprint-b', 'passed', '--scope', 'src/b.ts', '--no-verify-gpg']);

    const status = JSON.parse(
      await readFile(path.join(root, '.vibe', 'agent', 'sprint-status.json'), 'utf8'),
    ) as { lastSprintScope: string[]; lastSprintScopeGlob: string[] };

    assert.deepEqual(status.lastSprintScope, ['src/a.ts', 'src/b.ts']);
    assert.deepEqual(status.lastSprintScopeGlob, ['src/a.ts', 'src/b.ts']);
  });

  it('keeps inline scope merge logic in lockstep with the library helper', async () => {
    const { inlineExtendLastSprintScope } = await loadSprintCommitHelpers();
    const rootLib = await makeTempDir('sprint-commit-drift-lib-');
    const rootInline = await makeTempDir('sprint-commit-drift-inline-');
    const fixtureStatus = {
      schemaVersion: '0.1',
      project: {
        name: 'test-project',
        createdAt: '2026-04-01T00:00:00.000Z',
      },
      sprints: [],
      verificationCommands: [],
      pendingRisks: [],
      lastSprintScope: ['src/a.ts', 'src/b.ts'],
      lastSprintScopeGlob: ['src/a.ts', 'src/b.ts'],
      sprintsSinceLastAudit: 0,
      stateUpdatedAt: '2026-04-01T00:00:00.000Z',
    };
    const incoming = ['src/b.ts', 'src/c.ts'];

    await writeJson(path.join(rootLib, '.vibe', 'agent', 'sprint-status.json'), fixtureStatus);
    await writeJson(path.join(rootInline, '.vibe', 'agent', 'sprint-status.json'), fixtureStatus);

    const libResult = await extendLastSprintScope(incoming, incoming, rootLib);
    inlineExtendLastSprintScope(
      path.join(rootInline, '.vibe', 'agent', 'sprint-status.json'),
      incoming,
      incoming,
    );

    const inlineStatus = JSON.parse(
      await readFile(path.join(rootInline, '.vibe', 'agent', 'sprint-status.json'), 'utf8'),
    ) as { lastSprintScope: string[]; lastSprintScopeGlob: string[] };

    assert.deepEqual(
      {
        lastSprintScope: inlineStatus.lastSprintScope,
        lastSprintScopeGlob: inlineStatus.lastSprintScopeGlob,
      },
      libResult,
      'drift detected — update lib and commit script in lockstep',
    );
  });
});
