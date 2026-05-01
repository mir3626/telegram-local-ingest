import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { copyFile, mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, it } from 'node:test';

const execFile = promisify(execFileCallback);
const tempDirs: string[] = [];
const repoRoot = path.resolve();

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

async function copyRelativeFile(root: string, relativePath: string): Promise<void> {
  const source = path.join(repoRoot, relativePath);
  const target = path.join(root, relativePath);
  await mkdir(path.dirname(target), { recursive: true });
  await copyFile(source, target);
}

async function scaffoldInterviewProject(root: string): Promise<void> {
  for (const relativePath of [
    '.vibe/harness/scripts/vibe-interview.mjs',
    '.vibe/harness/scripts/vibe-resolve-model.mjs',
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
  return execFile('node', [path.join(root, '.vibe', 'harness', 'scripts', 'vibe-interview.mjs'), ...args], { cwd: root });
}

async function readActiveState(root: string) {
  const sessionId = (await readFile(path.join(root, '.vibe', 'interview-log', '.active'), 'utf8')).trim();
  const sessionPath = path.join(root, '.vibe', 'interview-log', `${sessionId}.json`);
  const raw = JSON.parse(await readFile(sessionPath, 'utf8')) as Record<string, unknown>;
  return { sessionId, sessionPath, raw };
}

describe('vibe-interview cli', () => {
  it('--init creates a session file and .active pointer', async () => {
    const root = await makeTempDir('interview-cli-init-');
    await scaffoldInterviewProject(root);

    const { stdout } = await runCli(root, ['--init', '--prompt', 'smoke']);
    const payload = JSON.parse(stdout) as { phase: string };
    const activePath = path.join(root, '.vibe', 'interview-log', '.active');

    assert.equal(payload.phase, 'domain-inference');
    const sessionId = (await readFile(activePath, 'utf8')).trim();
    assert.match(sessionId, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(
      path.basename(path.join(root, '.vibe', 'interview-log', `${sessionId}.json`)),
      `${sessionId}.json`,
    );
  });

  it('--init twice refuses the second session while another one is active', async () => {
    const root = await makeTempDir('interview-cli-init-twice-');
    await scaffoldInterviewProject(root);

    await runCli(root, ['--init', '--prompt', 'smoke']);

    await assert.rejects(
      runCli(root, ['--init', '--prompt', 'again']),
      /existing active session; run --abort first/,
    );
  });

  it('--set-domain without an active session exits with the expected error', async () => {
    const root = await makeTempDir('interview-cli-no-active-');
    await scaffoldInterviewProject(root);

    await assert.rejects(
      runCli(root, ['--set-domain', '--domain', 'CLI tooling']),
      /no active interview session \(run --init first\)/,
    );
  });

  it('--continue and --record mutate state and append coverage', async () => {
    const root = await makeTempDir('interview-cli-record-');
    await scaffoldInterviewProject(root);

    await runCli(root, ['--init', '--prompt', 'cross-platform CLI for config management']);
    const setDomain = JSON.parse(
      (await runCli(root, ['--set-domain', '--domain', 'Cross-platform CLI configuration tooling']))
        .stdout,
    ) as {
      dimension: { id: string; subFields: string[] };
      roundNumber: number;
    };

    await runCli(root, ['--continue', '--answer', 'Need predictable config precedence and Windows-safe quoting.']);

    const attribution =
      setDomain.dimension.subFields.length === 0
        ? {
            attribution: {
              free_form: { value: 'config precedence and quoting depth', confidence: 1, deferred: false },
            },
            cross_dimension_signals: [],
            rationale: 'direct answer',
          }
        : {
            attribution: Object.fromEntries(
              setDomain.dimension.subFields.map((subFieldId) => [
                subFieldId,
                { value: `${subFieldId} captured`, confidence: 1, deferred: false },
              ]),
            ),
            cross_dimension_signals: [{ dimensionId: 'constraints', note: 'Windows quoting is a hard compatibility constraint.' }],
            rationale: 'covered requested slots',
          };

    await runCli(root, ['--record', '--attribution', JSON.stringify(attribution)]);
    const { raw } = await readActiveState(root);
    const coverage = raw.coverage as Record<string, { ratio: number }>;
    const rounds = raw.rounds as Array<Record<string, unknown>>;

    assert.equal(rounds.length, 1);
    assert.equal((rounds[0]?.roundNumber as number) ?? 0, setDomain.roundNumber);
    assert.ok((coverage[setDomain.dimension.id]?.ratio ?? 0) > 0);
  });

  it('--record can terminate on the last uncovered required dimension and returns seedForProductMd', async () => {
    const root = await makeTempDir('interview-cli-done-');
    await scaffoldInterviewProject(root);

    await runCli(root, ['--init', '--prompt', 'legal-tech matching for lease renewal']);
    const { sessionPath, raw } = await readActiveState(root);
    const state = raw as {
      dimensions: Array<{ id: string; subFields: string[]; required: boolean }>;
      coverage: Record<string, { ratio: number; subFields: Record<string, { value: string; confidence: number; deferred: boolean }> }>;
    };

    for (const dimension of state.dimensions) {
      if (!dimension.required || dimension.id === 'domain_specifics') {
        continue;
      }

      state.coverage[dimension.id] = {
        ratio: 1,
        subFields:
          dimension.subFields.length === 0
            ? {
                free_form: { value: 'covered', confidence: 1, deferred: false },
              }
            : Object.fromEntries(
                dimension.subFields.map((subFieldId) => [
                  subFieldId,
                  { value: `${subFieldId} done`, confidence: 1, deferred: false },
                ]),
              ),
      };
    }

    await writeFile(sessionPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');

    await runCli(root, ['--set-domain', '--domain', 'Korean real-estate renewal routing']);
    await runCli(root, ['--continue', '--answer', '행정사와 변호사 경계, 갱신거절 시점, 특약 조항이 중요합니다.']);
    const { stdout } = await runCli(root, [
      '--record',
      '--attribution',
      JSON.stringify({
        attribution: {
          free_form: {
            value: '행정사 vs 변호사 권한 경계와 갱신거절 통지, 특약 검토가 핵심이다.',
            confidence: 1,
            deferred: false,
          },
        },
        cross_dimension_signals: [],
        rationale: 'last required slot closed',
      }),
    ]);

    const payload = JSON.parse(stdout) as { phase: string; seedForProductMd: string };
    assert.equal(payload.phase, 'done');
    assert.match(payload.seedForProductMd, /Phase 3 답변 기록 \(native interview\)/);
  });
});
