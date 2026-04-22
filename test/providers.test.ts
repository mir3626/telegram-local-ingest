import assert from 'node:assert/strict';
import test from 'node:test';
import { buildExecutionPlan } from '../src/providers/runner.js';
import type { ProviderRunner } from '../src/lib/config.js';

const baseRunner: ProviderRunner = {
  command: 'codex',
  args: ['exec', '{prompt}'],
  env: { LOCALE: '{cwd}' },
};

const baseInput = {
  provider: 'codex',
  role: 'coder',
  prompt: 'hello world',
  cwd: '/tmp/sprint',
  taskId: 't-123',
  runner: baseRunner,
};

test('buildExecutionPlan substitutes {prompt} in args', () => {
  const plan = buildExecutionPlan(baseInput);
  assert.deepEqual(plan.command, 'codex');
  assert.deepEqual(plan.args, ['exec', 'hello world']);
});

test('buildExecutionPlan substitutes template vars in env values', () => {
  const plan = buildExecutionPlan(baseInput);
  assert.equal(plan.env.LOCALE, '/tmp/sprint');
});

test('buildExecutionPlan drops args that resolve to empty string', () => {
  // {promptFile} → '' when not provided, and filter(Boolean) strips it
  const plan = buildExecutionPlan({
    ...baseInput,
    runner: { command: 'codex', args: ['exec', '{promptFile}', '{prompt}'] },
  });
  assert.deepEqual(plan.args, ['exec', 'hello world']);
});

test('buildExecutionPlan preserves promptFile when provided', () => {
  const plan = buildExecutionPlan({
    ...baseInput,
    promptFile: '/tmp/prompt.md',
    runner: { command: 'codex', args: ['exec', '{promptFile}'] },
  });
  assert.deepEqual(plan.args, ['exec', '/tmp/prompt.md']);
});

test('buildExecutionPlan substitutes {role} and {taskId}', () => {
  const plan = buildExecutionPlan({
    ...baseInput,
    runner: { command: 'run', args: ['--role={role}', '--task={taskId}'] },
  });
  assert.deepEqual(plan.args, ['--role=coder', '--task=t-123']);
});

test('buildExecutionPlan returns empty env when runner.env is undefined', () => {
  const plan = buildExecutionPlan({
    ...baseInput,
    runner: { command: 'codex', args: [] },
  });
  assert.deepEqual(plan.env, {});
});

test('buildExecutionPlan handles wrapper-style command (run-codex.sh)', () => {
  const plan = buildExecutionPlan({
    ...baseInput,
    runner: { command: './scripts/run-codex.sh', args: ['{prompt}'] },
  });
  assert.equal(plan.command, './scripts/run-codex.sh');
  assert.deepEqual(plan.args, ['hello world']);
});
