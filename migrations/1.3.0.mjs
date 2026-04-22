#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

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
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function ensureIterationHistory(root) {
  const filePath = path.join(root, '.vibe', 'agent', 'iteration-history.json');
  if (existsSync(filePath)) {
    return 'exists';
  }

  writeJson(filePath, {
    $schema: './iteration-history.schema.json',
    currentIteration: null,
    iterations: [],
  });
  return 'created';
}

function updateConfig(root) {
  const filePath = path.join(root, '.vibe', 'config.json');
  if (!existsSync(filePath)) {
    return 'config-missing';
  }

  const config = JSON.parse(readFileSync(filePath, 'utf8'));
  if (!isRecord(config.review)) {
    config.review = {};
  }
  if (!isRecord(config.review.weights)) {
    config.review.weights = {
      agentFriendly: 10,
      tokenEfficient: 5,
      userFyi: 1,
    };
  }
  if (compareVersions(config.harnessVersionInstalled, '1.3.0') < 0) {
    config.harnessVersionInstalled = '1.3.0';
  }

  writeJson(filePath, config);
  return 'updated';
}

function main() {
  const root = path.resolve(process.argv[2] ?? process.cwd());
  const actions = [`iterationHistory=${ensureIterationHistory(root)}`, `config=${updateConfig(root)}`];
  process.stdout.write(`[migrate 1.3.0] ${actions.join(' ')}\n`);
}

try {
  main();
  process.exit(0);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
