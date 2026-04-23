import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';
import {
  AGENT_INIT_FLAG,
  isAgentSkillInvocation,
  renderDirectInitGuardMessage,
} from '../src/commands/init.js';

const initPath = path.resolve('src', 'commands', 'init.ts');
const tsxLoader = pathToFileURL(path.resolve('node_modules', 'tsx', 'dist', 'loader.mjs')).href;

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
});
