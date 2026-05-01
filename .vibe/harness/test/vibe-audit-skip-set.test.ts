import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, it } from 'node:test';

const tempDirs: string[] = [];
const scriptPath = path.resolve('.vibe', 'harness', 'scripts', 'vibe-audit-skip-set.mjs');

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

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function scaffoldRepo(root: string): Promise<void> {
  await writeJson(path.join(root, '.vibe', 'config.local.json'), {
    orchestrator: 'claude-opus',
    sprintRoles: {
      generator: 'codex',
    },
    userDirectives: {
      existingDirective: {
        enabled: true,
      },
    },
  });
  await mkdir(path.join(root, '.vibe', 'agent'), { recursive: true });
  await writeFile(path.join(root, '.vibe', 'agent', 'session-log.md'), '# Session Log\n\n## Entries\n', 'utf8');
}

async function runSkipSet(root: string, args: string[]): Promise<{ status: number; stdout: string; stderr: string }> {
  const originalArgv = process.argv;
  const originalCwd = process.cwd();
  const originalStdoutWrite = process.stdout.write;
  const originalStderrWrite = process.stderr.write;
  const originalExit = process.exit;
  let stdout = '';
  let stderr = '';
  let status = 0;

  process.argv = [process.execPath, scriptPath, ...args];
  process.chdir(root);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  process.exit = ((code?: string | number | null) => {
    status = typeof code === 'number' ? code : 0;
    throw new Error(`process.exit:${status}`);
  }) as typeof process.exit;

  try {
    await import(`${pathToFileURL(scriptPath).href}?case=${Date.now()}-${Math.random()}`);
  } catch (error) {
    if (!(error instanceof Error) || !error.message.startsWith('process.exit:')) {
      throw error;
    }
  } finally {
    process.argv = originalArgv;
    process.chdir(originalCwd);
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
    process.exit = originalExit;
  }

  return { status, stdout, stderr };
}

describe('vibe-audit-skip-set', () => {
  it('sets auditSkippedMode, preserves sibling config, and records one decision', async () => {
    const root = await makeTempDir('audit-skip-set-');
    await scaffoldRepo(root);
    const before = Date.now();

    const result = await runSkipSet(root, ['temporary skip during iteration-3 planning', '14']);
    const after = Date.now();
    const config = JSON.parse(
      await readFile(path.join(root, '.vibe', 'config.local.json'), 'utf8'),
    ) as {
      orchestrator: string;
      sprintRoles: { generator: string };
      userDirectives: {
        existingDirective: { enabled: boolean };
        auditSkippedMode: {
          enabled: boolean;
          reason: string;
          expiresAt: string;
          recordedAt: string;
        };
      };
    };
    const sessionLog = await readFile(path.join(root, '.vibe', 'agent', 'session-log.md'), 'utf8');
    const expiresAt = Date.parse(config.userDirectives.auditSkippedMode.expiresAt);
    const expected = before + 14 * 24 * 60 * 60 * 1000;

    assert.equal(result.status, 0, result.stderr);
    assert.equal(config.orchestrator, 'claude-opus');
    assert.equal(config.sprintRoles.generator, 'codex');
    assert.equal(config.userDirectives.existingDirective.enabled, true);
    assert.equal(config.userDirectives.auditSkippedMode.enabled, true);
    assert.equal(config.userDirectives.auditSkippedMode.reason, 'temporary skip during iteration-3 planning');
    assert.ok(Math.abs(expiresAt - expected) <= after - before + 60_000);
    assert.match(sessionLog, /\[decision\]\[audit-skipped-mode\] reason=temporary skip during iteration-3 planning/);
  });

  it('is idempotent for the same reason and duration', async () => {
    const root = await makeTempDir('audit-skip-idempotent-');
    await scaffoldRepo(root);

    const first = await runSkipSet(root, ['temporary skip during iteration-3 planning', '14']);
    const configAfterFirst = await readFile(path.join(root, '.vibe', 'config.local.json'), 'utf8');
    const logAfterFirst = await readFile(path.join(root, '.vibe', 'agent', 'session-log.md'), 'utf8');
    const second = await runSkipSet(root, ['temporary skip during iteration-3 planning', '14']);
    const configAfterSecond = await readFile(path.join(root, '.vibe', 'config.local.json'), 'utf8');
    const logAfterSecond = await readFile(path.join(root, '.vibe', 'agent', 'session-log.md'), 'utf8');

    assert.equal(first.status, 0, first.stderr);
    assert.equal(second.status, 0, second.stderr);
    assert.match(second.stdout, /already recorded/);
    assert.equal(configAfterSecond, configAfterFirst);
    assert.equal(logAfterSecond, logAfterFirst);
  });

  it('clears auditSkippedMode while keeping audit trail fields intact', async () => {
    const root = await makeTempDir('audit-skip-clear-');
    await scaffoldRepo(root);
    const setResult = await runSkipSet(root, ['temporary skip during iteration-3 planning', '14']);

    const clearResult = await runSkipSet(root, ['--clear']);
    const config = JSON.parse(
      await readFile(path.join(root, '.vibe', 'config.local.json'), 'utf8'),
    ) as {
      userDirectives: {
        auditSkippedMode: {
          enabled: boolean;
          reason: string;
          expiresAt: string;
          recordedAt: string;
        };
      };
    };
    const sessionLog = await readFile(path.join(root, '.vibe', 'agent', 'session-log.md'), 'utf8');

    assert.equal(setResult.status, 0, setResult.stderr);
    assert.equal(clearResult.status, 0, clearResult.stderr);
    assert.equal(config.userDirectives.auditSkippedMode.enabled, false);
    assert.equal(config.userDirectives.auditSkippedMode.reason, 'temporary skip during iteration-3 planning');
    assert.match(config.userDirectives.auditSkippedMode.expiresAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.match(config.userDirectives.auditSkippedMode.recordedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.match(sessionLog, /\[decision\]\[audit-skipped-mode-clear\]/);
  });
});
