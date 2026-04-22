#!/usr/bin/env node
// Provider-neutral session-start entrypoint.
// Runs best-effort lifecycle checks without polluting provider stdout.

import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = process.env.VIBE_ROOT ? path.resolve(process.env.VIBE_ROOT) : process.cwd();

const steps = [
  'vibe-session-started.mjs',
  'vibe-version-check.mjs',
  'vibe-model-registry-check.mjs',
];

function writeStderr(value) {
  if (value) {
    process.stderr.write(value.endsWith('\n') ? value : `${value}\n`);
  }
}

function runStep(scriptName) {
  const scriptPath = path.join(scriptDir, scriptName);
  if (!existsSync(scriptPath)) {
    return;
  }

  const child = spawnSync(process.execPath, [scriptPath], {
    cwd: root,
    env: { ...process.env, VIBE_ROOT: root },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  writeStderr(child.stdout ?? '');
  writeStderr(child.stderr ?? '');

  if (child.error) {
    writeStderr(`[vibe-agent-session-start] ${scriptName} skipped: ${child.error.message}`);
  } else if (typeof child.status === 'number' && child.status !== 0) {
    writeStderr(`[vibe-agent-session-start] ${scriptName} exited ${child.status}`);
  }
}

if (process.env.VIBE_SKIP_AGENT_SESSION_START === '1') {
  process.exit(0);
}

for (const step of steps) {
  runStep(step);
}

process.exit(0);
