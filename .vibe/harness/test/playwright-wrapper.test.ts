import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, it } from 'node:test';

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];

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

describe('vibe Playwright wrapper', () => {
  it('prints install guidance when @playwright/test is unavailable from the project root', async () => {
    const root = await makeTempDir('vibe-playwright-missing-');
    const scriptPath = path.join(process.cwd(), '.vibe', 'harness', 'scripts', 'vibe-playwright-test.mjs');

    await assert.rejects(
      execFileAsync(process.execPath, [scriptPath, '--help'], { cwd: root }),
      (error: unknown) => {
        const actual = error as { code?: number; stderr?: string };
        assert.equal(actual.code, 1);
        assert.match(actual.stderr ?? '', /@playwright\/test is not installed/);
        assert.match(actual.stderr ?? '', /npm install -D @playwright\/test/);
        assert.match(actual.stderr ?? '', /npx playwright install --with-deps chromium/);
        return true;
      },
    );
  });

  it('delegates to the locally installed Playwright CLI', async () => {
    const scriptPath = path.join(process.cwd(), '.vibe', 'harness', 'scripts', 'vibe-playwright-test.mjs');
    const result = await execFileAsync(process.execPath, [scriptPath, '--version'], {
      cwd: process.cwd(),
    });

    assert.match(result.stdout.trim(), /^Version \d+\.\d+\.\d+/);
  });

  it('defaults to the Playwright test command for test options', async () => {
    const scriptPath = path.join(process.cwd(), '.vibe', 'harness', 'scripts', 'vibe-playwright-test.mjs');
    const result = await execFileAsync(process.execPath, [scriptPath, '--list'], {
      cwd: process.cwd(),
    });

    assert.match(result.stdout, /Total: \d+ tests? in \d+ files?/);
  });
});
