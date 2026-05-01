import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
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

async function scaffoldSessionLog(root: string): Promise<void> {
  await mkdir(path.join(root, '.vibe', 'agent'), { recursive: true });
  await writeFile(path.join(root, '.vibe', 'agent', 'session-log.md'), '# Session Log\n\n## Entries\n', 'utf8');
}

function runSkipSet(root: string, args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: root,
    encoding: 'utf8',
  });

  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

describe('vibe-audit-skip-set config.local bootstrap', () => {
  it('creates a minimal config.local.json skeleton and continues setting auditSkippedMode', async () => {
    const root = await makeTempDir('audit-skip-bootstrap-');
    await scaffoldSessionLog(root);

    const result = runSkipSet(root, ['proto reason', '7']);
    const configPath = path.join(root, '.vibe', 'config.local.json');
    const config = JSON.parse(await readFile(configPath, 'utf8')) as {
      userDirectives?: {
        auditSkippedMode?: {
          enabled?: boolean;
          reason?: string;
        };
      };
    };
    const sessionLog = await readFile(path.join(root, '.vibe', 'agent', 'session-log.md'), 'utf8');

    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(configPath), true);
    assert.equal(config.userDirectives?.auditSkippedMode?.enabled, true);
    assert.equal(config.userDirectives?.auditSkippedMode?.reason, 'proto reason');
    assert.match(
      sessionLog,
      /\[decision\]\[audit-skipped-mode\] reason=proto reason .* durationDays=7/,
    );
    assert.match(result.stdout, /created \.vibe\/config\.local\.json with default skeleton/);
  });

  it('uses an existing config.local.json without printing the skeleton bootstrap message', async () => {
    const root = await makeTempDir('audit-skip-existing-config-');
    await scaffoldSessionLog(root);
    await writeFile(path.join(root, '.vibe', 'config.local.json'), '{}\n', 'utf8');

    const result = runSkipSet(root, ['existing config reason', '3']);
    const config = JSON.parse(
      await readFile(path.join(root, '.vibe', 'config.local.json'), 'utf8'),
    ) as {
      userDirectives?: {
        auditSkippedMode?: {
          enabled?: boolean;
          reason?: string;
        };
      };
    };

    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /created \.vibe\/config\.local\.json/);
    assert.equal(config.userDirectives?.auditSkippedMode?.enabled, true);
    assert.equal(config.userDirectives?.auditSkippedMode?.reason, 'existing config reason');
  });
});
