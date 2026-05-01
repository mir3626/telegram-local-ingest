import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, it } from 'node:test';

const execFileAsync = promisify(execFile);

type ParsedToml = Record<string, string>;

const BASIC_ESCAPES = new Set(['b', 't', 'n', 'f', 'r', '"', '\\', 'u', 'U']);
const TOML_SAFE_MOJIBAKE_GREP = `LC_ALL=C grep -lE '"[?][^"]*"' <touched files>`;
const LEGACY_MOJIBAKE_GREP = `LC_ALL=C grep -lE '"\\${'?'}[^"]*"' <touched files>`;

function assertHexEscape(raw: string, start: number, length: number, filePath: string): void {
  const value = raw.slice(start, start + length);
  assert.equal(
    /^[0-9A-Fa-f]+$/.test(value) && value.length === length,
    true,
    `${filePath}: invalid hex escape \\${raw[start - 1] ?? ''}${value}`,
  );
}

function assertValidBasicStringEscapes(raw: string, filePath: string): void {
  for (let index = 0; index < raw.length; index += 1) {
    if (raw[index] !== '\\') {
      continue;
    }

    const next = raw[index + 1];
    if (next === undefined) {
      assert.fail(`${filePath}: dangling TOML escape`);
    }

    if (next === '\r' || next === '\n') {
      continue;
    }

    assert.equal(BASIC_ESCAPES.has(next), true, `${filePath}: invalid TOML escape \\${next}`);
    if (next === 'u') {
      assertHexEscape(raw, index + 2, 4, filePath);
      index += 5;
    } else if (next === 'U') {
      assertHexEscape(raw, index + 2, 8, filePath);
      index += 9;
    } else {
      index += 1;
    }
  }
}

function parseTomlValue(content: string, cursor: number, filePath: string): { value: string; next: number } {
  if (content.startsWith("'''", cursor)) {
    const end = content.indexOf("'''", cursor + 3);
    assert.notEqual(end, -1, `${filePath}: unterminated multiline literal string`);
    return { value: content.slice(cursor + 3, end), next: end + 3 };
  }

  if (content.startsWith('"""', cursor)) {
    const end = content.indexOf('"""', cursor + 3);
    assert.notEqual(end, -1, `${filePath}: unterminated multiline basic string`);
    const value = content.slice(cursor + 3, end);
    assertValidBasicStringEscapes(value, filePath);
    return { value, next: end + 3 };
  }

  if (content[cursor] === "'") {
    const end = content.indexOf("'", cursor + 1);
    assert.notEqual(end, -1, `${filePath}: unterminated literal string`);
    return { value: content.slice(cursor + 1, end), next: end + 1 };
  }

  if (content[cursor] === '"') {
    let index = cursor + 1;
    let raw = '';
    while (index < content.length) {
      const char = content[index];
      if (char === '"' && content[index - 1] !== '\\') {
        assertValidBasicStringEscapes(raw, filePath);
        return { value: raw, next: index + 1 };
      }
      raw += char;
      index += 1;
    }
    assert.fail(`${filePath}: unterminated basic string`);
  }

  const end = content.slice(cursor).search(/\r?\n/);
  const next = end === -1 ? content.length : cursor + end;
  return { value: content.slice(cursor, next).trim(), next };
}

function parseAgentToml(content: string, filePath: string): ParsedToml {
  const parsed: ParsedToml = {};
  let cursor = 0;

  while (cursor < content.length) {
    while (cursor < content.length && /[\s]/.test(content[cursor] ?? '')) {
      cursor += 1;
    }
    if (cursor >= content.length) {
      break;
    }

    const keyMatch = /^[A-Za-z0-9_-]+/.exec(content.slice(cursor));
    assert.notEqual(keyMatch, null, `${filePath}: expected TOML key at offset ${cursor}`);
    const key = keyMatch?.[0] ?? '';
    cursor += key.length;

    while (content[cursor] === ' ' || content[cursor] === '\t') {
      cursor += 1;
    }
    assert.equal(content[cursor], '=', `${filePath}: expected '=' after ${key}`);
    cursor += 1;
    while (content[cursor] === ' ' || content[cursor] === '\t') {
      cursor += 1;
    }

    const value = parseTomlValue(content, cursor, filePath);
    parsed[key] = value.value;
    cursor = value.next;

    while (content[cursor] === ' ' || content[cursor] === '\t') {
      cursor += 1;
    }
    assert.equal(
      cursor >= content.length || content[cursor] === '\r' || content[cursor] === '\n',
      true,
      `${filePath}: unexpected trailing content after ${key}`,
    );
  }

  return parsed;
}

async function listAgentTomlFiles(): Promise<string[]> {
  const root = path.join(process.cwd(), '.codex', 'agents');
  const entries = await readdir(root, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.toml'))
    .map((entry) => path.join(root, entry.name))
    .sort();
}

describe('Codex agent TOML', () => {
  it('parses every upstream Codex agent role file', async () => {
    const files = await listAgentTomlFiles();
    assert.notEqual(files.length, 0);

    for (const filePath of files) {
      const parsed = parseAgentToml(await readFile(filePath, 'utf8'), filePath);
      assert.equal(typeof parsed.name, 'string');
      assert.equal(typeof parsed.description, 'string');
      assert.equal(typeof parsed.developer_instructions, 'string');
      assert.equal(typeof parsed.sandbox_mode, 'string');
    }
  });

  it('keeps agent prompt bodies out of fragile multiline basic strings', async () => {
    for (const filePath of await listAgentTomlFiles()) {
      const content = await readFile(filePath, 'utf8');
      assert.doesNotMatch(content, /developer_instructions\s*=\s*"""/);
      assert.doesNotMatch(content, /LC_ALL=C grep .*\\[?]/);
    }
  });

  it('sync manifest ships Codex agent role files and this regression test', async () => {
    const manifest = JSON.parse(await readFile(path.join(process.cwd(), '.vibe', 'sync-manifest.json'), 'utf8')) as {
      files: { harness: string[] };
      migrations: Record<string, string>;
    };

    assert.equal(manifest.files.harness.includes('.codex/agents/**'), true);
    assert.equal(manifest.files.harness.includes('.vibe/harness/test/**'), true);
    assert.equal(manifest.files.harness.includes('.vibe/harness/migrations/**'), true);
    assert.equal(manifest.migrations['1.6.2'], '.vibe/harness/migrations/1.6.2.mjs');
  });

  it('migrates legacy multiline basic agent prompts without changing project state', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'codex-agent-toml-'));
    try {
      const agentDir = path.join(root, '.codex', 'agents');
      await mkdir(agentDir, { recursive: true });
      const target = path.join(agentDir, 'coder.toml');
      await writeFile(
        target,
        String.raw`name = "coder"
description = "legacy"
developer_instructions = """
Run ` + "`" + LEGACY_MOJIBAKE_GREP + "`" + String.raw`.
"""
sandbox_mode = "workspace-write"
`,
        'utf8',
      );

      await execFileAsync(process.execPath, [path.join(process.cwd(), '.vibe', 'harness', 'migrations', '1.6.2.mjs'), root]);

      const migrated = await readFile(target, 'utf8');
      assert.match(migrated, /developer_instructions = '''/);
      assert.doesNotMatch(migrated, /developer_instructions\s*=\s*"""/);
      assert.equal(migrated.includes(TOML_SAFE_MOJIBAKE_GREP), true);
      assert.doesNotMatch(migrated, /LC_ALL=C grep .*\\[?]/);
      parseAgentToml(migrated, target);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
