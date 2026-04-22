import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, it } from 'node:test';
import {
  computeAmbiguity,
  selectNextDimension,
  shouldTerminate,
  type DimensionCoverage,
  type DimensionSpec,
} from '../src/lib/interview.js';

const execFile = promisify(execFileCallback);

function makeCoverage(
  entries: Record<string, DimensionCoverage>,
): Record<string, DimensionCoverage> {
  return entries;
}

describe('interview engine helpers', () => {
  it('computeAmbiguity returns 0 when everything is fully covered', () => {
    const specs: DimensionSpec[] = [
      { id: 'goal', label: 'Goal', weight: 1, subFields: ['one_liner'], required: true },
      { id: 'domain_specifics', label: 'Domain', weight: 1, subFields: [], required: true },
    ];
    const coverage = makeCoverage({
      goal: {
        ratio: 0,
        subFields: {
          one_liner: { value: 'done', confidence: 1, deferred: false },
        },
      },
      domain_specifics: {
        ratio: 0,
        subFields: {
          free_form: { value: 'expert note', confidence: 1, deferred: false },
        },
      },
    });

    assert.equal(computeAmbiguity(specs, coverage), 0);
  });

  it('computeAmbiguity returns 1 when nothing is covered', () => {
    const specs: DimensionSpec[] = [
      { id: 'goal', label: 'Goal', weight: 1, subFields: ['one_liner'], required: true },
      { id: 'domain_specifics', label: 'Domain', weight: 1, subFields: [], required: true },
    ];
    const coverage = makeCoverage({
      goal: { ratio: 0, subFields: {} },
      domain_specifics: { ratio: 0, subFields: {} },
    });

    assert.equal(computeAmbiguity(specs, coverage), 1);
  });

  it('computeAmbiguity matches manual calculation for a heavy free-form dimension', () => {
    const specs: DimensionSpec[] = [
      { id: 'heavy', label: 'Heavy', weight: 1, subFields: [], required: true },
      { id: 'light', label: 'Light', weight: 0.5, subFields: ['field'], required: false },
    ];
    const coverage = makeCoverage({
      heavy: {
        ratio: 0,
        subFields: {
          free_form: { value: 'done', confidence: 1, deferred: false },
        },
      },
      light: { ratio: 0, subFields: {} },
    });

    const expected = 1 - 1 / 1.5;
    assert.ok(Math.abs(computeAmbiguity(specs, coverage) - expected) < 1e-9);
  });

  it('selectNextDimension skips a recently repeated dimension when another incomplete option exists', () => {
    const specs: DimensionSpec[] = [
      { id: 'goal', label: 'Goal', weight: 1, subFields: ['one_liner'], required: true },
      { id: 'constraints', label: 'Constraints', weight: 0.8, subFields: ['legal'], required: true },
    ];
    const coverage = makeCoverage({
      goal: { ratio: 0, subFields: {} },
      constraints: {
        ratio: 0,
        subFields: {
          legal: { value: 'partial', confidence: 0.2, deferred: false },
        },
      },
    });

    assert.equal(
      selectNextDimension(specs, coverage, ['goal', 'goal', 'goal']),
      'constraints',
    );
  });

  it('shouldTerminate covers max-rounds, ambiguity, and soft-terminate branches', () => {
    const specs: DimensionSpec[] = [
      { id: 'goal', label: 'Goal', weight: 1, subFields: ['one_liner'], required: true },
      { id: 'tech_stack', label: 'Tech', weight: 0.6, subFields: ['runtime'], required: false },
    ];
    const fullCoverage = makeCoverage({
      goal: {
        ratio: 0,
        subFields: {
          one_liner: { value: 'done', confidence: 1, deferred: false },
        },
      },
      tech_stack: { ratio: 0, subFields: {} },
    });

    assert.deepEqual(shouldTerminate(0.15, 1, 30, specs, fullCoverage), {
      terminate: true,
      reason: 'ambiguity',
    });
    assert.deepEqual(shouldTerminate(0.6, 31, 30, specs, fullCoverage), {
      terminate: true,
      reason: 'max-rounds',
    });
    assert.deepEqual(shouldTerminate(0.25, 3, 30, specs, fullCoverage), {
      terminate: true,
      reason: 'soft-terminate',
    });
  });

  it('keeps mjs computeAmbiguity in lockstep with the TypeScript helper', async () => {
    const scriptPath = path.resolve('scripts', 'vibe-interview.mjs');
    const dimensionsDocument = JSON.parse(
      await readFile(path.resolve('.claude/skills/vibe-interview/dimensions.json'), 'utf8'),
    ) as { dimensions: DimensionSpec[] };
    const coverage = makeCoverage({
      goal: {
        ratio: 0,
        subFields: {
          one_liner: { value: 'contract renewal marketplace', confidence: 1, deferred: false },
          primary_value: { value: 'reduce legal routing mistakes', confidence: 0.8, deferred: false },
        },
      },
      domain_specifics: {
        ratio: 0,
        subFields: {
          free_form: { value: '행정사 vs 변호사 routing', confidence: 1, deferred: false },
        },
      },
      constraints: {
        ratio: 0,
        subFields: {
          legal_regulatory: { value: 'licensed boundary matters', confidence: 0.7, deferred: false },
        },
      },
    });

    const expected = computeAmbiguity(dimensionsDocument.dimensions, coverage);
    const { stdout } = await execFile(
      'node',
      [scriptPath, '--stub-compute-ambiguity', JSON.stringify(coverage)],
      { cwd: path.resolve() },
    );
    const actual = Number(stdout.trim());

    assert.ok(
      Math.abs(expected - actual) < 1e-12,
      `drift detected: ts helper=${expected} mjs helper=${actual}`,
    );
  });
});
