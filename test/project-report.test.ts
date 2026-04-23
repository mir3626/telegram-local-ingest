import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, it } from 'node:test';

const tempDirs: string[] = [];

interface ProjectReportModule {
  runProjectReportCli: (
    argv: string[],
    options: {
      root: string;
      spawn?: (...args: unknown[]) => { on?: (event: string, listener: (error: Error) => void) => void; unref?: () => void };
      stdout?: { write: (value: string) => void };
      stderr?: { write: (value: string) => void };
      platform?: NodeJS.Platform;
    },
  ) => Promise<{ outPath: string; html: string }>;
  isMetaProject: (input: {
    config?: unknown;
    packageJson?: unknown;
    roadmapMd?: string;
  }) => boolean;
}

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

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await writeText(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function loadReportModule(): Promise<ProjectReportModule> {
  return import(pathToFileURL(path.resolve('scripts', 'vibe-project-report.mjs')).href) as Promise<ProjectReportModule>;
}

async function scaffoldReportProject(
  root: string,
  options: { meta?: boolean; packageName?: string } = {},
): Promise<void> {
  await writeJson(path.join(root, 'package.json'), {
    name: options.packageName ?? 'downstream-app',
    scripts: {
      test: 'node --test',
      build: 'tsc -p tsconfig.json',
    },
  });
  await writeJson(path.join(root, '.vibe', 'config.json'), {
    ...(options.meta ? { project: { kind: 'meta' } } : {}),
  });
  await writeJson(path.join(root, '.vibe', 'agent', 'sprint-status.json'), {
    schemaVersion: '0.1',
    project: {
      name: 'Demo Project',
      createdAt: '2026-04-01T00:00:00.000Z',
    },
    sprints: [
      {
        id: 'sprint-M12-report',
        name: 'Meta report',
        status: 'passed',
        completedAt: '2026-04-16T00:00:00.000Z',
        actualLoc: { added: 10, deleted: 1, net: 9, filesChanged: 1 },
      },
      {
        id: 'project-01-engine',
        name: 'Engine',
        status: 'passed',
        completedAt: '2026-04-16T01:00:00.000Z',
        actualLoc: { added: 20, deleted: 0, net: 20, filesChanged: 2 },
      },
    ],
    verificationCommands: [],
    pendingRisks: [],
    lastSprintScope: [],
    lastSprintScopeGlob: [],
    sprintsSinceLastAudit: 0,
    stateUpdatedAt: '2026-04-16T01:00:00.000Z',
    handoff: {
      currentSprintId: 'idle',
      lastActionSummary: 'done',
      orchestratorContextBudget: 'low',
      preferencesActive: [],
    },
  });
  await writeJson(path.join(root, '.vibe', 'agent', 'iteration-history.json'), {
    currentIteration: null,
    iterations: [],
  });
  await writeText(
    path.join(root, 'docs', 'context', 'product.md'),
    ['# Demo Project', '', 'A compact planning harness.', '', 'Platform: CLI'].join('\n'),
  );
  await writeText(
    path.join(root, 'docs', 'plans', 'sprint-roadmap.md'),
    [
      '# Demo Roadmap',
      '',
      '## Sprint M12',
      '- **id**: `sprint-M12-report`',
      '- **Goal**: meta report goal',
      '',
      '## Sprint Project 01',
      '- **id**: `project-01-engine`',
      '- **Goal**: project engine goal',
    ].join('\n'),
  );
  await writeText(
    path.join(root, '.vibe', 'agent', 'session-log.md'),
    [
      '# Session Log',
      '',
      '## Entries',
      '- 2026-04-16T00:00:00.000Z [decision] keep reports local',
      '- 2026-04-16T00:05:00.000Z [decision][planner-skip] skip planner for trivial report copy update',
      '- 2026-04-16T00:10:00.000Z [failure] this is a deliberately long verification failure entry that should render inside collapsed details by default because it is longer than the content threshold used by the report renderer and needs the expansion controls to expose the full text',
    ].join('\n'),
  );
}

describe('project report', () => {
  it('renders placeholders and all expected sections with empty state files', async () => {
    const root = await makeTempDir('project-report-empty-');
    const { runProjectReportCli } = await loadReportModule();

    await writeJson(path.join(root, '.vibe', 'agent', 'sprint-status.json'), {
      schemaVersion: '0.1',
      project: { name: 'Empty Project', createdAt: '2026-04-01T00:00:00.000Z' },
      sprints: [],
      verificationCommands: [],
      pendingRisks: [],
      lastSprintScope: [],
      lastSprintScopeGlob: [],
      sprintsSinceLastAudit: 0,
      stateUpdatedAt: '2026-04-01T00:00:00.000Z',
    });

    const result = await runProjectReportCli(['--no-open'], {
      root,
      stdout: { write: () => undefined },
    });

    for (const section of ['iterations', 'sprints', 'decisions', 'verification', 'next-steps']) {
      assert.match(result.html, new RegExp(`data-section="${section}"`));
    }
    assert.equal(result.html.includes('data-section="milestones"'), false);
    assert.match(result.html, /No iterations recorded yet/);
    assert.match(result.html, /<nav class="site-nav"/);
    assert.match(result.html, /<div class="outer-frame">/);
    assert.match(result.html, /<main id="content" class="container">/);
  });

  it('excludes sprint-M cards for meta projects', async () => {
    const root = await makeTempDir('project-report-meta-');
    const { runProjectReportCli } = await loadReportModule();
    await scaffoldReportProject(root, { meta: true });

    const result = await runProjectReportCli(['--no-open'], {
      root,
      stdout: { write: () => undefined },
    });

    assert.equal(result.html.includes('data-sprint-id="sprint-M12-report"'), false);
    assert.equal(result.html.includes('data-sprint-id="project-01-engine"'), true);
  });

  it('shows all sprint cards for downstream projects', async () => {
    const root = await makeTempDir('project-report-downstream-');
    const { runProjectReportCli, isMetaProject } = await loadReportModule();
    await scaffoldReportProject(root, { packageName: 'arbitrary-product' });

    const result = await runProjectReportCli(['--no-open'], {
      root,
      stdout: { write: () => undefined },
    });

    assert.equal(isMetaProject({ packageJson: { name: 'arbitrary-product' }, roadmapMd: '# Demo' }), false);
    assert.equal(result.html.includes('data-sprint-id="sprint-M12-report"'), true);
    assert.equal(result.html.includes('data-sprint-id="project-01-engine"'), true);
  });

  it('--no-open skips browser spawn', async () => {
    const root = await makeTempDir('project-report-no-open-');
    const { runProjectReportCli } = await loadReportModule();
    let spawnCount = 0;
    await scaffoldReportProject(root);

    await runProjectReportCli(['--no-open'], {
      root,
      spawn: () => {
        spawnCount += 1;
        return {};
      },
      stdout: { write: () => undefined },
    });

    assert.equal(spawnCount, 0);
  });

  it('browser open errors are warnings and do not fail report generation', async () => {
    const root = await makeTempDir('project-report-open-error-');
    const { runProjectReportCli } = await loadReportModule();
    const child = new EventEmitter() as EventEmitter & { unref: () => void };
    let stderr = '';
    let stdout = '';
    let unrefCalled = false;
    await scaffoldReportProject(root);
    child.unref = () => {
      unrefCalled = true;
    };

    await runProjectReportCli([], {
      root,
      platform: 'linux',
      spawn: () => child,
      stdout: { write: (value) => { stdout += value; } },
      stderr: { write: (value) => { stderr += value; } },
    });
    child.emit('error', new Error('spawn xdg-open EACCES'));

    assert.equal(unrefCalled, true);
    assert.match(stdout, /project-report\.html/);
    assert.match(stderr, /Warning: could not open project report: spawn xdg-open EACCES/);
  });

  it('writes inline report HTML with only optional Google Font links', async () => {
    const root = await makeTempDir('project-report-self-contained-');
    const { runProjectReportCli } = await loadReportModule();
    await scaffoldReportProject(root);

    const { outPath } = await runProjectReportCli(['--no-open'], {
      root,
      stdout: { write: () => undefined },
    });
    const html = await readFile(outPath, 'utf8');

    assert.equal(/<script[^>]+src=["']http/i.test(html), false);
    const externalLinks = [...html.matchAll(/<link[^>]+href=["'](https?:\/\/[^"']+)/gi)].map((match) =>
      String(match[1]),
    );
    assert.equal(
      externalLinks.every(
        (href) => href.startsWith('https://fonts.googleapis.com') || href.startsWith('https://fonts.gstatic.com'),
      ),
      true,
    );
  });

  it('renders key decision filters and collapsed long entries by default', async () => {
    const root = await makeTempDir('project-report-decisions-');
    const { runProjectReportCli } = await loadReportModule();
    await scaffoldReportProject(root);

    const result = await runProjectReportCli(['--no-open'], {
      root,
      stdout: { write: () => undefined },
    });

    assert.match(result.html, /data-active-tags="decision failure sprint-complete user-directive audit planner-skip drift-observed"/);
    assert.match(result.html, /data-filter="all" aria-pressed="true"/);
    assert.match(result.html, /data-filter="planner-skip" aria-pressed="false"/);
    assert.match(result.html, /data-filter="failure" aria-pressed="false"/);
    assert.match(result.html, /data-decision-action="expand"/);
    assert.match(result.html, /data-decision-action="collapse"/);
    assert.match(result.html, /<details><summary>this is a deliberately long verification failure entry/);
    assert.equal(result.html.includes('<details open'), false);
  });

  it('renders iOS liquid-glass light theme with iridescent brand orb', async () => {
    const root = await makeTempDir('project-report-style-');
    const { runProjectReportCli } = await loadReportModule();
    await scaffoldReportProject(root);

    const result = await runProjectReportCli(['--no-open'], {
      root,
      stdout: { write: () => undefined },
    });

    assert.equal(/<br>/i.test(result.html), false);
    assert.match(result.html, /color-scheme:light/);
    assert.match(result.html, /backdrop-filter:blur/);
    assert.match(result.html, /#007aff/);
    assert.match(result.html, /class="orb"/);
    assert.match(result.html, /orb-core/);
    assert.match(result.html, /@keyframes orb-spin/);
    assert.match(result.html, /@media print/);
  });
});
