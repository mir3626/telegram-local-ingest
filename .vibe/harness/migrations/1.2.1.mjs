#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

function compareVersions(left, right) {
  const leftParts = String(left ?? '')
    .replace(/^v/, '')
    .split('.')
    .map((part) => Number(part));
  const rightParts = String(right ?? '')
    .replace(/^v/, '')
    .split('.')
    .map((part) => Number(part));
  const length = Math.max(leftParts.length, rightParts.length);

  for (let index = 0; index < length; index += 1) {
    const diff = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (diff !== 0) {
      return diff;
    }
  }

  return 0;
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function writeJson(filePath, value) {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function removeLegacyMcpServer(root) {
  const mcpPath = resolve(root, '.mcp.json');
  if (!existsSync(mcpPath)) {
    return 'missing';
  }

  const config = JSON.parse(readFileSync(mcpPath, 'utf8'));
  if (!isRecord(config.mcpServers) || !('ouroboros' in config.mcpServers)) {
    return 'already-absent';
  }

  const { ouroboros: _removed, ...remainingServers } = config.mcpServers;
  writeJson(mcpPath, {
    ...config,
    mcpServers: remainingServers,
  });
  return 'removed';
}

function bumpInstalledVersion(root) {
  const configPath = resolve(root, '.vibe/config.json');
  if (!existsSync(configPath)) {
    return 'config-missing';
  }

  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  if (compareVersions(config.harnessVersionInstalled, '1.2.1') >= 0) {
    return 'already >= 1.2.1';
  }

  config.harnessVersionInstalled = '1.2.1';
  writeJson(configPath, config);
  return 'updated to 1.2.1';
}

function main() {
  const root = resolve(process.argv[2] ?? process.cwd());
  const actions = [
    `mcp=${removeLegacyMcpServer(root)}`,
    `version=${bumpInstalledVersion(root)}`,
  ];

  process.stdout.write(`[migrate 1.2.1] ${actions.join(' ')}\n`);
}

try {
  main();
  process.exit(0);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
