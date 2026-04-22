import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, it } from 'node:test';
import {
  computeAmbiguity,
  dimensionCoverageRatio,
  shouldTerminate,
  type DimensionCoverage,
  type DimensionSpec,
} from '../src/lib/interview.js';

const execFile = promisify(execFileCallback);
const tempDirs: string[] = [];
const repoRoot = path.resolve();

interface PendingRound {
  roundNumber: number;
  dimensionId: string;
  questions: string[];
  answer: string | null;
  synthesizerPrompt: string;
  answerParserPrompt: string | null;
}

interface InterviewState {
  dimensions: DimensionSpec[];
  coverage: Record<string, DimensionCoverage>;
  rounds: Array<Record<string, unknown>>;
  pending: PendingRound | null;
}

interface ActiveState {
  sessionPath: string;
  state: InterviewState;
}

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

async function copyRelativeFile(root: string, relativePath: string): Promise<void> {
  const source = path.join(repoRoot, relativePath);
  const target = path.join(root, relativePath);
  await mkdir(path.dirname(target), { recursive: true });
  await copyFile(source, target);
}

async function scaffoldInterviewProject(root: string): Promise<void> {
  for (const relativePath of [
    'scripts/vibe-interview.mjs',
    'scripts/vibe-resolve-model.mjs',
    '.claude/skills/vibe-interview/dimensions.json',
    '.claude/skills/vibe-interview/prompts/synthesizer.md',
    '.claude/skills/vibe-interview/prompts/answer-parser.md',
    '.claude/skills/vibe-interview/prompts/domain-inference.md',
    '.claude/skills/vibe-interview/domain-probes/real-estate.md',
    '.claude/skills/vibe-interview/domain-probes/iot.md',
    '.claude/skills/vibe-interview/domain-probes/data-pipeline.md',
    '.claude/skills/vibe-interview/domain-probes/web-saas.md',
    '.claude/skills/vibe-interview/domain-probes/game.md',
    '.claude/skills/vibe-interview/domain-probes/research.md',
    '.claude/skills/vibe-interview/domain-probes/cli-tool.md',
  ]) {
    await copyRelativeFile(root, relativePath);
  }
}

async function runCli(root: string, args: string[]) {
  return execFile('node', [path.join(root, 'scripts', 'vibe-interview.mjs'), ...args], { cwd: root });
}

async function readActiveState(root: string): Promise<ActiveState> {
  const sessionId = (await readFile(path.join(root, '.vibe', 'interview-log', '.active'), 'utf8')).trim();
  const sessionPath = path.join(root, '.vibe', 'interview-log', `${sessionId}.json`);
  const state = JSON.parse(await readFile(sessionPath, 'utf8')) as InterviewState;
  return { sessionPath, state };
}

async function writeState(sessionPath: string, state: InterviewState): Promise<void> {
  await writeFile(sessionPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

async function initSession(root: string): Promise<void> {
  await scaffoldInterviewProject(root);
  await runCli(root, ['--init', '--prompt', 'coverage accounting smoke']);
}

async function stagePendingDimension(root: string, dimensionId: string): Promise<void> {
  const { sessionPath, state } = await readActiveState(root);
  state.pending = {
    roundNumber: state.rounds.length + 1,
    dimensionId,
    questions: ['test question'],
    answer: 'test answer',
    synthesizerPrompt: 'test synthesizer prompt',
    answerParserPrompt: 'test parser prompt',
  };
  await writeState(sessionPath, state);
}

async function recordGoal(root: string, attribution: Record<string, unknown>): Promise<InterviewState> {
  await stagePendingDimension(root, 'goal');
  await runCli(root, [
    '--record',
    '--attribution',
    JSON.stringify({ attribution, cross_dimension_signals: [], rationale: 'test' }),
  ]);
  return (await readActiveState(root)).state;
}

function assertClose(actual: number, expected: number): void {
  assert.ok(Math.abs(actual - expected) < 1e-12, `expected ${actual} to equal ${expected}`);
}

describe('interview coverage accounting', () => {
  it('case-A replaces a lower-confidence sub-field with a higher-confidence answer', async () => {
    const root = await makeTempDir('interview-coverage-high-watermark-');
    await initSession(root);

    await recordGoal(root, {
      one_liner: { value: 'low confidence goal', confidence: 0.25, deferred: false },
    });
    const state = await recordGoal(root, {
      one_liner: { value: 'high confidence goal', confidence: 0.95, deferred: false },
    });

    const goal = state.coverage.goal;
    assert.ok(goal);
    assert.equal(goal.subFields.one_liner?.value, 'high confidence goal');
    assert.equal(goal.subFields.one_liner?.confidence, 0.95);
    assertClose(goal.ratio, 0.475);
  });

  it('case-B retains a higher-confidence sub-field when a lower-confidence answer arrives', async () => {
    const root = await makeTempDir('interview-coverage-retain-');
    await initSession(root);

    await recordGoal(root, {
      one_liner: { value: 'high confidence goal', confidence: 0.95, deferred: false },
    });
    const state = await recordGoal(root, {
      one_liner: { value: 'low confidence goal', confidence: 0.25, deferred: false },
    });

    const goal = state.coverage.goal;
    assert.ok(goal);
    assert.equal(goal.subFields.one_liner?.value, 'high confidence goal');
    assert.equal(goal.subFields.one_liner?.confidence, 0.95);
    assertClose(goal.ratio, 0.475);
  });

  it('case-C resets a sub-field immediately when the incoming answer is deferred', async () => {
    const root = await makeTempDir('interview-coverage-deferred-');
    await initSession(root);

    await recordGoal(root, {
      one_liner: { value: 'high confidence goal', confidence: 0.95, deferred: false },
    });
    const state = await recordGoal(root, {
      one_liner: { value: 'later deferral', confidence: 1, deferred: true },
    });

    const reset = state.coverage.goal?.subFields.one_liner;
    assert.deepEqual(reset, { value: '', confidence: 0, deferred: true });
    assertClose(state.coverage.goal?.ratio ?? -1, 0);
  });

  it('case-D normalizes partial ratios as the weighted average of non-deferred sub-fields', () => {
    const specs: DimensionSpec[] = [
      { id: 'goal', label: 'Goal', weight: 1, subFields: ['one_liner', 'primary_value'], required: true },
    ];
    const coverage: Record<string, DimensionCoverage> = {
      goal: {
        ratio: 0,
        subFields: {
          one_liner: { value: 'ship faster', confidence: 0.9, deferred: false },
          primary_value: { value: '', confidence: 0, deferred: true },
        },
      },
    };

    const goalSpec = specs[0];
    const goalCoverage = coverage.goal;
    assert.ok(goalSpec);
    assert.ok(goalCoverage);
    const ratio = dimensionCoverageRatio(goalSpec, goalCoverage);
    const expectedRatio = (0.9 * (1 - 0) + 0 * (1 - 1)) / 2;
    assertClose(ratio, expectedRatio);
    assertClose(computeAmbiguity(specs, coverage), 1 - expectedRatio);
  });

  it('case-E ignores attribution keys outside the pending dimension sub-field list', async () => {
    const root = await makeTempDir('interview-coverage-foreign-key-');
    await initSession(root);

    const active = await readActiveState(root);
    active.state.coverage.constraints = { ratio: 0, subFields: {} };
    await writeState(active.sessionPath, active.state);

    const state = await recordGoal(root, {
      one_liner: { value: 'goal captured', confidence: 0.8, deferred: false },
      legal_regulatory: { value: 'foreign constraint', confidence: 1, deferred: false },
    });

    assert.equal(state.coverage.goal?.subFields.one_liner?.confidence, 0.8);
    assert.equal(state.coverage.constraints?.subFields.legal_regulatory, undefined);
  });

  it('case-F soft-terminates only when every required dimension reaches the configured ratio', () => {
    const specs: DimensionSpec[] = [
      { id: 'goal', label: 'Goal', weight: 1, subFields: ['one_liner'], required: true },
      { id: 'constraints', label: 'Constraints', weight: 1, subFields: ['legal_regulatory'], required: true },
    ];
    const covered: Record<string, DimensionCoverage> = {
      goal: {
        ratio: 0,
        subFields: { one_liner: { value: 'done', confidence: 0.8, deferred: false } },
      },
      constraints: {
        ratio: 0,
        subFields: { legal_regulatory: { value: 'done', confidence: 0.9, deferred: false } },
      },
    };
    const underThreshold: Record<string, DimensionCoverage> = {
      ...covered,
      constraints: {
        ratio: 0,
        subFields: { legal_regulatory: { value: 'weak', confidence: 0.7, deferred: false } },
      },
    };

    assert.deepEqual(shouldTerminate(0.25, 3, 30, specs, covered), {
      terminate: true,
      reason: 'soft-terminate',
    });
    assert.deepEqual(shouldTerminate(0.25, 3, 30, specs, underThreshold), {
      terminate: false,
      reason: null,
    });
  });

  it('--status reports pending sub-fields and returns null when no round is pending', async () => {
    const root = await makeTempDir('interview-coverage-status-');
    await initSession(root);

    const active = await readActiveState(root);
    const goal = active.state.coverage.goal;
    const goalDimension = active.state.dimensions.find((dimension) => dimension.id === 'goal');
    assert.ok(goal);
    assert.ok(goalDimension);
    goal.subFields.one_liner = { value: 'covered', confidence: 1, deferred: false };
    active.state.pending = {
      roundNumber: 1,
      dimensionId: 'goal',
      questions: ['test question'],
      answer: null,
      synthesizerPrompt: 'test synthesizer prompt',
      answerParserPrompt: null,
    };
    await writeState(active.sessionPath, active.state);

    const pendingStatus = JSON.parse((await runCli(root, ['--status'])).stdout) as {
      pendingDimension: { id: string; label: string; subFields: string[]; pendingSubFields: string[] } | null;
      ambiguity: number;
      coverage: Record<string, number>;
    };
    assert.deepEqual(pendingStatus.pendingDimension, {
      id: 'goal',
      label: goalDimension.label,
      subFields: ['one_liner', 'primary_value'],
      pendingSubFields: ['primary_value'],
    });
    assert.equal(typeof pendingStatus.ambiguity, 'number');
    assert.equal(pendingStatus.coverage.goal, 0.5);

    active.state.pending = null;
    await writeState(active.sessionPath, active.state);
    const idleStatus = JSON.parse((await runCli(root, ['--status'])).stdout) as {
      pendingDimension: unknown;
    };
    assert.equal(idleStatus.pendingDimension, null);
  });
});
