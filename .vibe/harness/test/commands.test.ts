import test from 'node:test';
import assert from 'node:assert/strict';
import {
  findViolations,
  forbiddenPatterns,
} from '../src/commands/audit-config.js';
import { selectQaScripts, QA_SCRIPT_ORDER } from '../src/commands/qa.js';
import { renderReport } from '../src/lib/report.js';

// ---------- audit-config.findViolations ----------

test('findViolations flags .env but leaves .env.example alone', () => {
  const tracked = ['.env', '.env.example', '.env.local', 'README.md'];
  assert.deepEqual(findViolations(tracked), ['.env', '.env.local']);
});

test('findViolations treats slash-terminated patterns as directory prefixes', () => {
  const tracked = [
    'secrets/key.pem',
    'secrets/nested/also.key',
    'secretsfile.txt',
  ];
  assert.deepEqual(findViolations(tracked, ['secrets/']), [
    'secrets/key.pem',
    'secrets/nested/also.key',
  ]);
});

test('findViolations requires exact match for file patterns', () => {
  // `.env` must not match `.envrc` or `dotenv` — this is the regression
  // we introduced and fixed in Sprint A.
  const tracked = ['.envrc', 'dotenv', 'fake.env', '.env'];
  assert.deepEqual(findViolations(tracked, ['.env']), ['.env']);
});

test('findViolations returns empty array for a clean tree', () => {
  const tracked = ['README.md', '.env.example', 'src/index.ts', 'docs/a.md'];
  assert.deepEqual(findViolations(tracked, forbiddenPatterns), []);
});

test('findViolations handles empty input', () => {
  assert.deepEqual(findViolations([], forbiddenPatterns), []);
});

// ---------- qa.selectQaScripts ----------

test('selectQaScripts returns matches in canonical order, not input order', () => {
  const scripts = {
    build: 'tsc',
    lint: 'eslint .',
    test: 'node --test',
    typecheck: 'tsc --noEmit',
  };
  assert.deepEqual(selectQaScripts(scripts), [
    'test',
    'typecheck',
    'lint',
    'build',
  ]);
});

test('selectQaScripts skips missing scripts silently', () => {
  assert.deepEqual(selectQaScripts({ test: 'jest' }), ['test']);
});

test('selectQaScripts returns empty when nothing matches', () => {
  assert.deepEqual(selectQaScripts({ 'custom:one': 'echo 1' }), []);
});

test('selectQaScripts handles undefined scripts map', () => {
  assert.deepEqual(selectQaScripts(undefined), []);
});

test('QA_SCRIPT_ORDER prioritises fast signals before full build', () => {
  // test:unit must come before test, and build must come last — any
  // reorder will silently change vibe:qa execution behaviour.
  assert.equal(QA_SCRIPT_ORDER[0], 'test:unit');
  assert.equal(QA_SCRIPT_ORDER.at(-1), 'build');
});

// ---------- report.renderReport ----------

test('renderReport emits every section with a trailing newline', () => {
  const md = renderReport({
    title: 'Sprint X',
    summary: 'did a thing',
    changed: ['a.ts', 'b.ts'],
    qa: ['typecheck', 'test'],
    risks: ['rollback risk'],
    context: ['updated conventions.md'],
    usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
  });

  assert.ok(md.startsWith('# Sprint X\n'));
  assert.ok(md.endsWith('\n'));
  assert.match(md, /## Summary\ndid a thing/);
  assert.match(md, /## Changed\n- a\.ts\n- b\.ts/);
  assert.match(md, /## QA\n- typecheck\n- test/);
  assert.match(md, /## Risks\n- rollback risk/);
  assert.match(md, /## Context updates\n- updated conventions\.md/);
  assert.match(md, /## Usage\n- input: 10, output: 20, total: 30/);
});

test('renderReport falls back to placeholders for missing fields', () => {
  const md = renderReport({ title: 't', summary: 's' });
  assert.match(md, /## Changed\n- n\/a/);
  assert.match(md, /## QA\n- n\/a/);
  assert.match(md, /## Risks\n- n\/a/);
  assert.match(md, /## Context updates\n- none/);
  assert.match(md, /## Usage\n- unavailable/);
});

test('renderReport treats empty arrays the same as missing fields', () => {
  const md = renderReport({
    title: 't',
    summary: 's',
    changed: [],
    qa: [],
    risks: [],
    context: [],
  });
  assert.match(md, /## Changed\n- n\/a/);
  assert.match(md, /## Context updates\n- none/);
});
