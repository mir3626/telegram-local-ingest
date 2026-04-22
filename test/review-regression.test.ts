import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, it } from 'node:test';
import {
  assessRegression,
  computeRegressionCoverage,
  loadPriorReviewIssues,
  type PriorReviewIssue,
} from '../src/lib/review.js';

const execFile = promisify(execFileCallback);
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

async function writeText(filePath: string, value: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, value, 'utf8');
}

async function initGitRepo(root: string): Promise<void> {
  await execFile('git', ['init'], { cwd: root, env: process.env });
  await execFile('git', ['config', 'user.name', 'Test User'], { cwd: root });
  await execFile('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
  await writeText(path.join(root, 'README.md'), 'baseline\n');
  await execFile('git', ['add', '.'], { cwd: root });
  await execFile('git', ['commit', '-m', 'baseline'], { cwd: root, env: process.env });
}

function fixtureIssue(id: string, proposal: string): PriorReviewIssue {
  return {
    id,
    severity: 'friction',
    priority: 'P1',
    proposal,
    sourceReportPath: 'docs/reports/review-1-2026-04-01.md',
    sourceReportDate: '2026-04-01',
  };
}

describe('prior review regression', () => {
  it('loadPriorReviewIssues parses YAML finding blocks', async () => {
    const root = await makeTempDir('review-regression-load-');
    await writeText(
      path.join(root, 'docs', 'reports', 'review-1-2026-04-01.md'),
      [
        '# Review',
        '',
        '## Findings',
        '```yaml',
        '- id: review-script-wrapper',
        '  severity: friction',
        '  priority: P1',
        '  proposal: Add scripts/vibe-new.mjs wrapper.',
        '- id: review-open-loop',
        '  severity: structural',
        '  priority: P2',
        '  proposal: Track open review loops.',
        '```',
      ].join('\n'),
    );

    const issues = await loadPriorReviewIssues(root);

    assert.equal(issues.length, 2);
    assert.equal(issues[0]?.id, 'review-script-wrapper');
    assert.equal(issues[0]?.sourceReportDate, '2026-04-01');
    assert.equal(issues[1]?.severity, 'structural');
  });

  it('assessRegression classifies covered, partial, and open issues', async () => {
    const root = await makeTempDir('review-regression-assess-');
    await initGitRepo(root);
    await writeText(path.join(root, 'scripts', 'vibe-new.mjs'), '#!/usr/bin/env node\n');
    await execFile('git', ['add', 'scripts/vibe-new.mjs'], { cwd: root });
    await execFile('git', ['commit', '-m', 'fix: review-script-wrapper'], {
      cwd: root,
      env: process.env,
    });
    await writeText(
      path.join(root, 'docs', 'context', 'harness-gaps.md'),
      [
        '| id | symptom | covered_by | status |',
        '|---|---|---|---|',
        '| review-ledger | Track review ledger | scripts | covered |',
      ].join('\n'),
    );

    const statuses = await assessRegression(
      [
        fixtureIssue('review-script-wrapper', 'Add scripts/vibe-new.mjs wrapper.'),
        fixtureIssue('review-ledger', 'Track review ledger status.'),
        fixtureIssue('review-open', 'Document unknown future work.'),
      ],
      root,
    );

    assert.equal(statuses[0]?.status, 'covered');
    assert.equal(statuses[1]?.status, 'partial');
    assert.equal(statuses[2]?.status, 'open');
    assert.equal(statuses[0]?.evidence.some((entry) => entry.startsWith('git:')), true);
    assert.equal(statuses[0]?.evidence.includes('file:scripts/vibe-new.mjs'), true);
  });

  it('computeRegressionCoverage handles empty, all covered, and mixed statuses', () => {
    const issue = fixtureIssue('review-a', 'proposal');

    assert.deepEqual(computeRegressionCoverage([]), {
      covered: 0,
      partial: 0,
      open: 0,
      score: 0,
    });
    assert.deepEqual(
      computeRegressionCoverage([{ issue, status: 'covered', evidence: [] }]),
      {
        covered: 1,
        partial: 0,
        open: 0,
        score: 1,
      },
    );
    assert.deepEqual(
      computeRegressionCoverage([
        { issue, status: 'covered', evidence: [] },
        { issue, status: 'partial', evidence: [] },
        { issue, status: 'open', evidence: [] },
      ]),
      {
        covered: 1,
        partial: 1,
        open: 1,
        score: 1 / 3,
      },
    );
  });
});
