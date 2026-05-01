import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

const tempDirs: string[] = [];
const migration110Path = path.resolve('.vibe', 'harness', 'migrations', '1.1.0.mjs');
const migration120Path = path.resolve('.vibe', 'harness', 'migrations', '1.2.0.mjs');
const preflightPath = path.resolve('.vibe', 'harness', 'scripts', 'vibe-preflight.mjs');
const manifestPath = path.resolve('.vibe', 'sync-manifest.json');
const harnessGapsPath = path.resolve('docs', 'context', 'harness-gaps.md');
const hasGit = checkHasGit();

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

function checkHasGit(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function readJson(filePath: string): Promise<Record<string, unknown>> {
  const parsed = JSON.parse(await readFile(filePath, 'utf8')) as unknown;
  assert.ok(isRecord(parsed), `expected ${filePath} to contain a JSON object`);
  return parsed;
}

function runCommand(command: string, args: string[], cwd?: string): string {
  return execFileSync(command, args, {
    cwd,
    encoding: 'utf8',
  }).trim();
}

function runNode(scriptPath: string, args: string[], cwd?: string): string {
  return runCommand('node', [scriptPath, ...args], cwd);
}

async function writeLegacyMigrationFixture(root: string): Promise<void> {
  await writeJson(path.join(root, '.vibe', 'config.json'), {
    harnessVersion: '1.0.0',
    harnessVersionInstalled: '1.0.0',
    sprintRoles: {
      planner: 'claude-opus',
      generator: 'codex',
      evaluator: 'claude-opus',
    },
    providers: {},
  });

  await writeJson(path.join(root, '.vibe', 'agent', 'sprint-status.json'), {
    $schema: './sprint-status.schema.json',
    schemaVersion: '0.1',
    project: {
      name: 'fixture',
      createdAt: '2026-04-01T00:00:00.000Z',
      runtime: 'node24',
      framework: 'none',
    },
    sprints: [],
    verificationCommands: [],
    sandboxNotes: [],
    handoff: {
      currentSprintId: 'idle',
      lastActionSummary: 'legacy',
      orchestratorContextBudget: 'low',
      preferencesActive: [],
      handoffDocPath: '.vibe/agent/handoff.md',
      updatedAt: '2026-04-02T00:00:00.000Z',
    },
  });
}

async function scaffoldBootstrapRepo(root: string): Promise<void> {
  await writeJson(path.join(root, 'package.json'), {
    name: 'meta-smoke-fixture',
    scripts: {
      test: 'node --version',
    },
  });

  await writeJson(path.join(root, '.vibe', 'config.json'), {
    harnessVersion: '1.2.0',
    harnessVersionInstalled: '1.2.0',
    sprintRoles: {
      planner: 'git',
      generator: 'git',
      evaluator: 'git',
    },
    providers: {
      git: {
        command: 'git',
      },
    },
  });

  await writeJson(path.join(root, '.vibe', 'agent', 'sprint-status.json'), {
    $schema: './sprint-status.schema.json',
    schemaVersion: '0.1',
    project: {
      name: 'meta-smoke-fixture',
      createdAt: '2026-04-16T00:00:00.000Z',
      runtime: 'node24',
      framework: 'none',
    },
    sprints: [],
    verificationCommands: [],
    sandboxNotes: [],
    pendingRisks: [],
    lastSprintScope: [],
    lastSprintScopeGlob: [],
    sprintsSinceLastAudit: 0,
    stateUpdatedAt: '2026-04-16T00:00:00.000Z',
    handoff: {
      currentSprintId: 'idle',
      lastActionSummary: 'bootstrap fixture',
      orchestratorContextBudget: 'low',
      preferencesActive: [],
      handoffDocPath: '.vibe/agent/handoff.md',
      updatedAt: '2026-04-16T00:00:00.000Z',
    },
  });

  await mkdir(path.join(root, 'docs', 'context'), { recursive: true });
  await writeFile(
    path.join(root, 'docs', 'context', 'product.md'),
    'This product document is intentionally long enough to satisfy the preflight bootstrap gate in integration tests.\n',
    'utf8',
  );
  await writeFile(path.join(root, '.vibe', 'agent', 'handoff.md'), '# handoff\nbootstrap fixture\n', 'utf8');
  await writeFile(path.join(root, '.vibe', 'agent', 'session-log.md'), '## Entries\n- bootstrap fixture\n', 'utf8');

  runCommand('git', ['init'], root);
  runCommand('git', ['config', 'user.name', 'Test User'], root);
  runCommand('git', ['config', 'user.email', 'test@example.com'], root);
  runCommand('git', ['add', '.'], root);
  runCommand('git', ['commit', '-m', 'init'], root);
}

describe('meta smoke', () => {
  it('migration chain runs sequentially and is idempotent', async () => {
    const root = await makeTempDir('meta-smoke-migrate-');
    await writeLegacyMigrationFixture(root);

    runNode(migration110Path, [root]);
    const first120 = runNode(migration120Path, [root]);

    const statusPath = path.join(root, '.vibe', 'agent', 'sprint-status.json');
    const configPath = path.join(root, '.vibe', 'config.json');
    const registryPath = path.join(root, '.vibe', 'model-registry.json');

    const status = await readJson(statusPath);
    const config = await readJson(configPath);

    assert.ok(Array.isArray(status.pendingRisks));
    assert.equal(existsSync(registryPath), true);
    assert.equal(config.harnessVersionInstalled, '1.2.0');
    assert.match(first120, /registry=created/);
    assert.match(first120, /version=updated to 1\.2\.0/);
    assert.match(first120, /sprintRoles=legacy-string-retained\(claude-opus\)/);

    const firstSnapshot = {
      status: await readFile(statusPath, 'utf8'),
      config: await readFile(configPath, 'utf8'),
      registry: await readFile(registryPath, 'utf8'),
    };

    runNode(migration110Path, [root]);
    const second120 = runNode(migration120Path, [root]);
    const secondSnapshot = {
      status: await readFile(statusPath, 'utf8'),
      config: await readFile(configPath, 'utf8'),
      registry: await readFile(registryPath, 'utf8'),
    };

    assert.match(second120, /registry=exists/);
    assert.match(second120, /version=already >= 1\.2\.0/);
    assert.deepEqual(secondSnapshot, firstSnapshot);
  });

  it('sync-manifest covers all M1-M9 deliverables', async () => {
    const manifest = await readJson(manifestPath);
    const migrations = manifest.migrations;
    assert.ok(isRecord(migrations));
    assert.equal(migrations['1.0.0'], '.vibe/harness/migrations/1.0.0.mjs');
    assert.equal(migrations['1.1.0'], '.vibe/harness/migrations/1.1.0.mjs');
    assert.equal(migrations['1.2.0'], '.vibe/harness/migrations/1.2.0.mjs');

    const files = manifest.files;
    assert.ok(isRecord(files));
    const harness = files.harness;
    assert.ok(Array.isArray(harness));

    const requiredEntries = [
      '.vibe/harness/src/**',
      '.vibe/harness/migrations/**',
      '.vibe/harness/scripts/**',
      'scripts/vibe-sync-bootstrap.mjs',
      '.vibe/model-registry.json',
      '.claude/skills/**',
      'docs/context/harness-gaps.md',
      '.claude/statusline.mjs',
      '.claude/statusline.sh',
      '.vibe/harness/tsconfig.harness.json',
    ];

    for (const entry of requiredEntries) {
      assert.equal(harness.includes(entry), true, `missing manifest entry: ${entry}`);
    }

    assert.equal(harness.length >= 30, true);
  });

  it(
    'preflight --bootstrap passes in clean tree',
    { skip: !hasGit },
    async () => {
      const root = await makeTempDir('meta-smoke-bootstrap-');
      await scaffoldBootstrapRepo(root);

      const result = spawnSync('node', [preflightPath, '--bootstrap'], {
        cwd: root,
        encoding: 'utf8',
      });

      assert.equal(result.status, 0, result.stderr || result.stdout);
    },
  );

  it('harness-gaps ledger has no open entries after M10', async () => {
    const lines = (await readFile(harnessGapsPath, 'utf8')).split(/\r?\n/);
    const rows = lines
      .filter((line) => line.startsWith('| gap-'))
      .map((line) => line.split('|').map((part) => part.trim()));

    const statuses = rows.map((parts) => ({
      id: parts[1] ?? '',
      status: parts[4] ?? '',
    }));

    const openRows = statuses.filter((row) => row.status === 'open');
    const partialRows = statuses.filter((row) => row.status === 'partial');

    assert.deepEqual(openRows, []);
    const allowedPartialIds = new Set([
      'gap-rule-only-in-md',
      'gap-harness-bloat-self-expansion',
      'gap-pass-only-product-identity',
    ]);
    assert.equal(partialRows.every((row) => allowedPartialIds.has(row.id)), true);
  });
});
