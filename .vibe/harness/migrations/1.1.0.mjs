#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function writeJsonSync(filePath, value) {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function withDefaultsInline(partial) {
  const project = isRecord(partial.project) ? partial.project : {};
  const handoff = isRecord(partial.handoff) ? partial.handoff : undefined;

  return {
    ...partial,
    pendingRisks: Array.isArray(partial.pendingRisks) ? partial.pendingRisks : [],
    lastSprintScope: Array.isArray(partial.lastSprintScope) ? partial.lastSprintScope : [],
    lastSprintScopeGlob: Array.isArray(partial.lastSprintScopeGlob) ? partial.lastSprintScopeGlob : [],
    sprintsSinceLastAudit:
      typeof partial.sprintsSinceLastAudit === 'number' ? partial.sprintsSinceLastAudit : 0,
    stateUpdatedAt:
      typeof partial.stateUpdatedAt === 'string'
        ? partial.stateUpdatedAt
        : typeof handoff?.updatedAt === 'string'
          ? handoff.updatedAt
          : typeof project.createdAt === 'string'
            ? project.createdAt
            : new Date().toISOString(),
  };
}

async function ensureParentDir(filePath) {
  await mkdir(dirname(filePath), { recursive: true });
}

async function ensureJsonFile(filePath, value) {
  if (existsSync(filePath)) {
    return;
  }

  await ensureParentDir(filePath);
  writeJsonSync(filePath, value);
}

function ensureAuditConfig(config) {
  if (isRecord(config.audit)) {
    return config;
  }

  return {
    ...config,
    audit: {
      everyN: 5,
    },
  };
}

export async function migrate(root) {
  const statusPath = resolve(root, '.vibe/agent/sprint-status.json');
  const projectMapPath = resolve(root, '.vibe/agent/project-map.json');
  const sprintApiContractsPath = resolve(root, '.vibe/agent/sprint-api-contracts.json');
  const configPath = resolve(root, '.vibe/config.json');

  if (!existsSync(statusPath)) {
    return;
  }

  const rawStatus = JSON.parse(readFileSync(statusPath, 'utf8'));
  if (!('pendingRisks' in rawStatus)) {
    writeJsonSync(statusPath, withDefaultsInline(rawStatus));
  }

  await ensureJsonFile(projectMapPath, {
    $schema: './project-map.schema.json',
    schemaVersion: '0.1',
    updatedAt: new Date().toISOString(),
    modules: {},
    activePlatformRules: [],
  });

  await ensureJsonFile(sprintApiContractsPath, {
    $schema: './sprint-api-contracts.schema.json',
    schemaVersion: '0.1',
    updatedAt: new Date().toISOString(),
    contracts: {},
  });

  if (existsSync(configPath)) {
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    const nextConfig = ensureAuditConfig(config);
    if (JSON.stringify(nextConfig) !== JSON.stringify(config)) {
      writeJsonSync(configPath, nextConfig);
    }
  }
}

try {
  const root = process.argv[2] ? resolve(process.argv[2]) : process.cwd();
  await migrate(root);
  process.exit(0);
} catch (error) {
  const reason = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${reason}\n`);
  process.exit(1);
}
