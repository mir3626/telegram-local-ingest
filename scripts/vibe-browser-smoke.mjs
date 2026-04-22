#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SHARD_PATH = path.resolve('.claude/skills/test-patterns/typescript-playwright.md');
const SHARED_CONFIG_PATH = path.resolve('.vibe/config.json');
const LOCAL_CONFIG_PATH = path.resolve('.vibe/config.local.json');

function readJsonIfPresent(filePath) {
  if (!existsSync(filePath)) {
    return {};
  }

  return JSON.parse(readFileSync(filePath, 'utf8'));
}

export function loadBrowserSmokeSettings() {
  const shared = readJsonIfPresent(SHARED_CONFIG_PATH);
  const local = readJsonIfPresent(LOCAL_CONFIG_PATH);

  return {
    enabled: local.browserSmoke?.enabled ?? shared.browserSmoke?.enabled ?? false,
    configPath: local.browserSmoke?.configPath ?? shared.browserSmoke?.configPath ?? '.vibe/smoke.config.js',
    dist: local.browserSmoke?.dist ?? shared.browserSmoke?.dist ?? 'dist',
  };
}

function normalizeHostShape(value) {
  try {
    const url = new URL(value);
    return `${url.hostname}:${url.port || (url.protocol === 'https:' ? '443' : '80')}`;
  } catch {
    return null;
  }
}

export function checkContract(smokeConfig, shardText) {
  const warnings = [];

  if (smokeConfig && (smokeConfig.sleep != null || smokeConfig.delayMs != null)) {
    warnings.push('config has sleep/delayMs key; shard discourages fixed sleeps');
  }

  if (
    Array.isArray(smokeConfig?.expectDom) &&
    smokeConfig.expectDom.length > 0 &&
    smokeConfig.expectDom.every((selector) => typeof selector === 'string' && /^[#.]/.test(selector))
  ) {
    warnings.push('expectDom uses only ID/class selectors; shard prefers role-based locators');
  }

  const shardExample = shardText.match(/baseURL:\s*['"]([^'"]+)['"]/);
  const shardHostShape = shardExample?.[1] ? normalizeHostShape(shardExample[1]) : null;
  const smokeHostShape = typeof smokeConfig?.url === 'string' ? normalizeHostShape(smokeConfig.url) : null;
  if (shardHostShape && smokeHostShape && shardHostShape !== smokeHostShape) {
    warnings.push(`url host ${smokeHostShape} differs from shard example ${shardHostShape}`);
  }

  return warnings;
}

async function importSmokeConfig(configPath) {
  const configUrl = pathToFileURL(configPath);
  configUrl.searchParams.set('ts', `${Date.now()}`);
  const module = await import(configUrl.href);
  return module.default ?? module;
}

function hasPlaywrightInstalled(rootDir = process.cwd()) {
  return (
    existsSync(path.join(rootDir, 'node_modules', 'playwright', 'package.json')) ||
    existsSync(path.join(rootDir, 'node_modules', '@playwright', 'test', 'package.json'))
  );
}

async function loadPlaywrightModule() {
  try {
    return await import('playwright');
  } catch {
    return import('@playwright/test');
  }
}

async function main() {
  const settings = loadBrowserSmokeSettings();
  if (!settings.enabled) {
    process.stdout.write('[vibe-browser-smoke] disabled\n');
    return;
  }

  const configPath = path.resolve(settings.configPath);
  const smokeConfig = await importSmokeConfig(configPath);
  const shardText = existsSync(SHARD_PATH) ? readFileSync(SHARD_PATH, 'utf8') : '';
  for (const warning of checkContract(smokeConfig, shardText)) {
    process.stderr.write(`[vibe-browser-smoke] WARN: ${warning}\n`);
  }

  if (!hasPlaywrightInstalled()) {
    process.stderr.write(
      [
        '[vibe-browser-smoke] Playwright not installed in this project.',
        'Install:',
        '  npm install -D playwright @playwright/test',
        '  npx playwright install --with-deps chromium',
        'Then re-run: npm run vibe:browser-smoke',
        '',
      ].join('\n'),
    );
    process.exit(2);
  }

  const playwright = await loadPlaywrightModule();
  const browser = await playwright.chromium.launch({ headless: true });
  const consoleIssues = [];

  try {
    const viewport = smokeConfig.viewport ?? { width: 1280, height: 720 };
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();

    page.on('console', (message) => {
      const type = typeof message.type === 'function' ? message.type() : '';
      if (type === 'error' || type === 'warning' || type === 'warn') {
        consoleIssues.push(`${type}: ${message.text()}`);
      }
    });

    await page.goto(smokeConfig.url, { waitUntil: 'networkidle' });

    for (const selector of smokeConfig.expectDom ?? []) {
      await page.locator(selector).first().waitFor({ state: 'visible' });
    }

    if (smokeConfig.expectConsoleFree === true && consoleIssues.length > 0) {
      throw new Error(`console issues detected:\n${consoleIssues.join('\n')}`);
    }
  } finally {
    await browser.close();
  }
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
