#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
}

const PRESET_FILES = {
  core: 'agent-delegation.json',
  extended: 'agent-delegation-extended.json',
};

function getPresetPath(rootDir, tier) {
  return path.resolve(rootDir, '.vibe', 'settings-presets', PRESET_FILES[tier]);
}

function loadPreset(rootDir, tier = 'core', options = {}) {
  const presetPath = getPresetPath(rootDir, tier);
  if (!existsSync(presetPath) && tier === 'extended' && options.fallbackToCore === true) {
    if (options.warnOnFallback === true) {
      process.stderr.write(
        '[vibe-sprint-mode] WARN -- extended preset missing; falling back to core\n',
      );
    }
    return loadPreset(rootDir, 'core');
  }

  if (!existsSync(presetPath)) {
    fail(`Missing preset file: ${presetPath}`);
  }

  const preset = readJson(presetPath);
  if (!Array.isArray(preset.rules) || preset.rules.some((entry) => typeof entry !== 'string')) {
    fail(`Invalid preset rules in ${presetPath}`);
  }

  return preset.rules;
}

function loadAllPresetRules(rootDir) {
  const rules = new Set();
  for (const tier of ['core', 'extended']) {
    const presetPath = getPresetPath(rootDir, tier);
    if (!existsSync(presetPath)) {
      continue;
    }

    for (const rule of loadPreset(rootDir, tier)) {
      rules.add(rule);
    }
  }

  return rules;
}

function loadSettings(rootDir, createIfMissing = false) {
  const settingsPath = path.resolve(rootDir, '.claude', 'settings.local.json');
  if (!existsSync(settingsPath)) {
    return {
      settingsPath,
      exists: false,
      settings: createIfMissing
        ? {
            permissions: {
              allow: [],
            },
          }
        : null,
    };
  }

  return {
    settingsPath,
    exists: true,
    settings: readJson(settingsPath),
  };
}

function getAllowRules(settings) {
  const allow = settings?.permissions?.allow;
  if (allow === undefined) {
    return [];
  }

  if (!Array.isArray(allow) || allow.some((entry) => typeof entry !== 'string')) {
    fail('Expected .claude/settings.local.json permissions.allow to be a string array');
  }

  return allow;
}

function mergePermissions(settings, allowRules) {
  const nextSettings =
    settings && typeof settings === 'object' && !Array.isArray(settings) ? settings : {};
  const nextPermissions =
    nextSettings.permissions &&
    typeof nextSettings.permissions === 'object' &&
    !Array.isArray(nextSettings.permissions)
      ? nextSettings.permissions
      : {};

  return {
    ...nextSettings,
    permissions: {
      ...nextPermissions,
      allow: allowRules,
    },
  };
}

function saveSettings(settingsPath, settings) {
  mkdirSync(path.dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
}

function runOn(rootDir, tier) {
  const presetRules = loadPreset(rootDir, tier, {
    fallbackToCore: true,
    warnOnFallback: tier === 'extended',
  });
  const { settingsPath, settings } = loadSettings(rootDir, true);
  const currentAllow = getAllowRules(settings);
  const nextAllow = [...new Set([...currentAllow, ...presetRules])];
  const addedCount = nextAllow.length - currentAllow.length;

  saveSettings(settingsPath, mergePermissions(settings, nextAllow));
  process.stdout.write(
    `[vibe-sprint-mode] ON -- ${presetRules.length} preset rules merged (${addedCount} new). Total allow rules: ${nextAllow.length}\n`,
  );
}

function runOff(rootDir) {
  const presetSet = loadAllPresetRules(rootDir);
  const { settingsPath, exists, settings } = loadSettings(rootDir, false);

  if (!exists || settings === null) {
    process.stdout.write('[vibe-sprint-mode] OFF -- nothing to remove\n');
    return;
  }

  const currentAllow = getAllowRules(settings);
  const nextAllow = currentAllow.filter((entry) => !presetSet.has(entry));
  const removedCount = currentAllow.length - nextAllow.length;

  saveSettings(settingsPath, mergePermissions(settings, nextAllow));
  process.stdout.write(
    `[vibe-sprint-mode] OFF -- ${removedCount} preset rules removed. Remaining allow rules: ${nextAllow.length}\n`,
  );
}

function runStatus(rootDir) {
  const hasExtendedPreset = existsSync(getPresetPath(rootDir, 'extended'));
  const statusTier = hasExtendedPreset ? 'extended' : 'core';
  const presetRules = loadPreset(rootDir, statusTier);
  const presetSet = new Set(presetRules);
  const coreRules = hasExtendedPreset ? loadPreset(rootDir, 'core') : presetRules;
  const { settings } = loadSettings(rootDir, false);
  const currentAllow = settings === null ? [] : getAllowRules(settings);
  const activeSet = new Set(currentAllow.filter((entry) => presetSet.has(entry)));
  const activeCount = activeSet.size;
  const hasAllCoreRules = coreRules.every((entry) => activeSet.has(entry));
  const hasOnlyCoreRules = hasAllCoreRules && activeCount === coreRules.length;
  const hasAllPresetRules = activeCount === presetRules.length;
  const mode =
    hasExtendedPreset && activeCount > 0 && !hasOnlyCoreRules && !hasAllPresetRules
      ? 'PARTIAL'
      : activeCount > 0
        ? 'ON'
        : 'OFF';
  const tierLabel =
    hasExtendedPreset && mode === 'ON'
      ? hasAllPresetRules
        ? ' (extended)'
        : ' (core)'
      : '';

  process.stdout.write(
    `[vibe-sprint-mode] ${mode}${tierLabel} -- ${activeCount}/${presetRules.length} preset rules active\n`,
  );
}

function parseArgs(argv) {
  const command = argv[0];
  let tier = 'core';

  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg !== '--tier') {
      fail(`Unknown option: ${arg}`);
    }

    tier = argv[i + 1];
    i++;
  }

  if (!['core', 'extended'].includes(tier)) {
    fail(`Invalid --tier value: ${tier}. Expected core or extended.`);
  }

  return { command, tier };
}

function main() {
  const { command, tier } = parseArgs(process.argv.slice(2));

  if (command === 'on') {
    runOn(process.cwd(), tier);
    return;
  }

  if (command === 'off') {
    runOff(process.cwd());
    return;
  }

  if (command === 'status') {
    runStatus(process.cwd());
    return;
  }

  fail('Usage: node scripts/vibe-sprint-mode.mjs <on|off|status>');
}

try {
  main();
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
