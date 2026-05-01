import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, it } from 'node:test';

const tempDirs: string[] = [];
const scriptPath = path.resolve('.vibe', 'harness', 'scripts', 'vibe-rule-audit.mjs');

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

async function writeText(filePath: string, value: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, value, 'utf8');
}

async function runRuleAudit(args: string[] = []): Promise<{ status: number; stdout: string; stderr: string }> {
  const originalArgv = process.argv;
  const originalStdoutWrite = process.stdout.write;
  const originalStderrWrite = process.stderr.write;
  let stdout = '';
  let stderr = '';

  process.argv = [process.execPath, scriptPath, ...args];
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += String(chunk);
    return true;
  }) as typeof process.stderr.write;

  try {
    await import(`${pathToFileURL(scriptPath).href}?case=${Date.now()}-${Math.random()}`);
    return { status: 0, stdout, stderr };
  } finally {
    process.argv = originalArgv;
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
  }
}

describe('vibe-rule-audit', () => {
  it('emits JSON with covered and uncovered rule candidates', async () => {
    const root = await makeTempDir('rule-audit-json-');
    const claudePath = path.join(root, 'CLAUDE.md');
    const gapsPath = path.join(root, 'harness-gaps.md');
    await writeText(
      claudePath,
      [
        '# CLAUDE',
        'This line MUST mention gap-covered-rule.',
        'This line MUST NOT rely on undocumented process.',
        '```',
        'NEVER count this fenced line.',
        '```',
      ].join('\n'),
    );
    await writeText(
      gapsPath,
      [
        '| id | symptom | covered_by | status | script-gate | migration-deadline |',
        '|---|---|---|---|---|---|',
        '| gap-covered-rule | sample | `script` | covered | covered | — |',
      ].join('\n'),
    );

    const result = await runRuleAudit([
      '--format=json',
      `--claude-md=${claudePath}`,
      `--gaps=${gapsPath}`,
    ]);
    const parsed = JSON.parse(result.stdout) as {
      summary: { total: number; covered: number; uncovered: number; disposed: number; undisposed: number };
      rules: Array<{ text: string; covered: boolean; coveredBy: string | null; disposition: string; disposedBy: string | null }>;
    };

    assert.equal(result.status, 0, result.stderr);
    assert.equal(parsed.summary.total, 2);
    assert.equal(parsed.summary.covered, 1);
    assert.equal(parsed.summary.uncovered, 1);
    assert.equal(parsed.summary.disposed, 1);
    assert.equal(parsed.summary.undisposed, 1);
    assert.equal(parsed.rules[0]?.coveredBy, 'gap-covered-rule');
    assert.equal(parsed.rules[0]?.disposition, 'covered');
    assert.equal(parsed.rules[1]?.covered, false);
    assert.equal(parsed.rules[1]?.disposition, 'undisposed');
    assert.equal(parsed.rules.some((rule) => rule.text.includes('fenced')), false);
  });

  it('renders both text sections and explicit empty covered output', async () => {
    const root = await makeTempDir('rule-audit-text-');
    const claudePath = path.join(root, 'CLAUDE.md');
    const gapsPath = path.join(root, 'harness-gaps.md');
    await writeText(claudePath, 'Operators MUST record decisions.\n');
    await writeText(
      gapsPath,
      [
        '| id | symptom | covered_by | status | script-gate | migration-deadline |',
        '|---|---|---|---|---|---|',
        '| gap-open-rule | sample | `script` | open | pending | — |',
      ].join('\n'),
    );

    const result = await runRuleAudit([`--claude-md=${claudePath}`, `--gaps=${gapsPath}`]);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /## Uncovered \(candidates for next Sprint\)/);
    assert.match(result.stdout, /## Undisposed \(needs explicit coverage disposition\)/);
    assert.match(result.stdout, /## Covered/);
    assert.match(result.stdout, /## Covered\n\(none\)/);
  });

  it('distinguishes pending dispositions from undisposed rules', async () => {
    const root = await makeTempDir('rule-audit-disposition-');
    const claudePath = path.join(root, 'CLAUDE.md');
    const gapsPath = path.join(root, 'harness-gaps.md');
    await writeText(
      claudePath,
      [
        'Rule MUST mention gap-pending-rule.',
        'Rule MUST mention gap-manual-rule.',
        'Rule MUST mention nothing.',
      ].join('\n'),
    );
    await writeText(
      gapsPath,
      [
        '| id | symptom | covered_by | status | script-gate | migration-deadline |',
        '|---|---|---|---|---|---|',
        '| gap-pending-rule | sample | `script` | open | pending | +1 sprint |',
        '| gap-manual-rule | sample | `rubric` | under-review | manual-review | — |',
      ].join('\n'),
    );

    const result = await runRuleAudit([
      '--format=json',
      `--claude-md=${claudePath}`,
      `--gaps=${gapsPath}`,
    ]);
    const parsed = JSON.parse(result.stdout) as {
      summary: { byDisposition: Record<string, number>; disposed: number; undisposed: number };
      rules: Array<{ disposition: string; disposedBy: string | null }>;
    };

    assert.equal(result.status, 0, result.stderr);
    assert.equal(parsed.summary.disposed, 2);
    assert.equal(parsed.summary.undisposed, 1);
    assert.equal(parsed.summary.byDisposition.pending, 1);
    assert.equal(parsed.summary.byDisposition['manual-review'], 1);
    assert.deepEqual(parsed.rules.map((rule) => rule.disposition), ['pending', 'manual-review', 'undisposed']);
  });

  it('can fail as a gate when undisposed rules remain', async () => {
    const root = await makeTempDir('rule-audit-fail-');
    const claudePath = path.join(root, 'CLAUDE.md');
    const gapsPath = path.join(root, 'harness-gaps.md');
    await writeText(claudePath, 'Rule MUST be mapped.\n');
    await writeText(gapsPath, '| id | symptom | covered_by | status | script-gate | migration-deadline |\n');

    const result = spawnSync(process.execPath, [
      scriptPath,
      '--fail-on-undisposed',
      `--claude-md=${claudePath}`,
      `--gaps=${gapsPath}`,
    ], { encoding: 'utf8' });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /undisposed rules: 1/);
  });

  it('scans transcripts and aggregates failure/drift tag counts', async () => {
    const root = await makeTempDir('rule-audit-scan-');
    const repoA = path.join(root, 'dogfood-a');
    const repoB = path.join(root, 'dogfood-b');
    await writeText(path.join(repoA, '.vibe/agent/session-log.md'), ['- 2026-01-01T00:00:00Z [failure] alpha occurred', '- 2026-01-01T00:00:01Z [drift-observed] beta drift'].join('\n'));
    await writeText(path.join(repoB, '.vibe/agent/session-log.md'), '- 2026-01-01T00:00:02Z [decision] gamma chosen\n');

    const result = await runRuleAudit([`--scan-transcripts=${repoA},${repoB}`, '--format=json']);
    const parsed = JSON.parse(result.stdout) as { summary: { tiered: boolean; bySource: Record<string, { present: boolean; failure: number; 'drift-observed': number; decision: number }> } };

    assert.equal(result.status, 0, result.stderr);
    assert.equal(parsed.summary.tiered, true);
    assert.equal(parsed.summary.bySource[repoA]?.present, true);
    assert.equal(parsed.summary.bySource[repoA]?.failure, 1);
    assert.equal(parsed.summary.bySource[repoA]?.['drift-observed'], 1);
    assert.equal(parsed.summary.bySource[repoB]?.decision, 1);
  });

  it('gracefully skips missing transcript sources', async () => {
    const root = await makeTempDir('rule-audit-missing-');
    const present = path.join(root, 'present');
    const missing = path.join(root, 'missing');
    await writeText(path.join(present, '.vibe/agent/session-log.md'), '- 2026-01-01T00:00:00Z [failure] alpha occurred\n');

    const result = await runRuleAudit([`--scan-transcripts=${present},${missing}`, '--format=json']);
    const parsed = JSON.parse(result.stdout) as { summary: { bySource: Record<string, { present: boolean }> } };

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /warning: scan target missing/);
    assert.equal(parsed.summary.bySource[present]?.present, true);
    assert.equal(parsed.summary.bySource[missing]?.present, false);
  });

  it('classifies rule clusters into S/A/B/C tiers from evidence', async () => {
    const root = await makeTempDir('rule-audit-tier-');
    const repo = path.join(root, 'dogfood');
    const claudePath = path.join(root, 'CLAUDE.md');
    const gapsPath = path.join(root, 'harness-gaps.md');
    await writeText(claudePath, ['## Alpha high', 'Alpha beacon MUST stay stable.', '## Beta low', 'Beta lowrisk MUST be recorded.', '## Gamma gap', 'Gamma MUST mention gap-covered-rule.', '## Delta script', 'Delta MUST run `scripts/vibe-sample.mjs`.', '## Epsilon none', 'Epsilon lonely MUST remain.'].join('\n'));
    await writeText(gapsPath, ['| id | symptom | covered_by | status | script-gate | migration-deadline |', '|---|---|---|---|---|---|', '| gap-covered-rule | sample | `script` | covered | covered | — |'].join('\n'));
    await writeText(path.join(repo, '.vibe/agent/session-log.md'), ['- 2026-01-01T00:00:00Z [failure] beacon failed', '- 2026-01-01T00:00:01Z [failure] beacon failed again', '- 2026-01-01T00:00:02Z [drift-observed] beacon drift'].join('\n'));

    const result = await runRuleAudit([`--claude-md=${claudePath}`, `--gaps=${gapsPath}`, `--scan-transcripts=${repo}`, '--format=json']);
    const parsed = JSON.parse(result.stdout) as { summary: { byTier: Record<string, number> }; rules: Array<{ cluster: { id: string; tier: string; recommendedAction: string } }> };
    const byId = new Map(parsed.rules.map((rule) => [rule.cluster.id, rule.cluster]));

    assert.equal(result.status, 0, result.stderr);
    assert.ok((parsed.summary.byTier.S ?? 0) >= 1);
    assert.ok((parsed.summary.byTier.C ?? 0) >= 1);
    assert.equal(byId.get('alpha-high')?.recommendedAction, 'keep-script');
    assert.equal(byId.get('epsilon-none')?.recommendedAction, 'delete-md-and-script');
  });
});
