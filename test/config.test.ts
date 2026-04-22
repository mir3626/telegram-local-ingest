import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeConfig, type VibeConfig } from '../src/lib/config.js';

const base: VibeConfig = {
  orchestrator: 'claude-opus',
  sprintRoles: {
    planner: 'claude-opus',
    generator: 'codex',
    evaluator: 'claude-opus',
  },
  sprint: {
    unit: 'feature',
    subAgentPerRole: true,
    freshContextPerSprint: true,
  },
  providers: {
    'claude-opus': { command: 'claude', args: ['-p', '{prompt}'] },
    codex: { command: 'codex', args: ['exec', '--json', '{prompt}'] },
  },
  qa: {
    preferScripts: ['test'],
  },
};

test('mergeConfig preserves provider map and overrides top-level fields', () => {
  const merged = mergeConfig(base, {
    orchestrator: 'claude-sonnet',
    providers: {
      gemini: { command: 'gemini', args: ['run'] },
    },
  });

  assert.equal(merged.orchestrator, 'claude-sonnet');
  assert.equal(merged.providers['claude-opus']?.command, 'claude');
  assert.equal(merged.providers.gemini?.command, 'gemini');
  assert.deepEqual(merged.qa?.preferScripts, ['test']);
});

test('mergeConfig deep-merges sprintRoles', () => {
  const merged = mergeConfig(base, {
    sprintRoles: { generator: 'gemini' } as any,
  });

  assert.equal(merged.sprintRoles.generator, 'gemini');
  assert.equal(merged.sprintRoles.planner, 'claude-opus');
  assert.equal(merged.sprintRoles.evaluator, 'claude-opus');
});

test('mergeConfig deep-merges sprint config', () => {
  const merged = mergeConfig(base, {
    sprint: { unit: 'page' } as any,
  });

  assert.equal(merged.sprint.unit, 'page');
  assert.equal(merged.sprint.subAgentPerRole, true);
});

test('mergeConfig copies mode override as a top-level field', () => {
  const merged = mergeConfig({ ...base, mode: 'human' }, { mode: 'agent' });

  assert.equal(merged.mode, 'agent');
});
