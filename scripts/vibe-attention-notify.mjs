#!/usr/bin/env node

import { appendFile, mkdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

function rootDir() {
  return process.env.VIBE_ROOT ? path.resolve(process.env.VIBE_ROOT) : process.cwd();
}

async function readStdin(maxBytes = 65_536, timeoutMs = 2_000) {
  return new Promise((resolve) => {
    let done = false;
    let raw = '';
    const finish = () => {
      if (done) {
        return;
      }
      done = true;
      resolve(raw.slice(0, maxBytes));
    };
    const timer = setTimeout(finish, timeoutMs);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      raw += chunk;
      if (raw.length >= maxBytes) {
        clearTimeout(timer);
        finish();
      }
    });
    process.stdin.on('end', () => {
      clearTimeout(timer);
      finish();
    });
    process.stdin.on('error', () => {
      clearTimeout(timer);
      finish();
    });
    if (process.stdin.isTTY) {
      clearTimeout(timer);
      finish();
    }
  });
}

function detailFromRaw(raw) {
  if (raw.trim() === '') {
    return { detail: 'Permission prompt', rawPayload: null };
  }
  try {
    const parsed = JSON.parse(raw);
    const message =
      typeof parsed?.message === 'string'
        ? parsed.message
        : typeof parsed?.notification === 'string'
          ? parsed.notification
          : 'Permission prompt';
    return { detail: message, rawPayload: parsed };
  } catch {
    return { detail: raw.trim().slice(0, 500) || 'Permission prompt', rawPayload: raw };
  }
}

async function main() {
  try {
    const root = rootDir();
    const raw = await readStdin();
    const { detail, rawPayload } = detailFromRaw(raw);
    const event = {
      ts: new Date().toISOString(),
      id: crypto.randomUUID(),
      type: 'attention-needed',
      severity: 'urgent',
      source: 'claude-code-notification',
      title: 'User attention required',
      detail,
      payload: { raw: rawPayload },
    };
    const attentionPath = path.join(root, '.vibe', 'agent', 'attention.jsonl');
    await mkdir(path.dirname(attentionPath), { recursive: true });
    await appendFile(attentionPath, `${JSON.stringify(event)}\n`, { encoding: 'utf8', flag: 'a' });

    const scriptPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'vibe-daily-log.mjs');
    spawnSync(process.execPath, [scriptPath, 'attention-needed', '--payload', JSON.stringify(event)], {
      cwd: root,
      env: { ...process.env, VIBE_ROOT: root },
      stdio: 'ignore',
    });
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  }
}

main().finally(() => process.exit(0));
