#!/usr/bin/env node

import { appendFile, mkdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

function rootDir() {
  return process.env.VIBE_ROOT ? path.resolve(process.env.VIBE_ROOT) : process.cwd();
}

function parseArgs(argv) {
  const flags = {
    severity: 'urgent',
    title: 'User attention required',
    detail: 'Attention requested',
    source: 'orchestrator',
    provider: undefined,
    payload: undefined,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--severity') {
      flags.severity = argv[index + 1] ?? flags.severity;
      index += 1;
      continue;
    }
    if (token === '--title') {
      flags.title = argv[index + 1] ?? flags.title;
      index += 1;
      continue;
    }
    if (token === '--detail') {
      flags.detail = argv[index + 1] ?? flags.detail;
      index += 1;
      continue;
    }
    if (token === '--source') {
      flags.source = argv[index + 1] ?? flags.source;
      index += 1;
      continue;
    }
    if (token === '--provider') {
      flags.provider = argv[index + 1] ?? flags.provider;
      index += 1;
      continue;
    }
    if (token === '--payload') {
      const rawPayload = argv[index + 1] ?? '';
      try {
        flags.payload = JSON.parse(rawPayload);
      } catch {
        flags.payload = rawPayload;
      }
      index += 1;
    }
  }
  return flags;
}

function normalizeSeverity(value) {
  return value === 'info' || value === 'all' ? value : 'urgent';
}

export async function appendAttentionEvent(input, root = rootDir()) {
  const event = {
    ts: new Date().toISOString(),
    id: crypto.randomUUID(),
    type: 'attention-needed',
    severity: normalizeSeverity(input.severity),
    source: input.source || 'orchestrator',
    title: input.title || 'User attention required',
    detail: input.detail || 'Attention requested',
    ...(input.provider ? { provider: input.provider } : {}),
    ...(input.payload !== undefined ? { payload: input.payload } : {}),
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
  return event;
}

if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? '')).href) {
  appendAttentionEvent(parseArgs(process.argv.slice(2))).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
