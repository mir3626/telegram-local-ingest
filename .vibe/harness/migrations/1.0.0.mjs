#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

try {
  const root = process.argv[2] ? resolve(process.argv[2]) : process.cwd();
  const configPath = resolve(root, '.vibe/config.json');
  if (!existsSync(configPath)) {
    process.exit(0);
  }

  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  const version = config.harnessVersion ?? config.harnessVersionInstalled ?? '1.0.0';
  const nextConfig = {
    ...config,
    harnessVersion: version,
    harnessVersionInstalled: config.harnessVersionInstalled ?? version,
  };

  writeFileSync(configPath, `${JSON.stringify(nextConfig, null, 2)}\n`, 'utf8');
  process.exit(0);
} catch {
  process.exit(0);
}
