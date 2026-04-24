import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';
import {
  AGENT_INIT_FLAG,
  isAgentSkillInvocation,
  renderDirectInitGuardMessage,
} from '../src/commands/init.js';

const initPath = path.resolve('src', 'commands', 'init.ts');
const tsxLoader = pathToFileURL(path.resolve('node_modules', 'tsx', 'dist', 'loader.mjs')).href;
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

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

describe('vibe:init agent-skill guard', () => {
  it('requires an explicit agent-skill marker for mechanical init', () => {
    assert.equal(isAgentSkillInvocation([]), false);
    assert.equal(isAgentSkillInvocation([AGENT_INIT_FLAG]), true);
    assert.equal(isAgentSkillInvocation([], { VIBE_INIT_AGENT: '1' }), true);
    assert.equal(isAgentSkillInvocation([], { VIBE_INIT_AGENT: 'true' }), true);
  });

  it('prints direct-shell guidance and exits before touching project files', () => {
    const result = spawnSync(process.execPath, ['--import', tsxLoader, initPath], {
      cwd: process.cwd(),
      env: { ...process.env, VIBE_INIT_AGENT: '' },
      input: '',
      encoding: 'utf8',
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /agent-skill bootstrap step/);
    assert.match(result.stderr, /Claude Code: \/vibe-init/);
    assert.match(result.stderr, /Codex: ask Codex to run the vibe-init workflow/);
    assert.match(result.stderr, /npm run vibe:init -- --from-agent-skill/);
  });

  it('keeps the guard message stable enough for shell users', () => {
    assert.match(renderDirectInitGuardMessage(), /not a direct shell entrypoint/);
  });

  it('agent-skill init resets copied template sprint state to an empty project state', async () => {
    const root = await makeTempDir('vibe-init-template-state-');
    await writeJson(path.join(root, '.vibe', 'config.local.example.json'), {
      orchestrator: 'claude-opus',
      sprintRoles: { planner: 'claude-opus', generator: 'codex', evaluator: 'claude-opus' },
      sprint: { unit: 'feature', subAgentPerRole: true, freshContextPerSprint: true },
      providers: {},
    });
    await writeFile(path.join(root, '.env.example'), 'TOKEN=\n', 'utf8');
    await writeJson(path.join(root, '.vibe', 'agent', 'sprint-status.json'), {
      schemaVersion: '0.1',
      project: { name: 'vibe-doctor', createdAt: '2026-04-01T00:00:00.000Z' },
      sprints: [{ id: 'sprint-old', name: 'sprint-old', status: 'passed' }],
      verificationCommands: [],
      sprintsSinceLastAudit: 5,
    });

    const result = spawnSync(process.execPath, ['--import', tsxLoader, initPath, AGENT_INIT_FLAG], {
      cwd: root,
      env: { ...process.env, VIBE_INIT_AGENT: '' },
      input: '',
      encoding: 'utf8',
    });

    assert.equal(result.status, 0, result.stderr);
    const status = JSON.parse(
      await readFile(path.join(root, '.vibe', 'agent', 'sprint-status.json'), 'utf8'),
    ) as { project?: { name?: string }; sprints?: unknown[]; sprintsSinceLastAudit?: number };
    assert.equal(status.project?.name, path.basename(root));
    assert.deepEqual(status.sprints, []);
    assert.equal(status.sprintsSinceLastAudit, 0);
  });
});
