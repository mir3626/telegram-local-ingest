#!/usr/bin/env node

import { execSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path, { dirname, resolve } from 'node:path';

const DEFAULT_UPSTREAM_URL = 'https://github.com/mir3626/vibe-doctor.git';
const SEMVER_REF_PATTERN = /^\d+\.\d+\.\d+$/;

function parseJson(filePath, fallback) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, value) {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function copyWithBackup(root, relativePath, backupRoot, upstreamRoot) {
  const target = resolve(root, relativePath);
  const source = resolve(upstreamRoot, relativePath);
  if (!existsSync(source)) {
    return false;
  }

  if (existsSync(target)) {
    const backupPath = resolve(backupRoot, relativePath);
    mkdirSync(dirname(backupPath), { recursive: true });
    cpSync(target, backupPath);
  }

  mkdirSync(dirname(target), { recursive: true });
  cpSync(source, target);
  return true;
}

function mergeClaudeSettings(localJson, upstreamJson) {
  return {
    ...localJson,
    ...upstreamJson,
    hooks: upstreamJson.hooks ?? localJson.hooks,
    permissions: localJson.permissions ?? upstreamJson.permissions,
  };
}

function mergePackageJson(localJson, upstreamJson) {
  const localScripts = localJson.scripts ?? {};
  const upstreamScripts = upstreamJson.scripts ?? {};
  const mergedScripts = { ...localScripts };

  for (const [key, value] of Object.entries(mergedScripts)) {
    if (key.startsWith('vibe:')) {
      delete mergedScripts[key];
    }
  }

  for (const [key, value] of Object.entries(upstreamScripts)) {
    if (key.startsWith('vibe:')) {
      mergedScripts[key] = value;
    }
  }

  return {
    ...localJson,
    scripts: mergedScripts,
    engines: upstreamJson.engines ?? localJson.engines,
  };
}

function main() {
  const root = process.cwd();
  const configPath = resolve(root, '.vibe/config.json');
  if (!existsSync(configPath)) {
    throw new Error('Current directory is not a vibe-doctor project (.vibe/config.json missing)');
  }

  const arg = process.argv[2];
  const sourcePath = arg && existsSync(resolve(arg)) ? resolve(arg) : null;
  let upstreamRoot = sourcePath;
  let cleanupPath = null;

  try {
    if (!upstreamRoot) {
      cleanupPath = mkdtempSync(path.join(tmpdir(), 'vibe-bootstrap-'));
      execSync(
        `git clone --depth 1 ${JSON.stringify(arg ?? DEFAULT_UPSTREAM_URL)} ${JSON.stringify(cleanupPath)}`,
        {
          stdio: 'pipe',
          encoding: 'utf8',
        },
      );
      upstreamRoot = cleanupPath;
    }

    const manifest = parseJson(resolve(upstreamRoot, '.vibe/sync-manifest.json'), null);
    if (!manifest) {
      throw new Error('Failed to load upstream sync manifest');
    }

    const upstreamConfig = parseJson(resolve(upstreamRoot, '.vibe/config.json'), {});
    const localConfig = parseJson(configPath, {});
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupRoot = resolve(root, '.vibe/sync-backup', `bootstrap-${stamp}`);
    const changed = [];

    for (const relativePath of manifest.files.harness ?? []) {
      if (copyWithBackup(root, relativePath, backupRoot, upstreamRoot)) {
        changed.push(relativePath);
      }
    }

    const claudePath = resolve(root, 'CLAUDE.md');
    if (existsSync(claudePath)) {
      mkdirSync(backupRoot, { recursive: true });
      cpSync(claudePath, resolve(backupRoot, 'CLAUDE.md.local'));
    }
    if (copyWithBackup(root, 'CLAUDE.md', backupRoot, upstreamRoot)) {
      changed.push('CLAUDE.md');
    }

    const claudeSettingsPath = resolve(root, '.claude/settings.json');
    if (existsSync(resolve(upstreamRoot, '.claude/settings.json'))) {
      const mergedSettings = mergeClaudeSettings(
        parseJson(claudeSettingsPath, {}),
        parseJson(resolve(upstreamRoot, '.claude/settings.json'), {}),
      );
      writeJson(claudeSettingsPath, mergedSettings);
      changed.push('.claude/settings.json');
    }

    const packagePath = resolve(root, 'package.json');
    if (existsSync(packagePath) && existsSync(resolve(upstreamRoot, 'package.json'))) {
      const mergedPackage = mergePackageJson(
        parseJson(packagePath, {}),
        parseJson(resolve(upstreamRoot, 'package.json'), {}),
      );
      writeJson(packagePath, mergedPackage);
      changed.push('package.json');
    }

    const harnessVersion = upstreamConfig.harnessVersion ?? localConfig.harnessVersion ?? '1.0.0';
    const upstreamRef =
      localConfig.upstream?.ref
      ?? (SEMVER_REF_PATTERN.test(harnessVersion) ? `v${harnessVersion}` : undefined);
    const nextConfig = {
      ...localConfig,
      harnessVersion,
      harnessVersionInstalled: upstreamConfig.harnessVersion ?? localConfig.harnessVersionInstalled ?? '1.0.0',
      upstream: {
        ...(localConfig.upstream ?? {
          type: sourcePath ? 'local' : 'git',
          url: sourcePath ?? (arg ?? DEFAULT_UPSTREAM_URL),
        }),
        ...(upstreamRef ? { ref: upstreamRef } : {}),
      },
    };
    writeJson(configPath, nextConfig);
    changed.push('.vibe/config.json');

    process.stdout.write('vibe sync bootstrap complete\n');
    process.stdout.write(`Backup: ${backupRoot}\n`);
    process.stdout.write(`Changed files: ${changed.join(', ')}\n`);
  } finally {
    if (cleanupPath) {
      rmSync(cleanupPath, { recursive: true, force: true });
    }
  }
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
