#!/usr/bin/env node

import { execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path, { resolve } from 'node:path';

const DEFAULT_UPSTREAM_URL = 'https://github.com/mir3626/vibe-doctor.git';
const ENSURE_ONLY = process.argv.includes('--ensure-upstream-only');
const FORCE_REFRESH = process.argv.includes('--force') || process.argv.includes('--refresh');

function parseJson(filePath, fallback) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, value) {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function normalizeGitUrl(value) {
  return String(value ?? '')
    .trim()
    .replace(/^git@([^:]+):/, 'https://$1/')
    .replace(/^ssh:\/\/git@/i, 'https://')
    .replace(/^https?:\/\//i, '')
    .replace(/\.git$/i, '')
    .replace(/\/+$/g, '')
    .toLowerCase();
}

function getOriginUrl(root) {
  try {
    const output = execSync('git remote get-url origin', {
      cwd: root,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
    }).trim();
    return output || null;
  } catch {
    return null;
  }
}

function isTemplateSelfCheckout(root, upstreamUrl) {
  return (
    path.basename(root).toLowerCase() === 'vibe-doctor' &&
    normalizeGitUrl(upstreamUrl) === normalizeGitUrl(DEFAULT_UPSTREAM_URL)
  );
}

function isVibeDoctorRemote(upstreamUrl) {
  const normalized = normalizeGitUrl(upstreamUrl);
  return normalized === normalizeGitUrl(DEFAULT_UPSTREAM_URL) || normalized.endsWith('/vibe-doctor');
}

function ensureUpstreamConfig(root, configPath, config) {
  if (config.upstream?.url || config.upstream?.self) {
    return config;
  }

  const originUrl = getOriginUrl(root);
  let upstream;
  if (originUrl && isVibeDoctorRemote(originUrl)) {
    upstream = isTemplateSelfCheckout(root, originUrl)
      ? { type: 'git', url: originUrl, self: true }
      : { type: 'git', url: originUrl };
  } else if (path.basename(root).toLowerCase() === 'vibe-doctor') {
    upstream = { type: 'git', url: DEFAULT_UPSTREAM_URL, self: true };
  } else {
    upstream = { type: 'git', url: DEFAULT_UPSTREAM_URL };
  }

  const nextConfig = {
    ...config,
    upstream,
  };
  writeJson(configPath, nextConfig);
  return nextConfig;
}

function normalizeVersion(version) {
  if (typeof version !== 'string') {
    return null;
  }
  return version.startsWith('v') ? version.slice(1) : version;
}

function isExactVersionRef(value) {
  return typeof value === 'string' && /^v?\d+\.\d+\.\d+$/.test(value.trim());
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

function versionTags(output) {
  return Array.from(
    new Set(
      output
        .split('\n')
        .map((line) => line.trim().split(/\s+/).at(-1) ?? '')
        .map((ref) => ref.replace('refs/tags/', '').replace(/\^\{\}$/, ''))
        .filter((tag) => /^v\d+\.\d+\.\d+$/.test(tag))
        .map((tag) => normalizeVersion(tag))
        .filter(Boolean),
    ),
  )
    .sort(compareVersions);
}

try {
  const root = process.env.VIBE_ROOT ? resolve(process.env.VIBE_ROOT) : resolve('.');
  const configPath = resolve(root, '.vibe/config.json');
  if (!existsSync(configPath)) {
    process.exit(0);
  }

  const config = ensureUpstreamConfig(root, configPath, parseJson(configPath, {}));
  if (ENSURE_ONLY) {
    process.exit(0);
  }

  if (config.upstream?.self || isTemplateSelfCheckout(root, config.upstream?.url)) {
    process.exit(0);
  }

  if (!config.upstream?.url) {
    process.exit(0);
  }

  const cachePath = resolve(root, '.vibe/sync-cache.json');
  const cache = parseJson(cachePath, {});
  const lastCheckedAt = typeof cache.lastCheckedAt === 'string' ? Date.parse(cache.lastCheckedAt) : Number.NaN;
  if (!FORCE_REFRESH && !Number.isNaN(lastCheckedAt) && Date.now() - lastCheckedAt < 24 * 60 * 60 * 1000) {
    process.exit(0);
  }

  const output = execSync(`git ls-remote --tags ${JSON.stringify(config.upstream.url)}`, {
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  });

  const versions = versionTags(output);
  const latest = versions.at(-1) ?? null;
  if (!latest) {
    writeJson(cachePath, { lastCheckedAt: new Date().toISOString(), latestVersion: null, versions: [] });
    process.exit(0);
  }

  const installed = normalizeVersion(config.harnessVersionInstalled);
  const available = normalizeVersion(latest);
  const exactPinned = isExactVersionRef(config.upstream?.ref);

  if (installed && available && compareVersions(installed, available) < 0 && !exactPinned) {
    process.stdout.write(
      `[vibe-sync] Harness update available: v${installed} -> v${available}. Run \`/vibe-sync\` or \`npm run vibe:sync\`.\n`,
    );
  }

  writeJson(cachePath, { lastCheckedAt: new Date().toISOString(), latestVersion: available, versions });
} catch {
  process.exit(0);
}
