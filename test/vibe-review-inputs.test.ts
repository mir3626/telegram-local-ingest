import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, it } from 'node:test';
import {
  collectPendingRestorationDecisions,
  collectReviewInputs,
  detectOptInGaps,
} from '../src/lib/review.js';

const execFile = promisify(execFileCallback);
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

async function writeText(filePath: string, value: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, value, 'utf8');
}

async function initGitRepo(root: string): Promise<void> {
  await execFile('git', ['init'], { cwd: root, env: process.env });
  await execFile('git', ['config', 'user.name', 'Test User'], { cwd: root });
  await execFile('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
  await execFile('git', ['add', '.'], { cwd: root });
  await execFile('git', ['commit', '-m', 'review baseline'], { cwd: root, env: process.env });
}

async function scaffoldRepo(root: string): Promise<void> {
  await writeJson(path.join(root, '.vibe', 'config.json'), {
    review: {
      recentEntries: 2,
    },
    bundle: {
      enabled: false,
    },
    browserSmoke: {
      enabled: false,
    },
  });
  await writeJson(path.join(root, '.vibe', 'agent', 'sprint-status.json'), {
    schemaVersion: '0.1',
    project: {
      name: 'review-project',
      createdAt: '2026-04-01T00:00:00.000Z',
    },
    sprints: [
      {
        id: 'sprint-M1',
        name: 'sprint-M1',
        status: 'passed',
        completedAt: '2026-04-10T00:00:00.000Z',
      },
    ],
    verificationCommands: [],
    pendingRisks: [
      {
        id: 'audit-after-sprint-M8-audit',
        raisedBy: 'vibe-sprint-complete',
        targetSprint: '*',
        text: 'audit due',
        status: 'open',
        createdAt: '2026-04-16T00:00:00.000Z',
      },
      {
        id: 'resolved-risk',
        raisedBy: 'test',
        targetSprint: '*',
        text: 'done',
        status: 'resolved',
        createdAt: '2026-04-15T00:00:00.000Z',
        resolvedAt: '2026-04-15T01:00:00.000Z',
      },
    ],
    lastSprintScope: [],
    lastSprintScopeGlob: [],
    sprintsSinceLastAudit: 5,
    stateUpdatedAt: '2026-04-16T00:00:00.000Z',
  });
  await writeText(path.join(root, '.vibe', 'agent', 'handoff.md'), '# handoff\nfull handoff\n');
  await writeText(
    path.join(root, '.vibe', 'agent', 'session-log.md'),
    [
      '# Session Log',
      '',
      '## Entries',
      '- 2026-04-16T00:00:00.000Z [decision] first',
      '- 2026-04-15T00:00:00.000Z [decision] second',
      '- 2026-04-14T00:00:00.000Z [decision] third',
      '',
      '## Archived (older)',
      '- 2026-04-01T00:00:00.000Z [decision] archived',
    ].join('\n'),
  );
  await writeText(
    path.join(root, '.vibe', 'agent', 'project-decisions.jsonl'),
    [
      JSON.stringify({
        sprintId: 'sprint-M1',
        decision: 'keep-audit',
        affectedFiles: ['scripts/vibe-sprint-complete.mjs'],
        tag: 'decision',
        text: 'keep audit ids explicit',
        createdAt: '2026-04-16T00:00:00.000Z',
      }),
    ].join('\n'),
  );
  await writeText(
    path.join(root, 'docs', 'context', 'product.md'),
    '# Product\n\nPlatform: web dashboard\n',
  );
  await writeText(
    path.join(root, 'docs', 'context', 'harness-gaps.md'),
    [
      '## Entries',
      '| id | symptom | covered_by | status |',
      '|---|---|---|---|',
      '| gap-a | example | hook | open |',
      '| gap-b | example | hook | covered |',
    ].join('\n'),
  );
  await writeText(path.join(root, 'docs', 'reports', 'review-1-2026-04-15.md'), '# review\n');
  await initGitRepo(root);
  await writeText(path.join(root, 'README.md'), 'post review change\n');
  await execFile('git', ['add', 'README.md'], { cwd: root });
  await execFile('git', ['commit', '-m', 'post review change'], { cwd: root, env: process.env });
}

describe('review inputs', () => {
  it('collectReviewInputs loads handoff, session log, decisions, pending risks, and limits recent entries', async () => {
    const root = await makeTempDir('review-inputs-');
    await scaffoldRepo(root);

    const inputs = await collectReviewInputs(root);

    assert.match(inputs.handoff, /full handoff/);
    assert.match(inputs.sessionLog, /Session Log/);
    assert.equal(inputs.recentSessionEntries.length, 2);
    assert.equal(inputs.recentSessionEntries[0]?.includes('first'), true);
    assert.equal(inputs.openPendingRisks.length, 1);
    assert.equal(inputs.openPendingRisks[0]?.id, 'audit-after-sprint-M8-audit');
    assert.equal(inputs.decisions.length, 1);
    assert.equal(inputs.decisions[0]?.decision, 'keep-audit');
    assert.equal(inputs.passedSprintCount, 1);
    assert.equal(inputs.openHarnessGapCount, 1);
    assert.deepEqual(inputs.pendingRestorations, []);
    assert.deepEqual(inputs.wiringDriftFindings, []);
    assert.equal(inputs.gitLogMode, 'since-last-review');
    assert.equal(inputs.gitLog.length >= 1, true);
  });

  it('collectPendingRestorationDecisions parses pending entries from audit ledgers', async () => {
    const root = await makeTempDir('review-restorations-');
    await writeText(
      path.join(root, '.vibe', 'audit', 'iter-3', 'rules-deleted.md'),
      [
        '# ledger',
        '',
        '## old-rule — Old rule title',
        '',
        '- tier: B',
        '- reason: "incident_count=0"',
        '- restoration_decision: pending',
        '',
        '---',
        '',
        '## invalid-tier — Invalid tier title',
        '',
        '- tier: Z',
        "- reason: 'bad tier'",
        '- restoration_decision: pending',
      ].join('\n'),
    );

    const restorations = await collectPendingRestorationDecisions(root);

    assert.equal(restorations.length, 2);
    assert.deepEqual(restorations[0], {
      sourceFile: '.vibe/audit/iter-3/rules-deleted.md',
      ruleSlug: 'old-rule',
      title: 'Old rule title',
      tier: 'B',
      reason: 'incident_count=0',
    });
    assert.equal(restorations[1]?.tier, 'C');
    assert.equal(restorations[1]?.reason, '[tier-fallback] bad tier');
  });

  it('suppresses pending entries marked delete-confirmed in a post-decision section', async () => {
    const root = await makeTempDir('review-restorations-delete-confirmed-');
    await writeText(
      path.join(root, '.vibe', 'audit', 'iter-3', 'rules-deleted.md'),
      [
        '# ledger',
        '',
        '## old-rule - Old rule title',
        '',
        '- tier: B',
        '- reason: "incident_count=0"',
        '- restoration_decision: pending',
        '',
        '## invalid-tier - Invalid tier title',
        '',
        '- tier: Z',
        "- reason: 'bad tier'",
        '- restoration_decision: pending',
        '',
        '## iter-4 decision (2026-04-19)',
        '',
        '- `old-rule` - reviewed and marked **delete-confirmed**.',
      ].join('\n'),
    );

    const restorations = await collectPendingRestorationDecisions(root);

    assert.equal(restorations.length, 1);
    assert.equal(restorations[0]?.ruleSlug, 'invalid-tier');
  });

  it('collectPendingRestorationDecisions returns an empty list when no ledgers exist', async () => {
    const root = await makeTempDir('review-restorations-empty-');

    const restorations = await collectPendingRestorationDecisions(root);

    assert.deepEqual(restorations, []);
  });

  it('detectOptInGaps returns bundle and browser smoke friction entries for web projects without a recent opt-in decision', () => {
    const issues = detectOptInGaps(
      {
        bundle: { enabled: false },
        browserSmoke: { enabled: false },
      },
      {
        productText: 'Platform: web application',
        sessionLogRecent: ['- 2026-04-16T00:00:00.000Z [decision] unrelated'],
      },
    );

    assert.equal(issues.length, 2);
    assert.equal(issues[0]?.proposal, 'frontend 프로젝트인데 bundle-size gate 가 opt-in 되지 않음');
    assert.equal(
      issues[1]?.proposal,
      'frontend 프로젝트인데 browser smoke gate 가 opt-in 되지 않음',
    );
  });

  it('detectOptInGaps skips friction entries when a recent phase3 utility opt-in decision exists', () => {
    const issues = detectOptInGaps(
      {
        bundle: { enabled: false },
        browserSmoke: { enabled: false },
      },
      {
        productText: 'Platform: browser app',
        sessionLogRecent: [
          '- 2026-04-16T00:00:00.000Z [decision][phase3-utility-opt-in] bundle=false browserSmoke=false rationale=intentional',
        ],
      },
    );

    assert.deepEqual(issues, []);
  });

  it('detectOptInGaps skips non-web platforms', () => {
    const issues = detectOptInGaps(
      {
        bundle: { enabled: false },
        browserSmoke: { enabled: false },
      },
      {
        productText: 'Platform: backend worker',
        sessionLogRecent: [],
      },
    );

    assert.deepEqual(issues, []);
  });

  it('collectReviewInputs includes productFetcherPaths for Next.js app/api routes', async () => {
    const root = await makeTempDir('review-fetcher-paths-');
    await scaffoldRepo(root);
    await writeText(path.join(root, 'app', 'api', 'foo', 'route.ts'), 'export const GET = null;\n');
    await writeText(path.join(root, 'app', 'api', 'bar', 'baz', 'route.ts'), 'export const GET = null;\n');
    await writeText(path.join(root, 'app', 'api', 'ignored', 'page.ts'), 'export default null;\n');
    await writeText(path.join(root, 'app', 'components', 'other.ts'), 'export default null;\n');
    await writeText(path.join(root, 'src', 'app', 'api', 'qux', 'route.ts'), 'export const GET = null;\n');
    await writeText(path.join(root, '.next', 'cache', 'route.ts'), 'export const GET = null;\n');
    await writeText(path.join(root, 'node_modules', 'whatever', 'route.ts'), 'export const GET = null;\n');

    const result = await collectReviewInputs(root);

    assert.deepEqual(result.productFetcherPaths, [
      'app/api/bar/baz/route.ts',
      'app/api/foo/route.ts',
      'src/app/api/qux/route.ts',
    ]);
  });

  it('collectReviewInputs flags unwired harness scripts and missing sync manifest entries', async () => {
    const root = await makeTempDir('review-wiring-drift-');
    await scaffoldRepo(root);
    await writeText(path.join(root, 'scripts', 'vibe-orphan.mjs'), '#!/usr/bin/env node\n');
    await writeText(path.join(root, 'scripts', 'vibe-missing-manifest.mjs'), '#!/usr/bin/env node\n');
    await writeText(path.join(root, 'scripts', 'vibe-wired.mjs'), '#!/usr/bin/env node\n');
    await writeJson(path.join(root, 'package.json'), {
      scripts: {
        'vibe:missing-manifest': 'node scripts/vibe-missing-manifest.mjs',
        'vibe:wired': 'node scripts/vibe-wired.mjs',
      },
    });
    await writeJson(path.join(root, '.vibe', 'sync-manifest.json'), {
      files: {
        harness: ['scripts/vibe-orphan.mjs', 'scripts/vibe-wired.mjs'],
        hybrid: {},
        project: [],
      },
    });

    const result = await collectReviewInputs(root);

    assert.deepEqual(result.wiringDriftFindings, [
      {
        artifactPath: 'scripts/vibe-missing-manifest.mjs',
        referencePaths: ['package.json'],
        missingRuntimeReference: false,
        missingSyncManifest: true,
      },
      {
        artifactPath: 'scripts/vibe-orphan.mjs',
        referencePaths: [],
        missingRuntimeReference: true,
        missingSyncManifest: false,
      },
    ]);
  });
});
