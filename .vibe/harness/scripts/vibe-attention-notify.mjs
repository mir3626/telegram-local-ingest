#!/usr/bin/env node

import path from 'node:path';
import process from 'node:process';
import { appendAttentionEvent } from './vibe-attention.mjs';

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

function titleForNotificationType(notificationType) {
  if (notificationType === 'permission_prompt') {
    return 'Claude permission required';
  }
  if (notificationType === 'idle_prompt') {
    return 'Claude is ready';
  }
  if (notificationType === 'elicitation_dialog') {
    return 'Claude needs input';
  }
  return 'User attention required';
}

function severityForNotificationType(notificationType) {
  return notificationType === 'idle_prompt' || notificationType === 'auth_success' ? 'info' : 'urgent';
}

function notificationFromRaw(raw) {
  if (raw.trim() === '') {
    return {
      detail: 'Permission prompt',
      rawPayload: null,
      notificationType: 'permission_prompt',
      title: titleForNotificationType('permission_prompt'),
      severity: 'urgent',
    };
  }
  try {
    const parsed = JSON.parse(raw);
    const notificationType =
      typeof parsed?.notification_type === 'string' ? parsed.notification_type : 'unknown';
    const message =
      typeof parsed?.message === 'string'
        ? parsed.message
        : typeof parsed?.notification === 'string'
          ? parsed.notification
          : 'Permission prompt';
    return {
      detail: message,
      rawPayload: parsed,
      notificationType,
      title:
        typeof parsed?.title === 'string' && parsed.title.trim() !== ''
          ? parsed.title
          : titleForNotificationType(notificationType),
      severity: severityForNotificationType(notificationType),
    };
  } catch {
    return {
      detail: raw.trim().slice(0, 500) || 'Permission prompt',
      rawPayload: raw,
      notificationType: 'unknown',
      title: 'User attention required',
      severity: 'urgent',
    };
  }
}

async function main() {
  try {
    const root = rootDir();
    const raw = await readStdin();
    const { detail, rawPayload, notificationType, title, severity } = notificationFromRaw(raw);
    await appendAttentionEvent({
      severity,
      source: 'claude-code-notification',
      provider: 'claude',
      title,
      detail,
      payload: { notificationType, raw: rawPayload },
    }, root);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  }
}

main().finally(() => process.exit(0));
