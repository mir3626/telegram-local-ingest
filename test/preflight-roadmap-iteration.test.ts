import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { resolveNextSprintFromRoadmap } from '../src/lib/preflight-roadmap.js';

const tempDirs: string[] = [];
const preflightPath = path.resolve('scripts', 'vibe-preflight.mjs');
const previousSprintIds = [
  'sprint-M1-schema-foundation',
  'sprint-M2-platform-wrappers',
  'sprint-M3-sprint-flow-automation',
  'sprint-M4-model-tier',
  'sprint-M5-native-interview',
  'sprint-M6-pattern-shards',
  'sprint-M7-phase0-seal-and-utilities',
  'sprint-M8-audit-review-gaps',
  'sprint-M9-statusline-permissions',
  'sprint-M10-integration-release',
  'sprint-M-audit',
  'sprint-M-process-discipline',
  'sprint-M-harness-gates',
  'sprint-N1-rule-audit-diet',
  'sprint-N2-critical-bug-triage',
  'sprint-N3-freeze-mode-flag',
];

const roadmap = [
  '# Roadmap',
  '',
  '## Iteration 1 - foundation',
  '- **id**: `sprint-M1-schema-foundation`',
  '- **id**: `sprint-M2-platform-wrappers`',
  '',
  '# Iteration iter-3 - harness diet',
  '- **id**: `sprint-N1-rule-audit-diet`',
  '- **id**: `sprint-N2-critical-bug-triage`',
  '- **id**: `sprint-N3-freeze-mode-flag`',
  '',
  '## Iteration 4 - harness stability tune',
  '- **id**: `sprint-O1-interview-coverage`',
  '- **id**: `sprint-O2-script-wrapper-triage`',
  '- **id**: `sprint-O3-planner-contract-polish`',
  '',
].join('\n');

type PreflightRecord = {
  id: string;
  ok: boolean;
  detail: string;
  level: string;
};

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

async function scaffoldPreflightRepo(root: string): Promise<void> {
  await mkdir(path.join(root, '.vibe', 'agent'), { recursive: true });
  await mkdir(path.join(root, 'docs', 'context'), { recursive: true });
  await mkdir(path.join(root, 'docs', 'plans'), { recursive: true });
  await mkdir(path.join(root, 'docs', 'prompts'), { recursive: true });
  await writeJson(path.join(root, '.vibe', 'config.json'), {
    harnessVersion: '1.4.1',
    harnessVersionInstalled: '1.4.1',
    sprintRoles: {},
    providers: {},
    audit: {
      everyN: 5,
    },
  });
  await writeJson(path.join(root, '.vibe', 'agent', 'sprint-status.json'), {
    schemaVersion: '0.1',
    project: {
      name: 'test-project',
      createdAt: '2026-04-01T00:00:00.000Z',
    },
    sprints: [...previousSprintIds, 'sprint-O1-interview-coverage'].map((id) => ({
      id,
      name: id,
      status: 'passed',
      completedAt: '2026-04-01T00:00:00.000Z',
    })),
    verificationCommands: [],
    pendingRisks: [],
    lastSprintScope: [],
    lastSprintScopeGlob: [],
    sprintsSinceLastAudit: 0,
    stateUpdatedAt: '2026-04-01T00:00:00.000Z',
  });
  await writeJson(path.join(root, '.vibe', 'agent', 'iteration-history.json'), {
    currentIteration: 'iter-4',
    iterations: [
      {
        id: 'iter-4',
        label: 'harness stability tune',
        startedAt: '2026-04-18T00:00:00.000Z',
        completedAt: null,
        goal: 'stabilize script wrappers',
        plannedSprints: [
          'sprint-O1-interview-coverage',
          'sprint-O2-script-wrapper-triage',
          'sprint-O3-planner-contract-polish',
        ],
        completedSprints: ['sprint-O1-interview-coverage'],
        milestoneProgress: {},
        summary: '',
      },
    ],
  });
  await writeFile(path.join(root, '.vibe', 'agent', 'handoff.md'), '# handoff\n', 'utf8');
  await writeFile(path.join(root, '.vibe', 'agent', 'session-log.md'), '# Session Log\n\n## Entries\n', 'utf8');
  await writeFile(
    path.join(root, 'docs', 'context', 'product.md'),
    'This stub product document is intentionally long enough to satisfy the phase zero gate in tests.\n',
    'utf8',
  );
  await writeFile(path.join(root, 'docs', 'plans', 'sprint-roadmap.md'), roadmap, 'utf8');
  await writeFile(
    path.join(root, 'docs', 'prompts', 'sprint-O2-script-wrapper-triage.md'),
    '# O2 prompt\n',
    'utf8',
  );

  for (const args of [
    ['init'],
    ['config', 'user.name', 'Test User'],
    ['config', 'user.email', 'test@example.com'],
    ['add', '.'],
    ['commit', '-m', 'init'],
  ]) {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }
}

function plannerPresence(records: PreflightRecord[]): PreflightRecord {
  const record = records.find((entry) => entry.id === 'planner.presence');
  assert.ok(record, 'planner.presence record missing');
  return record;
}

describe('preflight roadmap iteration resolver', () => {
  it('selects the first pending sprint from the current iteration section', () => {
    const result = resolveNextSprintFromRoadmap({
      roadmapMd: roadmap,
      currentIterationId: 'iter-4',
      completedSprintIds: new Set([...previousSprintIds, 'sprint-O1-interview-coverage']),
    });

    assert.equal(result.pendingId, 'sprint-O2-script-wrapper-triage');
    assert.equal(result.scanScope, 'iteration-scoped');
    assert.match(result.iterationHeader ?? '', /Iteration 4/);
  });

  it('does not select iter-1 sprints when current iteration is iter-3', () => {
    const result = resolveNextSprintFromRoadmap({
      roadmapMd: roadmap,
      currentIterationId: 'iter-3',
      completedSprintIds: new Set([
        'sprint-M1-schema-foundation',
        'sprint-M2-platform-wrappers',
      ]),
    });

    assert.equal(result.pendingId, 'sprint-N1-rule-audit-diet');
    assert.equal(result.scanScope, 'iteration-scoped');
  });

  it('preserves legacy flat roadmap scanning when no iteration header exists', () => {
    const result = resolveNextSprintFromRoadmap({
      roadmapMd: ['- **id**: `sprint-one`', '- **id**: `sprint-two`'].join('\n'),
      currentIterationId: null,
      completedSprintIds: new Set(['sprint-one']),
    });

    assert.equal(result.pendingId, 'sprint-two');
    assert.equal(result.scanScope, 'legacy-flat');
  });

  it('returns no pending sprint when currentIterationId is absent from an iteration-scoped roadmap', () => {
    const result = resolveNextSprintFromRoadmap({
      roadmapMd: roadmap,
      currentIterationId: 'iter-99',
      completedSprintIds: new Set(),
    });

    assert.equal(result.pendingId, null);
    assert.equal(result.scanScope, 'iteration-scoped');
    assert.equal(result.iterationHeader, null);
  });

  it('preflight uses iter-4 scope and does not warn on older iter-1 prompts', async () => {
    const root = await makeTempDir('preflight-roadmap-iteration-');
    await scaffoldPreflightRepo(root);

    const result = spawnSync(process.execPath, [preflightPath, '--json'], {
      cwd: root,
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);

    const record = plannerPresence(JSON.parse(result.stdout) as PreflightRecord[]);
    assert.equal(record.ok, true);
    assert.equal(record.level, 'ok');
    assert.match(record.detail, /sprint-O2-script-wrapper-triage\.md/);
    assert.doesNotMatch(record.detail, /sprint-M1-schema-foundation/);
  });
});
