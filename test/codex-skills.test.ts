import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';

async function listSkillNames(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const names: string[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const skillPath = path.join(root, entry.name, 'SKILL.md');
    try {
      await readFile(skillPath, 'utf8');
      names.push(entry.name);
    } catch {
      // Non-command support directories are allowed.
    }
  }

  return names.sort();
}

describe('Codex skill parity', () => {
  it('provides Codex wrappers for every shared Claude skill', async () => {
    const claudeRoot = path.join(process.cwd(), '.claude', 'skills');
    const codexRoot = path.join(process.cwd(), '.codex', 'skills');
    const skillNames = await listSkillNames(claudeRoot);

    assert.deepEqual(await listSkillNames(codexRoot), skillNames);

    for (const skillName of skillNames) {
      const wrapper = await readFile(path.join(codexRoot, skillName, 'SKILL.md'), 'utf8');
      assert.match(wrapper, new RegExp(`\\.claude/skills/${skillName}/SKILL\\.md`));
      assert.match(wrapper, /provider-neutral skill runbooks/);
    }
  });

  it('documents the guarded init command in the Codex vibe-init wrapper', async () => {
    const wrapper = await readFile(path.join(process.cwd(), '.codex', 'skills', 'vibe-init', 'SKILL.md'), 'utf8');

    assert.match(wrapper, /npm run vibe:init -- --from-agent-skill/);
  });

  it('documents the Codex Orchestrator checkpoint workflow in maintain-context', async () => {
    const shared = await readFile(path.join(process.cwd(), '.claude', 'skills', 'maintain-context', 'SKILL.md'), 'utf8');
    const wrapper = await readFile(path.join(process.cwd(), '.codex', 'skills', 'maintain-context', 'SKILL.md'), 'utf8');

    assert.match(shared, /Codex does not provide Claude Code's native `PreCompact`/);
    assert.match(shared, /npm run vibe:checkpoint/);
    assert.match(shared, /Generator agents normally do not need this workflow/);
    assert.match(wrapper, /Codex main Orchestrator sessions/);
  });
});
