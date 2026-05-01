#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const AGENT_TOML_DIR = path.join('.codex', 'agents');

function replaceKnownMojibakeGreps(content) {
  return content
    .replaceAll(`'"\\?[^"]*"'`, `'"[?][^"]*"'`)
    .replaceAll(`'"\\?[^"]*[\\xc0-\\xff]'`, `'"[?][^"]*[\\xc0-\\xff]'`);
}

function convertDeveloperInstructionsToLiteralString(content) {
  const open = 'developer_instructions = """';
  const openIndex = content.indexOf(open);
  if (openIndex === -1) {
    return content;
  }

  const bodyStart = openIndex + open.length;
  const closeIndex = content.indexOf('"""', bodyStart);
  if (closeIndex === -1) {
    return content;
  }

  const body = content.slice(bodyStart, closeIndex);
  if (body.includes("'''")) {
    return content;
  }

  return `${content.slice(0, openIndex)}developer_instructions = '''${body}'''${content.slice(closeIndex + 3)}`;
}

function patchAgentToml(filePath) {
  const original = readFileSync(filePath, 'utf8');
  const next = convertDeveloperInstructionsToLiteralString(replaceKnownMojibakeGreps(original));

  if (next === original) {
    return false;
  }

  writeFileSync(filePath, next, 'utf8');
  return true;
}

function migrateCodexAgentToml(root) {
  const dir = path.join(root, AGENT_TOML_DIR);
  if (!existsSync(dir)) {
    return 'missing';
  }

  let patched = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.toml')) {
      continue;
    }
    if (patchAgentToml(path.join(dir, entry.name))) {
      patched += 1;
    }
  }

  return patched === 0 ? 'idempotent' : `patched-${patched}`;
}

function main() {
  const root = path.resolve(process.argv[2] ?? process.cwd());
  const result = migrateCodexAgentToml(root);
  process.stdout.write(`[migrate 1.6.2] codexAgentToml=${result}${result === 'idempotent' ? ' idempotent' : ''}\n`);
}

try {
  main();
  process.exit(0);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
