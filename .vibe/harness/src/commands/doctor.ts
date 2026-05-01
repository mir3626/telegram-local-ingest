import process from 'node:process';
import { runMain } from '../lib/cli.js';
import { commandExists } from '../lib/shell.js';
import { logger } from '../lib/logger.js';

function nodeMajorVersion(): number {
  const version = process.versions.node.split('.')[0];
  return Number(version);
}

async function main(): Promise<void> {
  const checks = [
    ['node>=24', nodeMajorVersion() >= 24],
    ['npm', await commandExists('npm')],
    ['git', await commandExists('git')],
    ['claude (optional)', await commandExists('claude')],
    ['codex (optional)', await commandExists('codex')],
    ['gemini (optional)', await commandExists('gemini')],
  ] as const;

  for (const [name, ok] of checks) {
    const status = ok ? 'OK' : 'MISSING';
    logger.info(`${name}: ${status}`);
  }

  const hardFailures = checks.filter(([name, ok]) => !ok && !name.includes('optional'));
  if (hardFailures.length > 0) {
    process.exitCode = 1;
  }
}

runMain(main, import.meta.url);
