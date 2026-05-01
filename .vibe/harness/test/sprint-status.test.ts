import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import {
  appendPendingRisk,
  extendLastSprintScope,
  incrementAuditCounter,
  isSprintStatus,
  loadSprintStatus,
  resetAuditCounter,
  resolvePendingRisksByPrefix,
  resolvePendingRisk,
  saveSprintStatus,
  touchStateUpdated,
  withDefaults,
  type SprintStatus,
} from '../src/lib/sprint-status.js';

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

function makeLegacyStatus(): Parameters<typeof withDefaults>[0] {
  return {
    $schema: './sprint-status.schema.json',
    schemaVersion: '0.1',
    project: {
      name: 'demo',
      createdAt: '2026-04-01T00:00:00.000Z',
      runtime: 'node24',
      framework: 'test',
    },
    sprints: [],
    verificationCommands: [],
    sandboxNotes: [],
    handoff: {
      currentSprintId: 'idle',
      lastActionSummary: 'legacy',
      orchestratorContextBudget: 'low',
      preferencesActive: [],
      handoffDocPath: '.vibe/agent/handoff.md',
      updatedAt: '2026-04-02T00:00:00.000Z',
    },
  };
}

async function writeLegacyStatus(root: string): Promise<void> {
  await writeJson(path.join(root, '.vibe', 'agent', 'sprint-status.json'), makeLegacyStatus());
}

describe('sprint-status', () => {
  it('loadSprintStatus injects defaults for legacy files', async () => {
    const root = await makeTempDir('sprint-status-legacy-');
    await writeLegacyStatus(root);

    const status = await loadSprintStatus(root);

    assert.deepEqual(status.pendingRisks, []);
    assert.equal(status.sprintsSinceLastAudit, 0);
    assert.deepEqual(status.lastSprintScope, []);
    assert.deepEqual(status.lastSprintScopeGlob, []);
    assert.equal(status.stateUpdatedAt, '2026-04-02T00:00:00.000Z');
    assert.equal(status.verifiedAt, undefined);
  });

  it('saveSprintStatus persists changes and keeps roundtrip data', async () => {
    const root = await makeTempDir('sprint-status-save-');
    await writeLegacyStatus(root);

    const loaded = await loadSprintStatus(root);
    loaded.lastSprintScope = ['src/lib/sprint-status.ts'];
    loaded.pendingRisks.push({
      id: 'risk-1',
      raisedBy: 'test',
      targetSprint: '*',
      text: 'pending',
      status: 'open',
      createdAt: '2026-04-03T00:00:00.000Z',
    });

    await saveSprintStatus(loaded, root);
    const saved = await loadSprintStatus(root);

    assert.deepEqual(saved.lastSprintScope, ['src/lib/sprint-status.ts']);
    assert.deepEqual(saved.pendingRisks, loaded.pendingRisks);
    assert.equal(saved.project.name, 'demo');
    assert.notEqual(saved.stateUpdatedAt, '2026-04-02T00:00:00.000Z');
  });

  it('appendPendingRisk defaults status and sets createdAt', async () => {
    const root = await makeTempDir('sprint-status-append-');
    await writeLegacyStatus(root);

    const risk = await appendPendingRisk(
      {
        id: 'risk-append',
        raisedBy: 'test',
        targetSprint: 'M2',
        text: 'follow-up',
      },
      root,
    );

    assert.equal(risk.status, 'open');
    assert.equal(Number.isNaN(Date.parse(risk.createdAt)), false);

    const stored = await loadSprintStatus(root);
    assert.equal(stored.pendingRisks.length, 1);
    assert.equal(stored.pendingRisks[0]?.id, 'risk-append');
  });

  it('appendPendingRisk throws on duplicate ids', async () => {
    const root = await makeTempDir('sprint-status-duplicate-');
    await writeLegacyStatus(root);

    await appendPendingRisk(
      {
        id: 'dup-risk',
        raisedBy: 'test',
        targetSprint: '*',
        text: 'first',
      },
      root,
    );

    await assert.rejects(
      appendPendingRisk(
        {
          id: 'dup-risk',
          raisedBy: 'test',
          targetSprint: '*',
          text: 'second',
        },
        root,
      ),
      /pendingRisk id already exists: dup-risk/,
    );
  });

  it('resolvePendingRisk returns null for unknown ids and resolves known ones', async () => {
    const root = await makeTempDir('sprint-status-resolve-');
    await writeLegacyStatus(root);

    const missing = await resolvePendingRisk('missing', root);
    assert.equal(missing, null);

    await appendPendingRisk(
      {
        id: 'resolve-me',
        raisedBy: 'test',
        targetSprint: '*',
        text: 'resolve',
      },
      root,
    );

    const resolved = await resolvePendingRisk('resolve-me', root);
    assert.equal(resolved?.status, 'resolved');
    assert.equal(Number.isNaN(Date.parse(resolved?.resolvedAt ?? '')), false);
  });

  it('resolvePendingRisksByPrefix resolves open matching entries only and returns the count', async () => {
    const root = await makeTempDir('sprint-status-resolve-prefix-');
    await writeLegacyStatus(root);

    await saveSprintStatus(
      withDefaults({
        ...(await loadSprintStatus(root)),
        pendingRisks: [
          {
            id: 'audit-after-sprint-a',
            raisedBy: 'test',
            targetSprint: '*',
            text: 'first',
            status: 'open',
            createdAt: '2026-04-03T00:00:00.000Z',
          },
          {
            id: 'audit-after-sprint-b',
            raisedBy: 'test',
            targetSprint: '*',
            text: 'second',
            status: 'acknowledged',
            createdAt: '2026-04-03T00:00:01.000Z',
          },
          {
            id: 'risk-other',
            raisedBy: 'test',
            targetSprint: '*',
            text: 'third',
            status: 'open',
            createdAt: '2026-04-03T00:00:02.000Z',
          },
        ],
      }),
      root,
    );

    const resolvedCount = await resolvePendingRisksByPrefix('audit-after-', root);
    const stored = await loadSprintStatus(root);

    assert.equal(resolvedCount, 1);
    assert.equal(stored.pendingRisks[0]?.status, 'resolved');
    assert.equal(typeof stored.pendingRisks[0]?.resolvedAt, 'string');
    assert.equal(stored.pendingRisks[1]?.status, 'acknowledged');
    assert.equal(stored.pendingRisks[2]?.status, 'open');
  });

  it('incrementAuditCounter and resetAuditCounter persist and advance stateUpdatedAt', async () => {
    const root = await makeTempDir('sprint-status-audit-');
    await writeLegacyStatus(root);

    const initial = await loadSprintStatus(root);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const incremented = await incrementAuditCounter(root);
    const afterIncrement = await loadSprintStatus(root);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await resetAuditCounter(root);
    const afterReset = await loadSprintStatus(root);

    assert.equal(incremented, 1);
    assert.equal(afterIncrement.sprintsSinceLastAudit, 1);
    assert.equal(afterReset.sprintsSinceLastAudit, 0);
    assert.equal(Date.parse(afterIncrement.stateUpdatedAt) > Date.parse(initial.stateUpdatedAt), true);
    assert.equal(Date.parse(afterReset.stateUpdatedAt) > Date.parse(afterIncrement.stateUpdatedAt), true);
  });

  it('isSprintStatus accepts legacy shape and rejects garbage', async () => {
    const legacy = makeLegacyStatus();
    assert.equal(isSprintStatus(legacy), true);
    assert.equal(isSprintStatus({ project: { name: 'x' } }), false);
  });

  it('touchStateUpdated persists an explicit timestamp bump', async () => {
    const root = await makeTempDir('sprint-status-touch-');
    await writeJson(
      path.join(root, '.vibe', 'agent', 'sprint-status.json'),
      withDefaults(makeLegacyStatus()),
    );

    const beforeRaw = JSON.parse(
      await readFile(path.join(root, '.vibe', 'agent', 'sprint-status.json'), 'utf8'),
    ) as SprintStatus;
    await new Promise((resolve) => setTimeout(resolve, 20));
    const touched = await touchStateUpdated(root);
    const afterRaw = JSON.parse(
      await readFile(path.join(root, '.vibe', 'agent', 'sprint-status.json'), 'utf8'),
    ) as SprintStatus;

    assert.equal(touched, afterRaw.stateUpdatedAt);
    assert.equal(Date.parse(afterRaw.stateUpdatedAt) > Date.parse(beforeRaw.stateUpdatedAt), true);
  });

  it('extendLastSprintScope is a no-op for empty input', async () => {
    const root = await makeTempDir('sprint-status-extend-noop-');
    await writeJson(
      path.join(root, '.vibe', 'agent', 'sprint-status.json'),
      withDefaults(makeLegacyStatus()),
    );

    const before = await loadSprintStatus(root);
    const result = await extendLastSprintScope([], undefined, root);
    const after = await loadSprintStatus(root);

    assert.deepEqual(result.lastSprintScope, []);
    assert.deepEqual(result.lastSprintScopeGlob, []);
    assert.equal(after.stateUpdatedAt, before.stateUpdatedAt);
  });

  it('extendLastSprintScope merges and deduplicates existing paths and globs', async () => {
    const root = await makeTempDir('sprint-status-extend-merge-');
    await writeJson(
      path.join(root, '.vibe', 'agent', 'sprint-status.json'),
      withDefaults({
        ...makeLegacyStatus(),
        lastSprintScope: ['src/a.ts', 'src\\b.ts'],
        lastSprintScopeGlob: ['src/*.ts'],
      }),
    );

    const result = await extendLastSprintScope(
      ['src\\b.ts', 'src/c.ts'],
      ['src/*.ts', 'scripts/*.mjs'],
      root,
    );

    assert.deepEqual(result.lastSprintScope, ['src/a.ts', 'src/b.ts', 'src/c.ts']);
    assert.deepEqual(result.lastSprintScopeGlob, ['src/*.ts', 'scripts/*.mjs']);
  });
});
