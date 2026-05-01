import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { it } from 'node:test';
const scriptPath = path.resolve('.vibe', 'harness', 'scripts', 'vibe-sprint-commit.mjs');
function w(filePath: string, value: string): void { mkdirSync(path.dirname(filePath), { recursive: true }); writeFileSync(filePath, value, 'utf8'); }
function git(root: string, args: string[]): string { return execFileSync('git', args, { cwd: root, encoding: 'utf8' }); }
function scaffold(root: string): void {
  const status = { schemaVersion: '0.1', project: { name: 'test', createdAt: '2026-04-19T00:00:00.000Z' }, sprints: [{ id: 'sprint-lock', name: 'sprint-lock', status: 'passed' }], verificationCommands: [], pendingRisks: [], lastSprintScope: ['src/foo.ts', 'package-lock.json'], lastSprintScopeGlob: ['src/foo.ts'], sprintsSinceLastAudit: 0, stateUpdatedAt: '2026-04-19T00:00:00.000Z' };
  for (const [file, value] of [
    ['.vibe/config.json', '{"harnessVersion":"1.1.1","harnessVersionInstalled":"1.1.1","audit":{"everyN":99},"loc":{"extensions":[".json",".ts"]}}\n'],
    ['.vibe/agent/sprint-status.json', `${JSON.stringify(status, null, 2)}\n`],
    ['.vibe/agent/handoff.md', '# Handoff\n\n## 2. Status: IDLE\n\n## 3. Sprint History\n\n| Sprint | Summary | Status |\n|---|---|---|\n'],
    ['.vibe/agent/session-log.md', '# Session Log\n\n## Entries\n'],
    ['package-lock.json', '{}\n'],
  ] satisfies Array<[string, string]>) w(path.join(root, file), value);
  for (const args of [['init'], ['config', 'user.name', 'Test User'], ['config', 'user.email', 'test@example.com'], ['config', 'commit.gpgsign', 'false'], ['add', '.'], ['commit', '-m', 'init']]) git(root, args);
}
it('excludes lockfile basenames from actual LOC', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sprint-commit-lockfile-'));
  try {
    scaffold(root);
    w(path.join(root, 'package-lock.json'), `{}\n${Array.from({ length: 300 }, (_, index) => `"x${index}": true,`).join('\n')}\n`);
    w(path.join(root, 'src/foo.ts'), Array.from({ length: 10 }, (_, index) => `export const v${index} = ${index};`).join('\n') + '\n');
    git(root, ['add', '.']);
    execFileSync('node', [scriptPath, 'sprint-lock', 'passed', '--scope', 'src/foo.ts', '--no-verify-gpg'], { cwd: root });
    assert.match(git(root, ['log', '-1', '--format=%B']), /LOC \+10\/-0 \(net \+10\)/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
