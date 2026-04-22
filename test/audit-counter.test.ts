import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, it } from 'node:test';
import type { SprintStatus } from '../src/lib/sprint-status.js';

const execFile = promisify(execFileCallback);
const tempDirs: string[] = [];
const sprintCompletePath = path.resolve('scripts', 'vibe-sprint-complete.mjs');
const auditClearPath = path.resolve('scripts', 'vibe-audit-clear.mjs');

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

async function scaffoldRepo(
  root: string,
  options: {
    sprintsSinceLastAudit: number;
    pendingRisks?: SprintStatus['pendingRisks'];
  },
): Promise<void> {
  await writeJson(path.join(root, '.vibe', 'config.json'), {
    harnessVersion: '1.1.1',
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
    sprints: [],
    verificationCommands: [],
    pendingRisks: options.pendingRisks ?? [],
    lastSprintScope: [],
    lastSprintScopeGlob: [],
    sprintsSinceLastAudit: options.sprintsSinceLastAudit,
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
  await writeText(
    path.join(root, '.vibe', 'agent', 'session-log.md'),
    '# Session Log\n\n## Entries\n',
  );
}

async function runNodeScript(root: string, scriptPath: string, args: string[]) {
  return execFile('node', [scriptPath, ...args], {
    cwd: root,
    env: process.env,
  });
}

async function loadStatus(root: string): Promise<SprintStatus> {
  return JSON.parse(
    await readFile(path.join(root, '.vibe', 'agent', 'sprint-status.json'), 'utf8'),
  ) as SprintStatus;
}

describe('audit counter lifecycle', () => {
  it('injects an audit-after risk when the threshold is reached', async () => {
    const root = await makeTempDir('audit-counter-threshold-');
    await scaffoldRepo(root, {
      sprintsSinceLastAudit: 4,
    });

    await runNodeScript(root, sprintCompletePath, ['sprint-M8-audit', 'passed']);
    const status = await loadStatus(root);
    const risk = status.pendingRisks.find((entry) => entry.id === 'audit-after-sprint-M8-audit');

    assert.equal(status.sprintsSinceLastAudit, 5);
    assert.ok(risk);
    assert.equal(risk.status, 'open');
    assert.equal(risk.raisedBy, 'vibe-sprint-complete');
    assert.equal(risk.targetSprint, '*');
  });

  it('does not inject duplicate audit risks when the same sprint completion is replayed', async () => {
    const root = await makeTempDir('audit-counter-idempotent-');
    await scaffoldRepo(root, {
      sprintsSinceLastAudit: 4,
    });

    await runNodeScript(root, sprintCompletePath, ['sprint-M8-audit', 'passed']);
    await runNodeScript(root, sprintCompletePath, ['sprint-M8-audit', 'passed']);
    const status = await loadStatus(root);
    const risks = status.pendingRisks.filter((entry) => entry.id === 'audit-after-sprint-M8-audit');

    assert.equal(status.sprintsSinceLastAudit, 5);
    assert.equal(risks.length, 1);
  });

  it('resets the counter, resolves audit-after risks, and appends an audit-clear log entry', async () => {
    const root = await makeTempDir('audit-counter-clear-');
    await scaffoldRepo(root, {
      sprintsSinceLastAudit: 7,
      pendingRisks: [
        {
          id: 'audit-after-sprint-M8-a',
          raisedBy: 'test',
          targetSprint: '*',
          text: 'clear me',
          status: 'open',
          createdAt: '2026-04-16T00:00:00.000Z',
        },
        {
          id: 'audit-after-sprint-M8-b',
          raisedBy: 'test',
          targetSprint: '*',
          text: 'clear me too',
          status: 'open',
          createdAt: '2026-04-16T00:00:01.000Z',
        },
        {
          id: 'audit-sprint-M7-phase0-seal-and-utilities',
          raisedBy: 'test',
          targetSprint: '*',
          text: 'legacy format',
          status: 'open',
          createdAt: '2026-04-16T00:00:02.000Z',
        },
      ],
    });

    await runNodeScript(root, auditClearPath, [
      '--resolve-risks',
      '--note',
      'manual smoke',
    ]);

    const status = await loadStatus(root);
    const sessionLog = await readFile(path.join(root, '.vibe', 'agent', 'session-log.md'), 'utf8');

    assert.equal(status.sprintsSinceLastAudit, 0);
    assert.equal(status.pendingRisks[0]?.status, 'resolved');
    assert.equal(status.pendingRisks[1]?.status, 'resolved');
    assert.equal(typeof status.pendingRisks[0]?.resolvedAt, 'string');
    assert.equal(typeof status.pendingRisks[1]?.resolvedAt, 'string');
    assert.equal(status.pendingRisks[2]?.status, 'open');
    assert.match(sessionLog, /\[audit-clear\] resolved=2 note=manual smoke/);
  });
});
