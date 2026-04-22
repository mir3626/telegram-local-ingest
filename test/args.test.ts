import test from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, getBooleanFlag, getStringFlag } from '../src/lib/args.js';

test('parseArgs handles key value and boolean flags', () => {
  const parsed = parseArgs(['--provider', 'codex', 'task.md', '--dry-run']);

  assert.equal(getStringFlag(parsed, 'provider'), 'codex');
  assert.equal(getBooleanFlag(parsed, 'dry-run'), true);
  assert.deepEqual(parsed.positionals, ['task.md']);
});

test('parseArgs handles equals syntax', () => {
  const parsed = parseArgs(['--role=challenger']);
  assert.equal(getStringFlag(parsed, 'role'), 'challenger');
});
