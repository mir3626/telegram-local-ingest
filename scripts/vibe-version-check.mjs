#!/usr/bin/env node

import { execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

function parseJson(filePath, fallback) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function normalizeVersion(version) {
  if (typeof version !== 'string') {
    return null;
  }
  return version.startsWith('v') ? version.slice(1) : version;
}

function compareVersions(left, right) {
  const leftParts = normalizeVersion(left)?.split('.').map(Number) ?? [];
  const rightParts = normalizeVersion(right)?.split('.').map(Number) ?? [];
  const length = Math.max(leftParts.length, rightParts.length);

  for (let index = 0; index < length; index += 1) {
    const diff = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (diff !== 0) {
      return diff;
    }
  }

  return 0;
}

function latestTag(output) {
  return output
    .split('\n')
    .map((line) => line.trim().split(/\s+/).at(-1) ?? '')
    .map((ref) => ref.replace('refs/tags/', '').replace(/\^\{\}$/, ''))
    .filter((tag) => /^v\d+\.\d+\.\d+$/.test(tag))
    .sort(compareVersions)
    .at(-1) ?? null;
}

try {
  const configPath = resolve('.vibe/config.json');
  if (!existsSync(configPath)) {
    process.exit(0);
  }

  const config = parseJson(configPath, {});
  if (!config.upstream?.url) {
    process.exit(0);
  }

  const cachePath = resolve('.vibe/sync-cache.json');
  const cache = parseJson(cachePath, {});
  const lastCheckedAt = typeof cache.lastCheckedAt === 'string' ? Date.parse(cache.lastCheckedAt) : Number.NaN;
  if (!Number.isNaN(lastCheckedAt) && Date.now() - lastCheckedAt < 24 * 60 * 60 * 1000) {
    process.exit(0);
  }

  const output = execSync(`git ls-remote --tags ${JSON.stringify(config.upstream.url)}`, {
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  });

  const latest = latestTag(output);
  if (!latest) {
    writeFileSync(
      cachePath,
      `${JSON.stringify({ lastCheckedAt: new Date().toISOString(), latestVersion: null }, null, 2)}\n`,
      'utf8',
    );
    process.exit(0);
  }

  const installed = normalizeVersion(config.harnessVersionInstalled);
  const available = normalizeVersion(latest);

  if (installed && available && compareVersions(installed, available) < 0) {
    process.stdout.write(
      `[vibe-sync] 하네스 업데이트 가능: v${installed} → v${available}. \`/vibe-sync\` 또는 \`npm run vibe:sync\`로 반영하세요.\n`,
    );
  }

  writeFileSync(
    cachePath,
    `${JSON.stringify({ lastCheckedAt: new Date().toISOString(), latestVersion: available }, null, 2)}\n`,
    'utf8',
  );
} catch {
  process.exit(0);
}
