#!/usr/bin/env node
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const args = new Set(process.argv.slice(2));
const install = args.has('--install');
const requiredPackages = ['tsx', 'zod'];

function npmCommand() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function hasPackage(packageName) {
  return existsSync(path.join(root, 'node_modules', packageName, 'package.json'));
}

function missingPackages() {
  return requiredPackages.filter((packageName) => !hasPackage(packageName));
}

function printDependencyHelp(missing) {
  process.stderr.write(
    [
      `[vibe-review-inputs] missing dependencies: ${missing.join(', ')}`,
      'Run one of:',
      '  node .vibe/harness/scripts/vibe-review-inputs.mjs --install',
      '  npm install && node .vibe/harness/scripts/vibe-review-inputs.mjs',
      '',
    ].join('\n'),
  );
}

let missing = missingPackages();
if (missing.length > 0 && install) {
  const result = spawnSync(npmCommand(), ['install'], {
    cwd: root,
    env: process.env,
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    process.exitCode = result.status ?? 1;
    process.exit();
  }
  missing = missingPackages();
}

if (missing.length > 0) {
  printDependencyHelp(missing);
  process.exitCode = 1;
  process.exit();
}

const tsxLoader = path.join(root, 'node_modules', 'tsx', 'dist', 'loader.mjs');
if (!existsSync(tsxLoader)) {
  process.stderr.write(`[vibe-review-inputs] tsx loader not found at ${tsxLoader}\n`);
  process.exitCode = 1;
  process.exit();
}

const reviewModuleUrl = pathToFileURL(path.join(root, '.vibe', 'harness', 'src', 'lib', 'review.ts')).href;
const configPath = path.join(root, '.vibe', 'config.json');
const code = `
import { readFile } from 'node:fs/promises';
import { collectReviewInputs, detectOptInGaps } from ${JSON.stringify(reviewModuleUrl)};

(async () => {
  const inputs = await collectReviewInputs();
  const config = JSON.parse(await readFile(${JSON.stringify(configPath)}, 'utf8'));
  const issues = detectOptInGaps(config, {
    productText: inputs.productText,
    sessionLogRecent: inputs.recentSessionEntries,
  });
  console.log(JSON.stringify({ inputs, issues }, null, 2));
})().catch((error) => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  console.error(message);
  process.exit(1);
});
`;

const result = spawnSync(
  process.execPath,
  ['--import', pathToFileURL(tsxLoader).href, '--input-type=module', '--eval', code],
  {
    cwd: root,
    env: { ...process.env, VIBE_ROOT: root },
    stdio: 'inherit',
  },
);

process.exitCode = result.status ?? 1;
