import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
describe('sprint-planner contract', () => {
  it('sprint-planner contract includes component-integration checklist', async () => {
    const content = await readFile('.claude/agents/sprint-planner.md', 'utf8');
    const groups = [/toaster|toastprovider|global.?state provider/i, /null.?safe|optional chaining|early.?return guard|\?\./i, /optimistic|rollback/i];
    assert.ok(groups.filter((pattern) => pattern.test(content)).length >= 2);
  });
});
