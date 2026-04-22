#!/usr/bin/env node

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_REGISTRY = {
  $schema: './model-registry.schema.json',
  schemaVersion: 1,
  updatedAt: '2026-04-15T00:00:00.000Z',
  source: 'vibe-doctor-upstream',
  providers: {
    anthropic: {
      tiers: {
        flagship: 'opus',
        performant: 'sonnet',
        efficient: 'haiku',
      },
      knownModels: {
        opus: {
          apiId: 'claude-opus-4-6',
          release: '2026-04',
        },
        sonnet: {
          apiId: 'claude-sonnet-4-6',
          release: '2026-04',
        },
        haiku: {
          apiId: 'claude-haiku-4-5',
          release: '2025-10',
        },
      },
    },
  },
};

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

function writeJson(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function main() {
  const root = path.resolve(process.argv[2] ?? process.cwd());
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const targetRegistryPath = path.join(root, '.vibe', 'model-registry.json');
  const configPath = path.join(root, '.vibe', 'config.json');
  const templatePath = path.join(scriptDir, '..', '.vibe', 'model-registry.json');
  const actions = [];

  let registryStatus = 'exists';
  if (!existsSync(targetRegistryPath)) {
    mkdirSync(path.dirname(targetRegistryPath), { recursive: true });
    if (existsSync(templatePath)) {
      copyFileSync(templatePath, targetRegistryPath);
    } else {
      writeJson(targetRegistryPath, DEFAULT_REGISTRY);
    }
    registryStatus = 'created';
  }
  actions.push(`registry=${registryStatus}`);

  let versionStatus = 'n/a';
  let sprintRolesStatus = 'n/a';
  if (existsSync(configPath)) {
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    const plannerRole = config.sprintRoles?.planner;

    if (typeof plannerRole === 'string') {
      sprintRolesStatus = `legacy-string-retained(${plannerRole})`;
    } else if (plannerRole && typeof plannerRole === 'object') {
      sprintRolesStatus = 'tier-format-present';
    } else {
      sprintRolesStatus = 'planner-missing';
    }

    if (compareVersions(config.harnessVersionInstalled, '1.2.0') < 0) {
      config.harnessVersionInstalled = '1.2.0';
      writeJson(configPath, config);
      versionStatus = 'updated to 1.2.0';
    } else {
      versionStatus = 'already >= 1.2.0';
    }
  } else {
    versionStatus = 'config-missing';
  }
  actions.push(`version=${versionStatus}`);
  actions.push(`sprintRoles=${sprintRolesStatus}`);

  process.stdout.write(`[migrate 1.2.0] ${actions.join(' ')}\n`);
}

try {
  main();
  process.exit(0);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
