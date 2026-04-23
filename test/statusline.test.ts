import assert from 'node:assert/strict';
import { execFile as execFileCallback, execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const tempDirs: string[] = [];
const nodeScriptPath = path.resolve('.claude', 'statusline.mjs');
const bashScriptPath = path.resolve('.claude', 'statusline.sh');
const powershellScriptPath = path.resolve('.claude', 'statusline.ps1');
const settingsPath = path.resolve('.claude', 'settings.json');

function detectWorkingBash(): string | null {
  try {
    execFileSync('bash', ['--version'], { stdio: 'ignore' });
    if (process.platform === 'win32') {
      const uname = execFileSync('bash', ['-lc', 'uname -s'], { encoding: 'utf8' }).trim();
      if (!/^(MINGW|MSYS|CYGWIN)/.test(uname)) {
        return null;
      }
    }
    return 'bash';
  } catch {
    return null;
  }
}

const bashCommand = detectWorkingBash();

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

async function writeText(root: string, relativePath: string, value: string): Promise<void> {
  const filePath = path.join(root, relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, value, 'utf8');
}

async function writeStatus(root: string): Promise<void> {
  await writeJson(root, path.join('.vibe', 'agent', 'sprint-status.json'), {
    handoff: {
      currentSprintId: 'sprint-M9-statusline-permissions',
    },
    sprintsSinceLastAudit: 8,
    sprints: [
      { id: 'sprint-a', status: 'passed' },
      { id: 'sprint-b', status: 'failed' },
      { id: 'sprint-c', status: 'passed' },
    ],
    pendingRisks: [
      { id: 'risk-a', status: 'open' },
      { id: 'risk-b', status: 'resolved' },
      { id: 'risk-c', status: 'open' },
    ],
  });
}

async function runBashStatusline(root: string) {
  return execFile(bashCommand ?? 'bash', [bashScriptPath], {
    cwd: root,
    env: process.env,
  });
}

function runNodeStatusline(root: string, input?: string) {
  const result = spawnSync(process.execPath, [nodeScriptPath], {
    cwd: root,
    env: process.env,
    input,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  return result;
}

function runBashStatuslineBytes(root: string, input?: string, envOverride: NodeJS.ProcessEnv = {}): Buffer {
  const result = spawnSync(bashCommand ?? 'bash', [bashScriptPath], {
    cwd: root,
    env: { ...process.env, ...envOverride },
    input,
  });

  assert.equal(result.status, 0, result.stderr.toString('utf8'));
  assert.ok(Buffer.isBuffer(result.stdout));
  return result.stdout;
}

async function runPowerShellStatusline(root: string) {
  return execFile('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', powershellScriptPath], {
    cwd: root,
    env: process.env,
  });
}

describe('statusline wiring', () => {
  it('uses a cross-platform node command in Claude settings', async () => {
    const settings = JSON.parse(await import('node:fs/promises').then(({ readFile }) => readFile(settingsPath, 'utf8'))) as {
      statusLine?: { command?: string };
      hooks?: { SessionStart?: Array<{ hooks?: Array<{ command?: string }> }> };
    };

    assert.equal(settings.statusLine?.command, 'node .claude/statusline.mjs');
    assert.doesNotMatch(settings.statusLine?.command ?? '', /(^|\s)\w+=\S+\s/);
    assert.doesNotMatch(settings.statusLine?.command ?? '', /\/dev\/null|\|\| true/);
    assert.equal(settings.hooks?.SessionStart?.[0]?.hooks?.[0]?.command, 'node scripts/vibe-agent-session-start.mjs');
    assert.doesNotMatch(settings.hooks?.SessionStart?.[0]?.hooks?.[0]?.command ?? '', /\/dev\/null|\|\| true/);
  });
});

describe('statusline.mjs', () => {
  it('renders without requiring bash or PowerShell syntax', async () => {
    const root = await makeTempDir('statusline-node-');
    await writeStatus(root);

    const { stdout, stderr } = runNodeStatusline(root);

    assert.equal(stderr, '');
    assert.equal(stdout, '🎯 sprint-M9-statusline-permissions (2/3) | ⚠️ 2');
  });

  it('reads Claude usage from redirected stdin by default', async () => {
    const root = await makeTempDir('statusline-node-stdin-');
    await writeStatus(root);
    await writeText(
      root,
      'transcript.jsonl',
      JSON.stringify({ message: { usage: { input_tokens: 1500, output_tokens: 500 } } }),
    );

    const transcriptPath = path.join(root, 'transcript.jsonl');
    const { stdout } = runNodeStatusline(root, `${JSON.stringify({ transcript_path: transcriptPath })}\n`);

    assert.equal(stdout, '🎯 sprint-M9-statusline-permissions (2/3) | 💭 Claude 2K | ⚠️ 2');
  });
});

describe('statusline.sh', { skip: bashCommand === null }, () => {
  it('renders the normal output when sprint and token state files are present', async () => {
    const root = await makeTempDir('statusline-normal-');
    await writeStatus(root);
    await writeJson(root, path.join('.vibe', 'agent', 'tokens.json'), {
      updatedAt: '2026-04-16T00:00:00.000Z',
      cumulativeTokens: 12_345,
      elapsedSeconds: 120,
      sprintTokens: {
        'sprint-M9-statusline-permissions': 12_345,
      },
    });

    const { stdout } = await runBashStatusline(root);

    assert.match(stdout, /^🎯 .+ \(\d+\/\d+\) \| ⏱️ \d+m \| 🔧 Codex \d+K \| ⚠️ \d+$/u);
  });

  it('renders sprint info and risks when tokens.json is missing', async () => {
    const root = await makeTempDir('statusline-no-tokens-');
    await writeStatus(root);

    const { stdout } = await runBashStatusline(root);

    assert.equal(stdout, '🎯 sprint-M9-statusline-permissions (2/3) | ⚠️ 2');
    assert.doesNotMatch(stdout, /🔧|⏱️/u);
    assert.doesNotMatch(stdout, /💭/u);
  });

  it('prints nothing and exits successfully when sprint-status.json is missing', async () => {
    const root = await makeTempDir('statusline-no-status-');

    const { stdout, stderr } = await runBashStatusline(root);

    assert.equal(stdout, '');
    assert.equal(stderr, '');
  });

  it('renders zero tokens as 0K tok', async () => {
    const root = await makeTempDir('statusline-zero-tokens-');
    await writeStatus(root);
    await writeJson(root, path.join('.vibe', 'agent', 'tokens.json'), {
      updatedAt: '2026-04-16T00:00:00.000Z',
      cumulativeTokens: 0,
      elapsedSeconds: 0,
      sprintTokens: {},
    });

    const { stdout } = await runBashStatusline(root);

    assert.match(stdout, /\| 🔧 Codex 0K \|/u);
  });

  it('bash statusline sums Claude usage from stdin transcript_path', async () => {
    const root = await makeTempDir('statusline-claude-usage-');
    await writeStatus(root);
    await writeJson(root, path.join('.vibe', 'agent', 'tokens.json'), {
      updatedAt: '2026-04-16T00:00:00.000Z',
      cumulativeTokens: 4_999,
      elapsedSeconds: 180,
      sprintTokens: {},
    });
    await writeText(
      root,
      'transcript.jsonl',
      [
        JSON.stringify({ message: { usage: { input_tokens: 1200, output_tokens: 800 } } }),
        JSON.stringify({ usage: { input_tokens: 2500, output_tokens: 600 } }),
        JSON.stringify({ message: { usage: { input_tokens: 100, output_tokens: 0, cache_read_input_tokens: 900 } } }),
      ].join('\n'),
    );

    const transcriptPath = path.join(root, 'transcript.jsonl');
    const stdout = runBashStatuslineBytes(
      root,
      `${JSON.stringify({ transcript_path: transcriptPath })}\n`,
      { VIBE_STATUSLINE_READ_STDIN: '1' },
    ).toString('utf8');

    assert.equal(stdout, '🎯 sprint-M9-statusline-permissions (2/3) | ⏱️ 3m | 💭 Claude 5K | 🔧 Codex 4K | ⚠️ 2');
  });

  it('bash statusline emits expected emoji bytes', async () => {
    const root = await makeTempDir('statusline-emoji-bytes-');
    await writeStatus(root);
    const stdout = runBashStatuslineBytes(root);

    assert.ok(stdout.includes(Buffer.from('🎯', 'utf8')));
    assert.ok(stdout.includes(Buffer.from('⚠️', 'utf8')));
    assert.equal(stdout.toString('utf8'), '🎯 sprint-M9-statusline-permissions (2/3) | ⚠️ 2');
  });

  it('bash statusline shows version suffix when config has harnessVersionInstalled', async () => {
    const root = await makeTempDir('statusline-version-');
    await writeStatus(root);
    await writeJson(root, path.join('.vibe', 'config.json'), {
      harnessVersionInstalled: '1.3.1',
    });

    const { stdout } = await runBashStatusline(root);

    assert.equal(stdout, '🎯 sprint-M9-statusline-permissions (2/3) | ⚠️ 2 | 🏷️ v1.3.1');
  });

  it('bash statusline shows update hint when latestVersion > installed', async () => {
    const root = await makeTempDir('statusline-update-');
    await writeStatus(root);
    await writeJson(root, path.join('.vibe', 'config.json'), {
      harnessVersionInstalled: '1.3.1',
    });
    await writeJson(root, path.join('.vibe', 'sync-cache.json'), {
      latestVersion: '1.4.0',
    });

    const { stdout } = await runBashStatusline(root);

    assert.equal(stdout, '🎯 sprint-M9-statusline-permissions (2/3) | ⚠️ 2 | 🏷️ v1.3.1 \u26A0 v1.4.0 (/vibe-sync)');
  });

  it('bash statusline omits suffix when config missing', async () => {
    const root = await makeTempDir('statusline-missing-config-');
    await writeStatus(root);
    await writeJson(root, path.join('.vibe', 'sync-cache.json'), {
      latestVersion: '1.4.0',
    });

    const { stdout } = await runBashStatusline(root);

    assert.equal(stdout, '🎯 sprint-M9-statusline-permissions (2/3) | ⚠️ 2');
  });

  it('bash statusline omits suffix when config unparseable', async () => {
    const root = await makeTempDir('statusline-bad-config-');
    await writeStatus(root);
    await writeText(root, path.join('.vibe', 'config.json'), '{');
    await writeJson(root, path.join('.vibe', 'sync-cache.json'), {
      latestVersion: '1.4.0',
    });

    const { stdout } = await runBashStatusline(root);

    assert.equal(stdout, '🎯 sprint-M9-statusline-permissions (2/3) | ⚠️ 2');
  });
});

describe('statusline.ps1', { skip: process.platform !== 'win32' }, () => {
  it('matches the same one-line contract on Windows', async () => {
    const root = await makeTempDir('statusline-ps1-');
    await writeStatus(root);
    await writeJson(root, path.join('.vibe', 'agent', 'tokens.json'), {
      updatedAt: '2026-04-16T00:00:00.000Z',
      cumulativeTokens: 2_000,
      elapsedSeconds: 61,
      sprintTokens: {
        'sprint-M9-statusline-permissions': 2_000,
      },
    });

    const { stdout } = await runPowerShellStatusline(root);

    assert.equal(stdout, '🎯 sprint-M9-statusline-permissions (2/3) | ⏱️ 1m | 🔧 Codex 2K | ⚠️ 2');
  });
});
