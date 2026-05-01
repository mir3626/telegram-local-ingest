import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { commandExists, resolveGitBashPath, runCommand } from '../src/lib/shell.js';

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

describe('shell command runner', () => {
  it('does not resolve Windows Git Bash through the WSL app launcher', { skip: process.platform !== 'win32' }, () => {
    const gitBash = resolveGitBashPath();
    assert.ok(gitBash);
    assert.doesNotMatch(gitBash, /\\WindowsApps\\bash\.exe$/i);
  });

  it('runs explicit shell scripts without relying on bare bash', async () => {
    if (process.platform === 'win32' && !resolveGitBashPath()) {
      return;
    }

    const root = await makeTempDir('vibe-shell-');
    const scriptPath = path.join(root, 'probe.sh');
    await writeFile(scriptPath, '#!/usr/bin/env bash\nprintf "arg=%s\\n" "$1"\n', 'utf8');

    if (process.platform !== 'win32') {
      await chmod(scriptPath, 0o755);
    }

    assert.equal(await commandExists('./probe.sh', { cwd: root }), true);

    const result = await runCommand('./probe.sh', ['hello world'], { cwd: root });

    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout.trim(), 'arg=hello world');
  });

  it('checks provider commands with the supplied cwd and PATH env', async () => {
    const root = await makeTempDir('vibe-shell-provider-path-');
    const binDir = path.join(root, 'bin');
    await mkdir(binDir, { recursive: true });

    const commandName = 'vibe-provider-probe';
    const commandPath =
      process.platform === 'win32'
        ? path.join(binDir, `${commandName}.cmd`)
        : path.join(binDir, commandName);
    const body =
      process.platform === 'win32'
        ? '@echo off\r\necho provider-ok\r\n'
        : '#!/usr/bin/env sh\necho provider-ok\n';
    await writeFile(commandPath, body, 'utf8');
    if (process.platform !== 'win32') {
      await chmod(commandPath, 0o755);
    }

    const env = {
      PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
    };

    assert.equal(await commandExists(commandName, { cwd: root, env }), true);

    const result = await runCommand(commandName, [], { cwd: root, env });

    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout.trim(), 'provider-ok');
  });
});
