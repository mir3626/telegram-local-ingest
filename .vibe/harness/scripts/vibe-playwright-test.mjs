#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';

const require = createRequire(import.meta.url);
const root = process.cwd();
const defaultConfig = path.join(root, '.vibe', 'harness', 'playwright.config.ts');

function printInstallGuidance() {
  process.stderr.write(
    [
      '[vibe:test-ui] @playwright/test is not installed in this project.',
      '',
      'Install the harness UI test dependency and Chromium browser binaries:',
      '  npm install -D @playwright/test',
      '  npx playwright install --with-deps chromium',
      '',
      'Then retry:',
      '  npm run vibe:test-ui',
      '',
    ].join('\n'),
  );
}

function resolvePlaywrightCli() {
  try {
    return path.join(path.dirname(require.resolve('@playwright/test/package.json', { paths: [root] })), 'cli.js');
  } catch {
    return null;
  }
}

const PLAYWRIGHT_COMMANDS = new Set([
  'open',
  'codegen',
  'install',
  'uninstall',
  'install-deps',
  'cr',
  'ff',
  'wk',
  'screenshot',
  'pdf',
  'show-trace',
  'trace',
  'test',
  'show-report',
  'merge-reports',
  'clear-cache',
  'init-agents',
  'help',
]);

function resolvePlaywrightArgs(args) {
  if (args.length === 0) {
    return ['test', '--config', defaultConfig];
  }

  const [first] = args;
  if (first === '--version' || first === '-V' || first === '--help' || first === '-h') {
    return args;
  }

  if (first && PLAYWRIGHT_COMMANDS.has(first)) {
    if (first === 'test' && !args.some((arg) => arg === '--config' || arg.startsWith('--config='))) {
      return ['test', '--config', defaultConfig, ...args.slice(1)];
    }
    return args;
  }

  return ['test', '--config', defaultConfig, ...args];
}

const cliPath = resolvePlaywrightCli();
if (!cliPath) {
  printInstallGuidance();
  process.exit(1);
}

const child = spawn(process.execPath, [cliPath, ...resolvePlaywrightArgs(process.argv.slice(2))], {
  cwd: root,
  env: process.env,
  stdio: 'inherit',
});

child.on('error', (error) => {
  process.stderr.write(`[vibe:test-ui] failed to start Playwright: ${error.message}\n`);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.stderr.write(`[vibe:test-ui] Playwright exited from signal ${signal}\n`);
    process.exit(1);
  }
  process.exit(code ?? 1);
});
