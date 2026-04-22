import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const tempDirs: string[] = [];
const sprintModePath = path.resolve('scripts', 'vibe-sprint-mode.mjs');

const presetRules = [
  'Bash(npm install:*)',
  'Bash(npx tsc:*)',
  'Bash(git status:*)',
];

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

async function writeJson(root: string, relativePath: string, value: unknown): Promise<void> {
  const filePath = path.join(root, relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function readJson<T>(root: string, relativePath: string): Promise<T> {
  return JSON.parse(await readFile(path.join(root, relativePath), 'utf8')) as T;
}

async function scaffoldPreset(root: string): Promise<void> {
  await writeJson(root, path.join('.vibe', 'settings-presets', 'agent-delegation.json'), {
    presetName: 'agent-delegation',
    presetVersion: '1.0.0',
    description: 'test preset',
    rules: presetRules,
  });
}

async function runSprintMode(root: string, command: 'on' | 'off' | 'status') {
  return execFile(process.execPath, [sprintModePath, command], {
    cwd: root,
    env: process.env,
  });
}

describe('vibe-sprint-mode', () => {
  it('creates settings.local.json from scratch on on', async () => {
    const root = await makeTempDir('sprint-mode-fresh-');
    await scaffoldPreset(root);

    const { stdout } = await runSprintMode(root, 'on');
    const settings = await readJson<{ permissions: { allow: string[] } }>(
      root,
      path.join('.claude', 'settings.local.json'),
    );

    assert.match(stdout, /\[vibe-sprint-mode\] ON -- 3 preset rules merged \(3 new\)\. Total allow rules: 3/);
    assert.deepEqual(settings.permissions.allow, presetRules);
  });

  it('preserves existing custom rules when enabling the preset', async () => {
    const root = await makeTempDir('sprint-mode-custom-');
    await scaffoldPreset(root);
    await writeJson(root, path.join('.claude', 'settings.local.json'), {
      permissions: {
        allow: ['Bash(custom:*)'],
      },
      hooks: {
        postAction: ['echo ok'],
      },
    });

    await runSprintMode(root, 'on');
    const settings = await readJson<{
      permissions: { allow: string[] };
      hooks: { postAction: string[] };
    }>(root, path.join('.claude', 'settings.local.json'));

    assert.deepEqual(settings.permissions.allow, ['Bash(custom:*)', ...presetRules]);
    assert.deepEqual(settings.hooks.postAction, ['echo ok']);
  });

  it('is idempotent when on is run twice', async () => {
    const root = await makeTempDir('sprint-mode-idempotent-');
    await scaffoldPreset(root);

    await runSprintMode(root, 'on');
    const first = await readJson<{ permissions: { allow: string[] } }>(
      root,
      path.join('.claude', 'settings.local.json'),
    );
    await runSprintMode(root, 'on');
    const second = await readJson<{ permissions: { allow: string[] } }>(
      root,
      path.join('.claude', 'settings.local.json'),
    );

    assert.deepEqual(second.permissions.allow, first.permissions.allow);
    assert.equal(new Set(second.permissions.allow).size, second.permissions.allow.length);
  });

  it('removes only preset rules on off', async () => {
    const root = await makeTempDir('sprint-mode-off-');
    await scaffoldPreset(root);
    await writeJson(root, path.join('.claude', 'settings.local.json'), {
      permissions: {
        allow: ['Bash(custom:*)', ...presetRules, 'Bash(extra:*)'],
      },
      deny: ['Bash(rm -rf:*)'],
    });

    const { stdout } = await runSprintMode(root, 'off');
    const settings = await readJson<{
      permissions: { allow: string[] };
      deny: string[];
    }>(root, path.join('.claude', 'settings.local.json'));

    assert.match(stdout, /\[vibe-sprint-mode\] OFF -- 3 preset rules removed\. Remaining allow rules: 2/);
    assert.deepEqual(settings.permissions.allow, ['Bash(custom:*)', 'Bash(extra:*)']);
    assert.deepEqual(settings.deny, ['Bash(rm -rf:*)']);
  });

  it('exits successfully when off is run without settings.local.json', async () => {
    const root = await makeTempDir('sprint-mode-off-missing-');
    await scaffoldPreset(root);

    const { stdout } = await runSprintMode(root, 'off');

    assert.equal(stdout.trim(), '[vibe-sprint-mode] OFF -- nothing to remove');
  });

  it('reports the active preset rule count in status mode', async () => {
    const root = await makeTempDir('sprint-mode-status-');
    await scaffoldPreset(root);
    await runSprintMode(root, 'on');

    const { stdout } = await runSprintMode(root, 'status');

    assert.equal(stdout.trim(), '[vibe-sprint-mode] ON -- 3/3 preset rules active');
  });
});
