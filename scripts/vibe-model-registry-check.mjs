#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';

const DAY_MS = 24 * 60 * 60 * 1000;

function parseJson(filePath, fallback = null) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeCache(filePath, value) {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function runGit(args, options = {}) {
  return execFileSync('git', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  }).trim();
}

function normalizeRemoteUrl(url) {
  return typeof url === 'string' ? url.trim().replace(/\/+$/, '') : '';
}

function loadUpstreamRegistry(config) {
  if (config?.upstream?.type !== 'git') {
    return null;
  }

  if (typeof config.upstream.ref === 'string' && config.upstream.ref.length > 0) {
    const raw = runGit(['show', `${config.upstream.ref}:.vibe/model-registry.json`]);
    return JSON.parse(raw);
  }

  if (typeof config.upstream.url !== 'string' || config.upstream.url.length === 0) {
    return null;
  }

  const remoteLines = runGit(['config', '--get-regexp', '^remote\\..*\\.url$']);
  const normalizedUrl = normalizeRemoteUrl(config.upstream.url);
  const matchingRemote = remoteLines
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const [key, ...rest] = line.split(/\s+/);
      const remoteName = key.replace(/^remote\./, '').replace(/\.url$/, '');
      return {
        name: remoteName,
        url: rest.join(' '),
      };
    })
    .find((remote) => normalizeRemoteUrl(remote.url) === normalizedUrl);

  if (!matchingRemote) {
    return null;
  }

  runGit(['ls-remote', matchingRemote.name]);
  const cloneDir = mkdtempSync(path.join(tmpdir(), 'vibe-registry-check-'));
  try {
    runGit(['clone', '--depth', '1', matchingRemote.url, cloneDir]);
    const registryPath = path.join(cloneDir, '.vibe', 'model-registry.json');
    return parseJson(registryPath, null);
  } finally {
    rmSync(cloneDir, { recursive: true, force: true });
  }
}

function hasNewTierKeys(localRegistry, upstreamRegistry) {
  const localProviders = localRegistry?.providers ?? {};
  const upstreamProviders = upstreamRegistry?.providers ?? {};

  for (const [providerName, upstreamProvider] of Object.entries(upstreamProviders)) {
    if (!(providerName in localProviders)) {
      continue;
    }

    const localTierKeys = new Set(Object.keys(localProviders[providerName]?.tiers ?? {}));
    for (const tierKey of Object.keys(upstreamProvider?.tiers ?? {})) {
      if (!localTierKeys.has(tierKey)) {
        return true;
      }
    }
  }

  return false;
}

try {
  const upstreamConfigPath = path.resolve('.vibe', 'config.json.upstream');
  if (!existsSync(upstreamConfigPath)) {
    process.exit(0);
  }

  const cachePath = path.resolve('.vibe', 'model-registry-cache.json');
  const cache = parseJson(cachePath, {});
  const lastCheckedAt =
    typeof cache?.lastCheckedAt === 'string' ? Date.parse(cache.lastCheckedAt) : Number.NaN;
  if (!Number.isNaN(lastCheckedAt) && Date.now() - lastCheckedAt < DAY_MS) {
    process.exit(0);
  }

  const localRegistry = parseJson(path.resolve('.vibe', 'model-registry.json'), null);
  const upstreamRegistry = loadUpstreamRegistry(parseJson(upstreamConfigPath, {}));
  const nextCache = {
    lastCheckedAt: new Date().toISOString(),
    localSchemaVersion: localRegistry?.schemaVersion ?? null,
    upstreamSchemaVersion: upstreamRegistry?.schemaVersion ?? null,
  };

  if (!upstreamRegistry) {
    writeCache(cachePath, nextCache);
    process.exit(0);
  }

  if (
    (typeof localRegistry?.schemaVersion === 'number' &&
      typeof upstreamRegistry?.schemaVersion === 'number' &&
      upstreamRegistry.schemaVersion > localRegistry.schemaVersion) ||
    hasNewTierKeys(localRegistry, upstreamRegistry)
  ) {
    process.stdout.write(
      `[vibe-registry] model-registry update available (local=${String(localRegistry?.schemaVersion ?? 'n/a')}, upstream=${String(upstreamRegistry.schemaVersion)}). Run 'npm run vibe:sync' to refresh.\n`,
    );
  }

  writeCache(cachePath, nextCache);
} catch {
  try {
    writeCache(path.resolve('.vibe', 'model-registry-cache.json'), {
      lastCheckedAt: new Date().toISOString(),
      localSchemaVersion: null,
      upstreamSchemaVersion: null,
    });
  } catch {
    // ignore cache write errors
  }
  process.exit(0);
}
