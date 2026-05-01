import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import {
  completeIteration,
  computeMilestoneProgress,
  readIterationHistory,
  recordSprintCompletion,
  startIteration,
  type IterationHistory,
  type Milestone,
} from '../src/lib/iteration.js';

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

describe('iteration history', () => {
  it('startIteration creates history and sets currentIteration', async () => {
    const root = await makeTempDir('iteration-start-');

    await startIteration(
      {
        id: 'iter-1',
        label: 'Prototype',
        goal: 'first usable flow',
        plannedSprints: ['sprint-01-engine'],
      },
      root,
    );

    const history = await readIterationHistory(root);
    assert.equal(history.currentIteration, 'iter-1');
    assert.equal(history.iterations[0]?.plannedSprints[0], 'sprint-01-engine');
  });

  it('recordSprintCompletion appends without duplicates', async () => {
    const root = await makeTempDir('iteration-record-');

    await startIteration(
      {
        id: 'iter-1',
        label: 'Prototype',
        goal: 'first usable flow',
        plannedSprints: ['sprint-01-engine', 'sprint-02-ui'],
      },
      root,
    );
    await recordSprintCompletion('sprint-01-engine', root);
    await recordSprintCompletion('sprint-01-engine', root);

    const history = await readIterationHistory(root);
    assert.deepEqual(history.iterations[0]?.completedSprints, ['sprint-01-engine']);
  });

  it('completeIteration sets completedAt, summary, and clears currentIteration', async () => {
    const root = await makeTempDir('iteration-complete-');

    await startIteration(
      {
        id: 'iter-1',
        label: 'Prototype',
        goal: 'first usable flow',
        plannedSprints: ['sprint-01-engine'],
      },
      root,
    );
    const completed = await completeIteration('Prototype finished.', root);
    const history = await readIterationHistory(root);

    assert.equal(history.currentIteration, null);
    assert.equal(completed.summary, 'Prototype finished.');
    assert.notEqual(completed.completedAt, null);
  });
});

describe('computeMilestoneProgress', () => {
  const milestones: Milestone[] = [
    {
      id: 'prototype',
      name: 'Prototype',
      targetIteration: 'iter-1',
      progressMetric: 'sprint_complete_ratio',
    },
    {
      id: 'beta',
      name: 'Beta',
      targetIteration: 'iter-2',
      progressMetric: 'feature_coverage',
    },
  ];

  it('returns 0 for no target sprints and unsupported metrics', () => {
    const history: IterationHistory = {
      currentIteration: 'iter-1',
      iterations: [
        {
          id: 'iter-1',
          label: 'Prototype',
          startedAt: '2026-04-16T00:00:00.000Z',
          completedAt: null,
          goal: 'empty',
          plannedSprints: [],
          completedSprints: [],
          milestoneProgress: {},
          summary: '',
        },
      ],
    };

    assert.deepEqual(computeMilestoneProgress(history, milestones), {
      prototype: 0,
      beta: 0,
    });
  });

  it('computes partial and complete sprint ratios', () => {
    const partial: IterationHistory = {
      currentIteration: 'iter-1',
      iterations: [
        {
          id: 'iter-1',
          label: 'Prototype',
          startedAt: '2026-04-16T00:00:00.000Z',
          completedAt: null,
          goal: 'partial',
          plannedSprints: ['a', 'b'],
          completedSprints: ['a'],
          milestoneProgress: {},
          summary: '',
        },
      ],
    };
    const complete: IterationHistory = {
      ...partial,
      iterations: [
        {
          ...partial.iterations[0]!,
          completedSprints: ['a', 'b'],
        },
      ],
    };

    assert.equal(computeMilestoneProgress(partial, milestones).prototype, 0.5);
    assert.equal(computeMilestoneProgress(complete, milestones).prototype, 1);
  });
});
