#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const mode = process.argv.includes('--write') ? 'write' : 'check';
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const tsxLoader = [
  path.join(scriptDir, '..', 'node_modules', 'tsx', 'dist', 'loader.mjs'),
  path.join(scriptDir, '..', '..', '..', 'node_modules', 'tsx', 'dist', 'loader.mjs'),
].find((candidate) => existsSync(candidate));
const tsxImport = tsxLoader ? pathToFileURL(tsxLoader).href : 'tsx';
const result = spawnSync(
  process.execPath,
  ['--import', tsxImport, path.join(scriptDir, 'vibe-gen-schemas-impl.ts'), `--mode=${mode}`],
  {
    stdio: 'inherit',
  },
);

process.exit(result.status ?? 1);
