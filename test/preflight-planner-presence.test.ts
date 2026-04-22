import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

const tempDirs: string[] = [];
const preflightPath = path.resolve('scripts', 'vibe-preflight.mjs');
const oldStateUpdatedAt = '2026-04-01T00:00:00.000Z';
const recentDecisionAt = '2026-04-02T00:00:00.000Z';

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

async function scaffoldRepo(
  root: string,
  options: {
    roadmapIds?: string[];
    completedIds?: string[];
    promptId?: string;
    plannerSkipId?: string;
    omitRoadmap?: boolean;
  } = {},
): Promise<void> {
  await mkdir(path.join(root, '.vibe', 'agent'), { recursive: true });
  await mkdir(path.join(root, 'docs', 'context'), { recursive: true });
  await mkdir(path.join(root, 'docs', 'plans'), { recursive: true });
  await writeJson(path.join(root, '.vibe', 'config.json'), {
    harnessVersion: '1.4.0',
    harnessVersionInstalled: '1.4.0',
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
    sprints: (options.completedIds ?? []).map((id) => ({
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
    stateUpdatedAt: oldStateUpdatedAt,
  });
  await writeFile(path.join(root, '.vibe', 'agent', 'handoff.md'), '# handoff\n', 'utf8');
  const plannerSkipLine = options.plannerSkipId
    ? `- ${recentDecisionAt} [decision][planner-skip] sprint=${options.plannerSkipId} reason=test skip\n`
    : '';
  await writeFile(path.join(root, '.vibe', 'agent', 'session-log.md'), `# Session Log\n\n## Entries\n${plannerSkipLine}`, 'utf8');
  await writeFile(
    path.join(root, 'docs', 'context', 'product.md'),
    'This stub product document is intentionally long enough to satisfy the phase zero gate in tests.\n',
    'utf8',
  );

  if (!options.omitRoadmap) {
    const roadmapIds = options.roadmapIds ?? ['sprint-one', 'sprint-two'];
    const roadmap = roadmapIds.map((id) => `- **id**: \`${id}\``).join('\n');
    await writeFile(path.join(root, 'docs', 'plans', 'sprint-roadmap.md'), `${roadmap}\n`, 'utf8');
  }

  if (options.promptId) {
    await mkdir(path.join(root, 'docs', 'prompts'), { recursive: true });
    await writeFile(path.join(root, 'docs', 'prompts', `${options.promptId}-foo.md`), '# prompt\n', 'utf8');
  }

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

function runPreflightJson(root: string): PreflightRecord[] {
  const result = spawnSync(process.execPath, [preflightPath, '--json'], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return JSON.parse(result.stdout) as PreflightRecord[];
}

function plannerPresence(records: PreflightRecord[]): PreflightRecord {
  const record = records.find((entry) => entry.id === 'planner.presence');
  assert.ok(record, 'planner.presence record missing');
  return record;
}

describe('vibe-preflight planner presence check', () => {
  it('emits WARN when next pending sprint has no prompt file', async () => {
    const root = await makeTempDir('preflight-planner-missing-');
    await scaffoldRepo(root, {
      roadmapIds: ['sprint-one', 'sprint-two'],
      completedIds: ['sprint-one'],
    });

    const record = plannerPresence(runPreflightJson(root));

    assert.equal(record.ok, true);
    assert.equal(record.level, 'warn');
    assert.match(record.detail, /vibe-planner-skip-log\.mjs/);
  });

  it('emits OK when prompt file exists and is fresh', async () => {
    const root = await makeTempDir('preflight-planner-fresh-');
    await scaffoldRepo(root, {
      roadmapIds: ['sprint-one', 'sprint-two'],
      completedIds: ['sprint-one'],
      promptId: 'sprint-two',
    });

    const record = plannerPresence(runPreflightJson(root));

    assert.equal(record.ok, true);
    assert.equal(record.level, 'ok');
    assert.match(record.detail, /found: docs\/prompts\/sprint-two-foo\.md/);
  });

  it('emits OK when planner-skip decision is recorded', async () => {
    const root = await makeTempDir('preflight-planner-skip-');
    await scaffoldRepo(root, {
      roadmapIds: ['sprint-one', 'sprint-two'],
      completedIds: ['sprint-one'],
      plannerSkipId: 'sprint-two',
    });

    const record = plannerPresence(runPreflightJson(root));

    assert.equal(record.ok, true);
    assert.equal(record.level, 'ok');
    assert.match(record.detail, /planner intentionally skipped/);
  });

  it('skips when all roadmap sprints completed', async () => {
    const root = await makeTempDir('preflight-planner-complete-');
    await scaffoldRepo(root, {
      roadmapIds: ['sprint-one', 'sprint-two'],
      completedIds: ['sprint-one', 'sprint-two'],
    });

    const record = plannerPresence(runPreflightJson(root));

    assert.equal(record.ok, true);
    assert.equal(record.level, 'ok');
    assert.match(record.detail, /all roadmap sprints completed/);
  });

  it('skips gracefully when roadmap missing', async () => {
    const root = await makeTempDir('preflight-planner-no-roadmap-');
    await scaffoldRepo(root, {
      omitRoadmap: true,
    });

    const record = plannerPresence(runPreflightJson(root));

    assert.equal(record.ok, true);
    assert.notEqual(record.level, 'fail');
    assert.match(record.detail, /no roadmap IDs parseable/);
  });
});
