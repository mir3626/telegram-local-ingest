#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const LOCAL_BOOTSTRAP = path.resolve('.vibe/harness/scripts/vibe-sync-bootstrap.mjs');
const DEFAULT_REMOTE_BOOTSTRAP =
  'https://raw.githubusercontent.com/mir3626/vibe-doctor/main/.vibe/harness/scripts/vibe-sync-bootstrap.mjs';

function runNode(scriptPath) {
  const result = spawnSync(process.execPath, [scriptPath, ...process.argv.slice(2)], {
    cwd: process.cwd(),
    env: process.env,
    stdio: 'inherit',
  });

  if (result.error) {
    process.stderr.write(`[vibe-sync-bootstrap bridge] ${result.error.message}\n`);
    process.exit(1);
  }
  process.exit(result.status ?? 1);
}

async function main() {
  if (existsSync(LOCAL_BOOTSTRAP)) {
    runNode(LOCAL_BOOTSTRAP);
  }

  const url = process.env.VIBE_DOCTOR_BOOTSTRAP_URL ?? DEFAULT_REMOTE_BOOTSTRAP;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`failed to fetch ${url}: HTTP ${response.status}`);
  }

  const tempDir = mkdtempSync(path.join(tmpdir(), 'vibe-sync-bootstrap-'));
  const tempScript = path.join(tempDir, 'vibe-sync-bootstrap.mjs');
  try {
    writeFileSync(tempScript, await response.text(), 'utf8');
    runNode(tempScript);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`[vibe-sync-bootstrap bridge] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
