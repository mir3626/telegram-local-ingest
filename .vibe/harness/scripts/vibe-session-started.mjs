#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

function rootDir() {
  return process.env.VIBE_ROOT ? path.resolve(process.env.VIBE_ROOT) : process.cwd();
}

function readJsonIfExists(filePath, fallback) {
  if (!existsSync(filePath)) {
    return fallback;
  }
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function readPid(pidPath) {
  if (!existsSync(pidPath)) {
    return null;
  }
  const pid = Number(readFileSync(pidPath, 'utf8').trim());
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function appendSessionStarted(root) {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  spawnSync(process.execPath, [
    path.join(scriptDir, 'vibe-daily-log.mjs'),
    'session-started',
    '--payload',
    JSON.stringify({ cwd: root }),
  ], {
    cwd: root,
    env: { ...process.env, VIBE_ROOT: root },
    stdio: 'ignore',
  });
}

function maybeStartDashboard(root) {
  const config = readJsonIfExists(path.join(root, '.vibe', 'config.json'), {});
  if (config?.dashboard?.autoStart !== true) {
    return;
  }

  const pidPath = path.join(root, '.vibe', 'agent', 'dashboard.pid');
  const pid = readPid(pidPath);
  if (pid && processAlive(pid)) {
    return;
  }

  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const child = spawn(process.execPath, [path.join(scriptDir, 'vibe-dashboard.mjs'), '--detach'], {
    cwd: root,
    env: { ...process.env, VIBE_ROOT: root },
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
}

try {
  const root = rootDir();
  appendSessionStarted(root);
  maybeStartDashboard(root);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
}

process.exit(0);
