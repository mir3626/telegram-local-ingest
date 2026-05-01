import test from 'node:test';
import assert from 'node:assert/strict';
import { extractUsage } from '../src/lib/usage.js';

test('extractUsage parses direct token fields', () => {
  const usage = extractUsage('{"input_tokens":12,"output_tokens":8,"total_tokens":20}', 'codex');

  assert.equal(usage.inputTokens, 12);
  assert.equal(usage.outputTokens, 8);
  assert.equal(usage.totalTokens, 20);
  assert.equal(usage.provider, 'codex');
});

test('extractUsage parses nested usage fields', () => {
  const usage = extractUsage('{"usage":{"promptTokens":10,"completionTokens":5}}', 'gemini');

  assert.equal(usage.inputTokens, 10);
  assert.equal(usage.outputTokens, 5);
  assert.equal(usage.totalTokens, 15);
  assert.equal(usage.provider, 'gemini');
});
