import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import {
  appendDecision,
  filterDecisionsByScope,
  readDecisions,
  type ProjectDecision,
} from '../src/lib/decisions.js';

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

describe('decisions ledger', () => {
  it('appendDecision roundtrips through readDecisions with createdAt auto-filled', async () => {
    const root = await makeTempDir('decisions-roundtrip-');

    const appended = await appendDecision(
      {
        sprintId: 'sprint-M3',
        decision: 'use inline scope merge',
        affectedFiles: ['scripts/vibe-sprint-commit.mjs'],
        tag: 'decision',
        text: 'avoid tsx dependency in node script',
      },
      root,
    );
    const decisions = await readDecisions(root);

    assert.equal(Number.isNaN(Date.parse(appended.createdAt)), false);
    assert.equal(decisions.length, 1);
    assert.deepEqual(decisions[0], appended);
  });

  it('readDecisions skips malformed lines and keeps valid records', async () => {
    const root = await makeTempDir('decisions-malformed-');
    const filePath = path.join(root, '.vibe', 'agent', 'project-decisions.jsonl');

    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(
      filePath,
      [
        '\uFEFF{"sprintId":"sprint-M3","decision":"ok","affectedFiles":["src/lib/decisions.ts"],"tag":"decision","text":"valid","createdAt":"2026-04-15T00:00:00.000Z"}',
        'not-json',
        '{"sprintId":"broken"}',
        '',
      ].join('\n'),
      'utf8',
    );

    const decisions = await readDecisions(root);

    assert.equal(decisions.length, 1);
    assert.equal(decisions[0]?.decision, 'ok');
  });

  it('filterDecisionsByScope matches literals and globs without duplicates', () => {
    const decisions: ProjectDecision[] = [
      {
        sprintId: 'sprint-M3',
        decision: 'match literal',
        affectedFiles: ['src/lib/decisions.ts'],
        tag: 'decision',
        text: 'literal',
        createdAt: '2026-04-15T00:00:00.000Z',
      },
      {
        sprintId: 'sprint-M3',
        decision: 'match glob',
        affectedFiles: ['src/lib/foo.ts'],
        tag: 'discovery',
        text: 'glob',
        createdAt: '2026-04-15T00:00:00.000Z',
      },
      {
        sprintId: 'sprint-M3',
        decision: 'miss glob',
        affectedFiles: ['scripts/bar.mjs'],
        tag: 'risk',
        text: 'miss',
        createdAt: '2026-04-15T00:00:00.000Z',
      },
    ];

    const literalMatches = filterDecisionsByScope(decisions, ['src/lib/decisions.ts']);
    const globMatches = filterDecisionsByScope(decisions, ['**/*.ts', 'src/lib/foo.ts']);

    assert.deepEqual(literalMatches.map((entry) => entry.decision), ['match literal']);
    assert.deepEqual(globMatches.map((entry) => entry.decision), ['match literal', 'match glob']);
  });
});
