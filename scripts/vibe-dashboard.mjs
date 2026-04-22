#!/usr/bin/env node

import http from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, statSync, watch as fsWatch } from 'node:fs';
import { mkdir, readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const DEFAULT_PORT = 5175;
const DEFAULT_HOST = '127.0.0.1';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAILY_FILE_RE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;
const WATCH_DEBOUNCE_MS = 150;
const POLL_MS = 2_000;
const HEARTBEAT_MS = 20_000;

function rootDir() {
  return process.env.VIBE_ROOT ? path.resolve(process.env.VIBE_ROOT) : process.cwd();
}

function agentDir(root) {
  return path.join(root, '.vibe', 'agent');
}

function pidPath(root) {
  return path.join(agentDir(root), 'dashboard.pid');
}

function parseArgs(argv) {
  const flags = {
    port: null,
    host: null,
    noOpen: false,
    detach: false,
    stop: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--port') {
      flags.port = Number(argv[index + 1]);
      index += 1;
      continue;
    }
    if (token === '--host') {
      flags.host = argv[index + 1] ?? null;
      index += 1;
      continue;
    }
    if (token === '--no-open') {
      flags.noOpen = true;
      continue;
    }
    if (token === '--detach') {
      flags.detach = true;
      continue;
    }
    if (token === '--stop') {
      flags.stop = true;
    }
  }
  return flags;
}

async function readOptionalText(filePath, fallback = '') {
  try {
    return await readFile(filePath, 'utf8');
  } catch {
    return fallback;
  }
}

async function readOptionalJson(filePath, fallback) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function utcDate(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'UTC',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

function isValidDateShard(date) {
  if (!DATE_RE.test(date)) {
    return false;
  }
  const parsed = new Date(`${date}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date;
}

function readPidText(text) {
  const pid = Number(text.trim());
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

async function readPid(root) {
  try {
    return readPidText(await readFile(pidPath(root), 'utf8'));
  } catch {
    return null;
  }
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function stopDashboard(root) {
  const pid = await readPid(root);
  if (!pid) {
    process.stdout.write('dashboard not running\n');
    return;
  }
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    // stale pid is still cleaned below
  }
  await unlink(pidPath(root)).catch(() => {});
  process.stdout.write(`dashboard stopped pid=${pid}\n`);
}

function openBrowser(url, spawnFn = spawn, platform = process.platform) {
  const argsByPlatform =
    platform === 'win32'
      ? ['cmd', ['/c', 'start', '""', url]]
      : platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];
  const child = spawnFn(argsByPlatform[0], argsByPlatform[1], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
}

async function resolveConfig(root) {
  const config = await readOptionalJson(path.join(root, '.vibe', 'config.json'), {});
  return isRecord(config?.dashboard) ? config.dashboard : {};
}

async function resolveHostPort(root, flags) {
  const dashboard = await resolveConfig(root);
  const host = flags.host ?? (typeof dashboard.host === 'string' ? dashboard.host : DEFAULT_HOST);
  const configPort = Number(dashboard.port);
  const port = flags.port ?? (Number.isInteger(configPort) ? configPort : DEFAULT_PORT);
  return { host, port };
}

function parseRoadmapPointer(roadmapMd) {
  const marker = roadmapMd.match(
    /<!-- BEGIN:VIBE:CURRENT-SPRINT -->[\s\S]*?Current\*\*:\s*([^\s(]+)[\s\S]*?<!-- END:VIBE:CURRENT-SPRINT -->/,
  );
  return marker?.[1] ?? null;
}

function parseRoadmapSprintIds(roadmapMd) {
  const ids = [];
  const directMatches = roadmapMd.matchAll(/-\s+\*\*id\*\*:\s+`([^`]+)`/g);
  for (const match of directMatches) {
    if (match[1]) {
      ids.push(match[1]);
    }
  }
  if (ids.length > 0) {
    return [...new Set(ids)];
  }
  return [...roadmapMd.matchAll(/\b(sprint-[A-Za-z0-9_.-]+|M\d+[A-Za-z0-9_.-]*)\b/g)]
    .map((match) => match[1])
    .filter(Boolean);
}

function sprintState(sprintId, status, currentSprintId) {
  const entry = Array.isArray(status?.sprints)
    ? status.sprints.find((sprint) => sprint?.id === sprintId)
    : null;
  if (entry?.status === 'passed' || entry?.status === 'failed') {
    return entry.status;
  }
  if (entry?.status === 'in_progress' || sprintId === currentSprintId) {
    return 'in-progress';
  }
  return 'pending';
}

function parsePhases(productMd, handoffMd) {
  const haystack = `${productMd}\n${handoffMd}`.toLowerCase();
  return ['0', '1', '2', '3', '4'].map((phase) => {
    const complete = haystack.includes(`phase ${phase}`) && /complete|completed|sealed|done|idle/.test(haystack);
    const active = haystack.includes(`phase ${phase}`) && !complete;
    return {
      id: `Phase ${phase}`,
      state: complete ? 'complete' : active ? 'active' : 'pending',
    };
  });
}

async function listAvailableDates(root) {
  try {
    return (await readdir(path.join(agentDir(root), 'daily')))
      .map((entry) => entry.match(DAILY_FILE_RE)?.[1])
      .filter(Boolean)
      .sort((left, right) => right.localeCompare(left));
  } catch {
    return [];
  }
}

function parseJsonl(raw) {
  return raw
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '')
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

async function readDaily(root, date, limit = 500) {
  const raw = await readFile(path.join(agentDir(root), 'daily', `${date}.jsonl`), 'utf8');
  const events = parseJsonl(raw);
  const truncated = events.length > limit;
  return { date, events: events.slice(-limit), truncated };
}

async function readAttention(root, sinceIso = null) {
  const raw = await readOptionalText(path.join(agentDir(root), 'attention.jsonl'), '');
  const since = sinceIso ? Date.parse(sinceIso) : Date.now() - 24 * 60 * 60 * 1_000;
  return parseJsonl(raw).filter((event) => {
    const ts = Date.parse(String(event?.ts ?? ''));
    return Number.isFinite(ts) && ts >= since;
  });
}

function latestTestResult(todayEvents) {
  const latest = [...todayEvents]
    .reverse()
    .find((event) => event?.type === 'test-failed' || event?.type === 'sprint-completed');
  if (!latest) {
    return null;
  }
  return {
    type: latest.type,
    ts: latest.ts,
    summary: summarizeEvent(latest),
  };
}

function summarizeEvent(event) {
  const payload = isRecord(event?.payload) ? event.payload : {};
  if (typeof payload.summary === 'string') {
    return payload.summary;
  }
  if (typeof payload.detail === 'string') {
    return payload.detail;
  }
  if (typeof payload.title === 'string') {
    return payload.title;
  }
  if (typeof payload.sprintId === 'string') {
    return `${payload.sprintId} ${payload.status ?? ''}`.trim();
  }
  if (typeof payload.phase === 'string') {
    return `${payload.phase} ${payload.ambiguity ?? ''}`.trim();
  }
  if (typeof event?.type === 'string') {
    return event.type;
  }
  return 'event';
}

async function buildState(root) {
  const [
    sprintStatus,
    handoffMd,
    iteration,
    tokens,
    roadmapMd,
    productMd,
    todayEventsResult,
  ] = await Promise.all([
    readOptionalJson(path.join(agentDir(root), 'sprint-status.json'), {}),
    readOptionalText(path.join(agentDir(root), 'handoff.md'), ''),
    readOptionalJson(path.join(agentDir(root), 'iteration-history.json'), {
      currentIteration: null,
      iterations: [],
    }),
    readOptionalJson(path.join(agentDir(root), 'tokens.json'), {}),
    readOptionalText(path.join(root, 'docs', 'plans', 'sprint-roadmap.md'), ''),
    readOptionalText(path.join(root, 'docs', 'context', 'product.md'), ''),
    readDaily(root, utcDate(), 50).catch(() => ({ date: utcDate(), events: [], truncated: false })),
  ]);
  const currentSprint =
    sprintStatus?.handoff?.currentSprintId ??
    parseRoadmapPointer(roadmapMd) ??
    'idle';
  const roadmapIds = parseRoadmapSprintIds(roadmapMd);
  const sprintIds =
    roadmapIds.length > 0
      ? roadmapIds
      : Array.isArray(sprintStatus?.sprints)
        ? sprintStatus.sprints.map((entry) => entry.id).filter(Boolean)
        : [];
  const sprintNodes = sprintIds.map((id) => ({
    id,
    state: sprintState(id, sprintStatus, currentSprint),
  }));
  const risks = Array.isArray(sprintStatus?.pendingRisks)
    ? sprintStatus.pendingRisks.filter((risk) => risk?.status === 'open')
    : [];
  return {
    roadmap: {
      current: currentSprint,
      phases: parsePhases(productMd, handoffMd),
      sprints: sprintNodes,
    },
    currentSprint: {
      id: currentSprint,
      status:
        Array.isArray(sprintStatus?.sprints)
          ? sprintStatus.sprints.find((entry) => entry?.id === currentSprint)?.status ?? 'idle'
          : 'idle',
      startedAt:
        Array.isArray(sprintStatus?.sprints)
          ? sprintStatus.sprints.find((entry) => entry?.id === currentSprint)?.startedAt ?? null
          : null,
    },
    iteration,
    todayEvents: todayEventsResult.events,
    risks,
    tokens,
    latestTest: latestTestResult(todayEventsResult.events),
    updatedAt: new Date().toISOString(),
  };
}

function jsonResponse(response, status, value) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(JSON.stringify(value));
}

function textResponse(response, status, value, contentType = 'text/plain; charset=utf-8') {
  response.writeHead(status, {
    'content-type': contentType,
    'cache-control': 'no-store',
  });
  response.end(value);
}

function sseSend(response, event, data) {
  response.write(`event: ${event}\n`);
  response.write(`data: ${JSON.stringify(data)}\n\n`);
}

class DashboardEvents {
  constructor(root) {
    this.root = root;
    this.clients = new Set();
    this.watchers = [];
    this.pollTimer = null;
    this.debounce = new Map();
    this.statCache = new Map();
    this.attentionOffset = 0;
  }

  async init() {
    const attentionPath = path.join(agentDir(this.root), 'attention.jsonl');
    if (existsSync(attentionPath)) {
      this.attentionOffset = statSync(attentionPath).size;
    }
    await mkdir(path.join(agentDir(this.root), 'daily'), { recursive: true }).catch(() => {});
    this.setupWatchers();
  }

  addClient(response) {
    this.clients.add(response);
    response.write(': ping\n\n');
    const timer = setInterval(() => {
      response.write(': ping\n\n');
    }, HEARTBEAT_MS);
    response.on('close', () => {
      clearInterval(timer);
      this.clients.delete(response);
    });
  }

  emitState(files) {
    for (const client of this.clients) {
      sseSend(client, 'state-updated', { files });
    }
  }

  emitAttention(event) {
    for (const client of this.clients) {
      sseSend(client, 'attention', event);
    }
  }

  schedule(file) {
    clearTimeout(this.debounce.get(file));
    const timer = setTimeout(() => {
      this.debounce.delete(file);
      this.emitState([file]);
      if (file.endsWith('attention.jsonl')) {
        this.emitNewAttention().catch((error) => {
          process.stderr.write(`dashboard attention watch failed: ${error.message}\n`);
        });
      }
    }, WATCH_DEBOUNCE_MS);
    this.debounce.set(file, timer);
  }

  setupWatchers() {
    const targets = [
      agentDir(this.root),
      path.join(agentDir(this.root), 'sprint-status.json'),
      path.join(agentDir(this.root), 'handoff.md'),
      path.join(agentDir(this.root), 'iteration-history.json'),
      path.join(agentDir(this.root), 'tokens.json'),
      path.join(agentDir(this.root), 'attention.jsonl'),
      path.join(agentDir(this.root), 'daily'),
      path.join(this.root, 'docs', 'plans', 'sprint-roadmap.md'),
    ];
    try {
      for (const target of targets) {
        if (!existsSync(target)) {
          continue;
        }
        const watcher = fsWatch(target, () => {
          if (target === agentDir(this.root)) {
            this.schedule('attention.jsonl');
            return;
          }
          this.schedule(path.relative(agentDir(this.root), target).replace(/\\/g, '/'));
        });
        watcher.on('error', () => this.setupPolling(targets));
        this.watchers.push(watcher);
      }
      if (this.watchers.length === 0) {
        this.setupPolling(targets);
      }
    } catch {
      this.setupPolling(targets);
    }
  }

  setupPolling(targets) {
    if (this.pollTimer) {
      return;
    }
    for (const watcher of this.watchers) {
      watcher.close();
    }
    this.watchers = [];
    this.pollTimer = setInterval(async () => {
      for (const target of targets) {
        try {
          const current = await stat(target);
          const key = target;
          const previous = this.statCache.get(key);
          const label =
            target === agentDir(this.root)
              ? 'attention.jsonl'
              : path.relative(agentDir(this.root), target).replace(/\\/g, '/');
          if (previous !== undefined && previous !== current.mtimeMs) {
            this.schedule(label);
          } else if (
            previous === undefined &&
            target.endsWith('attention.jsonl') &&
            current.size > this.attentionOffset
          ) {
            this.schedule(label);
          }
          this.statCache.set(key, current.mtimeMs);
        } catch {
          // Missing files are normal before the first sprint event.
        }
      }
    }, POLL_MS);
  }

  async emitNewAttention() {
    const filePath = path.join(agentDir(this.root), 'attention.jsonl');
    const raw = await readOptionalText(filePath, '');
    const next = raw.slice(this.attentionOffset);
    this.attentionOffset = Buffer.byteLength(raw, 'utf8');
    for (const event of parseJsonl(next)) {
      this.emitAttention(event);
    }
  }

  close() {
    for (const watcher of this.watchers) {
      watcher.close();
    }
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
    }
    for (const client of this.clients) {
      client.write('retry: 0\n\n');
      client.end();
    }
    this.clients.clear();
  }
}

async function handleRequest(root, events, request, response) {
  if (request.method !== 'GET') {
    textResponse(response, 405, 'method not allowed');
    return;
  }
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  if (url.pathname === '/') {
    textResponse(response, 200, renderShellHtml(), 'text/html; charset=utf-8');
    return;
  }
  if (url.pathname === '/icon.svg') {
    textResponse(response, 200, renderIconSvg(), 'image/svg+xml; charset=utf-8');
    return;
  }
  if (url.pathname === '/api/state') {
    jsonResponse(response, 200, await buildState(root));
    return;
  }
  if (url.pathname === '/api/daily-index') {
    jsonResponse(response, 200, { dates: await listAvailableDates(root) });
    return;
  }
  if (url.pathname.startsWith('/api/daily/')) {
    const date = decodeURIComponent(url.pathname.slice('/api/daily/'.length));
    if (!isValidDateShard(date)) {
      jsonResponse(response, 400, { error: 'invalid date' });
      return;
    }
    try {
      jsonResponse(response, 200, await readDaily(root, date, 500));
    } catch (error) {
      if (error?.code === 'ENOENT') {
        jsonResponse(response, 404, { error: 'daily log not found' });
        return;
      }
      throw error;
    }
    return;
  }
  if (url.pathname === '/api/attention') {
    jsonResponse(response, 200, { events: await readAttention(root, url.searchParams.get('since')) });
    return;
  }
  if (url.pathname === '/events') {
    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
    });
    events.addClient(response);
    return;
  }
  jsonResponse(response, 404, { error: 'not found' });
}

async function listenWithPortDiscovery(server, host, requestedPort) {
  for (let offset = 0; offset <= 10; offset += 1) {
    const port = requestedPort + offset;
    const result = await new Promise((resolve) => {
      const onError = (error) => {
        server.off('listening', onListening);
        resolve({ ok: false, error });
      };
      const onListening = () => {
        server.off('error', onError);
        resolve({ ok: true, port });
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, host);
    });
    if (result.ok) {
      return result.port;
    }
    if (result.error?.code !== 'EADDRINUSE') {
      throw result.error;
    }
  }
  throw new Error(`port unavailable: ${requestedPort}..${requestedPort + 10}`);
}

export async function runDashboard(argv = process.argv.slice(2), options = {}) {
  const root = path.resolve(options.root ?? rootDir());
  const flags = parseArgs(argv);
  const { host, port } = await resolveHostPort(root, flags);
  if (host !== '127.0.0.1' && host !== 'localhost') {
    process.stderr.write('localhost only: dashboard refuses non-localhost bind addresses\n');
    return 1;
  }
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    process.stderr.write(`invalid port: ${port}\n`);
    return 1;
  }
  if (flags.stop) {
    await stopDashboard(root);
    return 0;
  }

  const existingPid = await readPid(root);
  if (existingPid && existingPid !== process.pid && processAlive(existingPid)) {
    process.stdout.write(`dashboard already running at http://127.0.0.1:${port}\n`);
    return 0;
  }
  if (existingPid && existingPid !== process.pid) {
    await unlink(pidPath(root)).catch(() => {});
  }

  if (flags.detach) {
    const childArgs = process.argv
      .slice(1)
      .filter((arg) => arg !== '--detach');
    const child = spawn(process.execPath, childArgs, {
      cwd: root,
      env: { ...process.env, VIBE_ROOT: root },
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    if (child.pid) {
      await mkdir(agentDir(root), { recursive: true });
      await writeFile(pidPath(root), `${child.pid}\n`, 'utf8');
    }
    process.stdout.write(`dashboard starting pid=${child.pid ?? 'unknown'}\n`);
    return 0;
  }

  const sse = new DashboardEvents(root);
  await sse.init();
  const server = http.createServer((request, response) => {
    handleRequest(root, sse, request, response).catch((error) => {
      jsonResponse(response, 500, { error: error instanceof Error ? error.message : String(error) });
    });
  });
  const actualPort = await listenWithPortDiscovery(server, host, port);
  await mkdir(agentDir(root), { recursive: true });
  await writeFile(pidPath(root), `${process.pid}\n`, 'utf8');

  const url = `http://127.0.0.1:${actualPort}`;
  process.stdout.write(`${url}\n`);
  if (!flags.noOpen) {
    try {
      openBrowser(url);
    } catch (error) {
      process.stderr.write(`Warning: could not open dashboard: ${error.message}\n`);
    }
  }

  const shutdown = () => {
    sse.close();
    server.close(() => {
      unlink(pidPath(root)).catch(() => {}).finally(() => process.exit(0));
    });
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  return 0;
}

function renderIconSvg() {
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="12" fill="#111827"/><path d="M16 34h11l5-16 6 28 5-12h5" fill="none" stroke="#2dd4bf" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
}

function renderShellHtml() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Vibe Dashboard</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@500;600&display=swap" rel="stylesheet">
<style>
:root{color-scheme:light;--bg-0:#f1efea;--bg-1:#eae7e1;--bg-2:#e2ded7;--frame-bg:rgba(255,255,255,0.35);--text:#1c1c1e;--secondary:rgba(60,60,67,0.82);--muted:rgba(60,60,67,0.58);--border:rgba(60,60,67,0.14);--border-strong:rgba(60,60,67,0.22);--accent:#007aff;--accent-subtle:rgba(0,122,255,0.12);--glass-bg:rgba(255,255,255,0.72);--glass-bg-flat:rgba(255,255,255,0.78);--glass-highlight:inset 0 1px 0 rgba(255,255,255,0.85),inset 0 -1px 0 rgba(0,0,0,0.03);--glass-depth:0 1px 2px rgba(60,60,67,0.06),0 4px 14px rgba(60,60,67,0.08),0 18px 40px rgba(60,60,67,0.06);--complete-bg:rgba(52,199,89,0.18);--complete-text:#1f7a36;--progress-bg:rgba(0,122,255,0.16);--progress-text:#0057b3;--partial-bg:rgba(255,149,0,0.2);--partial-text:#aa5c00;--failed-bg:rgba(255,59,48,0.18);--failed-text:#a9211b;--idle-bg:rgba(120,120,128,0.16);--idle-text:rgba(60,60,67,0.72);--loc-add:#1f7a36;--loc-del:#a9211b;--loc-net-neutral:rgba(60,60,67,0.7)}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;background:linear-gradient(180deg,#edeae3 0%,#e6e2db 60%,#deded6 100%);background-attachment:fixed;color:var(--text);font-family:-apple-system,BlinkMacSystemFont,"SF Pro Display",Inter,"Segoe UI",Roboto,"Helvetica Neue",sans-serif;font-size:15px;line-height:1.65;padding:0;font-variant-numeric:tabular-nums}
a{color:var(--accent);text-decoration:none}
a:hover{text-decoration:underline;text-underline-offset:3px}
button{font:inherit;color:inherit;background:transparent;border:0;padding:0;cursor:pointer}
button:focus-visible,a:focus-visible,summary:focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:4px}
code,time,.mono{font-family:"JetBrains Mono","SF Mono",Menlo,Consolas,monospace;font-size:13px;font-weight:500}
.muted{color:var(--muted)}
.skip-link{position:absolute;left:32px;top:24px;z-index:20;transform:translateY(-160%);background:var(--glass-bg-flat);border:1px solid var(--border);color:var(--text);border-radius:8px;padding:10px 16px;backdrop-filter:blur(24px);-webkit-backdrop-filter:blur(24px)}
.skip-link:focus{transform:translateY(0)}
.outer-frame{border:0;border-radius:0;padding:0;min-height:100vh;background:transparent;position:relative;overflow:visible}
.site-nav{position:fixed;top:16px;left:50%;transform:translateX(-50%);width:calc(100% - 48px);max-width:1552px;z-index:10;display:grid;grid-template-columns:1fr auto 1fr;align-items:center;gap:24px;padding:11px 22px;background:transparent;border:1px solid var(--border);border-radius:999px;backdrop-filter:blur(60px) saturate(100%);-webkit-backdrop-filter:blur(60px) saturate(100%);box-shadow:inset 0 1px 0 rgba(255,255,255,0.85),0 1px 2px rgba(0,0,0,0.03),0 8px 24px rgba(0,0,0,0.05);will-change:transform}
.site-nav .brand{justify-self:start}
.site-nav .nav-anchors{justify-self:center}
.site-nav .nav-meta{justify-self:end}
.site-nav::after{content:"";position:absolute;inset:1px;border-radius:inherit;pointer-events:none;background:linear-gradient(180deg,rgba(255,255,255,0.08),transparent 42%)}
.brand{display:flex;align-items:center;gap:12px;font-weight:600}
.brand-name{font-size:16px;font-weight:600;letter-spacing:0.04em;font-style:normal;text-transform:none;background:linear-gradient(120deg,#f5f5f7 0%,#8e8e93 25%,#3a3a3c 50%,#8e8e93 75%,#f5f5f7 100%);-webkit-background-clip:text;background-clip:text;color:transparent;background-size:200% 100%;background-position:50% 50%}
.orb{width:36px;height:36px;position:relative;border-radius:50%;overflow:hidden;flex-shrink:0;background:rgba(255,255,255,0.35);box-shadow:inset 0 1px 0 rgba(255,255,255,0.9),0 1px 3px rgba(0,0,0,0.08),0 6px 14px rgba(60,60,67,0.1)}
.orb-core{position:absolute;inset:-22%;border-radius:50%;background:conic-gradient(from 40deg at 50% 50%,#ffffff 0deg,#d1d1d6 55deg,#8e8e93 110deg,#d1d1d6 160deg,#ffffff 220deg,#a8a8ad 285deg,#ffffff 360deg);animation:orb-spin 14s linear infinite;filter:blur(1.4px) saturate(105%);transform-origin:50% 50%;will-change:transform}
.orb-glass{position:absolute;inset:0;border-radius:50%;background:radial-gradient(circle at 30% 26%,rgba(255,255,255,0.85) 0%,rgba(255,255,255,0.32) 18%,rgba(255,255,255,0) 42%),radial-gradient(circle at 72% 78%,rgba(80,80,90,0.3) 0%,transparent 58%);opacity:0.95}
.orb::after{content:"";position:absolute;inset:0;border-radius:50%;box-shadow:inset 0 0 0 1px rgba(255,255,255,0.55),inset -4px -6px 12px rgba(60,60,67,0.18),inset 3px 4px 8px rgba(255,255,255,0.4);pointer-events:none}
@keyframes orb-spin{to{transform:rotate(360deg)}}
.nav-anchors{display:flex;gap:2px;list-style:none;margin:0;padding:0}
.nav-anchors a{display:inline-block;padding:6px 14px;font-size:13px;color:var(--secondary);border-radius:999px;transition:background .2s ease,color .2s ease;text-decoration:none}
.nav-anchors a:hover{background:linear-gradient(135deg,rgba(245,245,247,0.6),rgba(180,180,185,0.35));color:#1c1c1e;text-decoration:none;box-shadow:inset 0 1px 0 rgba(255,255,255,0.9)}
.nav-meta{display:flex;align-items:center;gap:12px;font-size:12px;color:var(--muted);font-family:"JetBrains Mono","SF Mono",Menlo,Consolas,monospace}
.container{max-width:1600px;margin:0 auto;padding:0 24px}
main.container{padding-top:90px;padding-bottom:0;padding-left:24px;padding-right:24px}
.hero{padding:50px 0 62px;max-width:860px}
.eyebrow{font-size:11px;font-weight:600;letter-spacing:0.18em;text-transform:uppercase;color:var(--muted);margin:0 0 16px}
h1{font-size:56px;line-height:1.05;font-weight:600;letter-spacing:-0.02em;margin:0 0 20px;color:var(--text)}
h2{font-size:28px;line-height:1.2;font-weight:600;letter-spacing:-0.01em;color:var(--text);margin:0}
h3{font-size:16px;line-height:1.4;font-weight:600;color:var(--text);margin:0}
.subtitle{font-size:17px;line-height:1.55;color:var(--secondary);margin:0 0 24px;max-width:720px}
.meta-row{display:flex;flex-wrap:wrap;align-items:center;gap:12px 24px;font-size:13px;color:var(--muted);font-family:"JetBrains Mono","SF Mono",Menlo,Consolas,monospace}
.meta-row>span{display:inline-flex;align-items:center;gap:8px}
.report-grid{display:grid;grid-template-columns:7fr 6fr;gap:40px;align-items:start}
.col-main{min-width:0}
.col-side{min-width:0;display:flex;flex-direction:column;gap:28px}
.col-side .report-section{margin-top:0}
.report-section{margin-top:56px;scroll-margin-top:96px;content-visibility:auto;contain-intrinsic-size:0 600px}
.report-section.wrap{padding:32px;border-radius:20px;background:linear-gradient(135deg,rgba(245,245,247,0.58) 0%,rgba(220,220,225,0.42) 50%,rgba(200,200,205,0.46) 100%);border:1px solid rgba(160,160,170,0.22);box-shadow:inset 0 1px 0 rgba(255,255,255,0.85),inset 0 -1px 0 rgba(0,0,0,0.04),0 1px 2px rgba(60,60,67,0.06),0 6px 20px rgba(60,60,67,0.06)}
.report-section.wrap .section-heading{margin-bottom:20px}
.report-section.wrap .sprint-grid{margin-top:4px}
.report-section.wrap .sprint-card,.report-section.wrap .day{background:rgba(255,255,255,0.5);border-color:rgba(60,60,67,0.1);box-shadow:inset 0 1px 0 rgba(255,255,255,0.7),0 1px 2px rgba(60,60,67,0.04)}
.section-heading{display:flex;align-items:baseline;justify-content:space-between;gap:16px;margin-bottom:24px}
.section-heading span{color:var(--muted);font-size:13px;font-weight:500}
.phase-list{display:flex;flex-wrap:wrap;gap:10px}
.metric-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:20px}
.metric-card,.sprint-card,.day,.decision-groups{background:var(--glass-bg);border:1px solid var(--border);border-radius:18px;box-shadow:var(--glass-highlight),var(--glass-depth)}
.metric-card{padding:24px;transition:transform .2s ease,border-color .2s ease;position:relative;overflow:hidden;text-align:left}
.metric-card:hover{transform:translateY(-2px);border-color:var(--border-strong)}
.metric-card p{font-size:11px;font-weight:600;letter-spacing:0.15em;text-transform:uppercase;color:var(--muted);margin:0 0 16px}
.metric-card strong{display:block;font-size:36px;line-height:1;font-weight:600;font-variant-numeric:tabular-nums;color:var(--text);margin-bottom:12px;letter-spacing:-0.02em}
.metric-card span{color:var(--secondary);font-size:13px;font-weight:500}
.metric-card code{display:block;color:var(--text);word-break:break-word;margin-bottom:12px}
.progress-wrap{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:12px;align-items:center;color:var(--secondary);font-size:13px;font-family:"JetBrains Mono","SF Mono",Menlo,Consolas,monospace}
.progress-bar{height:6px;border-radius:3px;overflow:hidden;background:rgba(60,60,67,0.1);border:0}
.progress-bar span{display:block;height:100%;background:linear-gradient(90deg,#007aff,#3396ff)}
.sprint-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:20px}
.sprint-card{padding:24px;transition:transform .2s ease,border-color .2s ease}
.sprint-card:hover{transform:translateY(-2px);border-color:var(--border-strong)}
.card-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:16px}
.card-head h3{font-family:"JetBrains Mono","SF Mono",Menlo,Consolas,monospace;font-size:12px;font-weight:500;letter-spacing:0;word-break:break-word;color:var(--text)}
.sprint-card>p{color:var(--secondary);margin:0;font-size:14px}
.status-badge{display:inline-flex;align-items:center;border-radius:999px;padding:4px 11px;font-size:10px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;white-space:nowrap;border:1px solid transparent;box-shadow:inset 0 1px 0 rgba(255,255,255,0.65),0 1px 2px rgba(0,0,0,0.05)}
.status-badge[data-status="complete"]{background:linear-gradient(135deg,rgba(52,199,89,0.28),rgba(52,199,89,0.14));color:var(--complete-text);border-color:rgba(52,199,89,0.42)}
.status-badge[data-status="in-progress"]{background:linear-gradient(135deg,rgba(0,122,255,0.26),rgba(0,122,255,0.12));color:var(--progress-text);border-color:rgba(0,122,255,0.38)}
.status-badge[data-status="partial"]{background:linear-gradient(135deg,rgba(255,149,0,0.3),rgba(255,149,0,0.14));color:var(--partial-text);border-color:rgba(255,149,0,0.42)}
.status-badge[data-status="failed"]{background:linear-gradient(135deg,rgba(255,59,48,0.28),rgba(255,59,48,0.14));color:var(--failed-text);border-color:rgba(255,59,48,0.42)}
.status-badge[data-status="idle"]{background:linear-gradient(135deg,rgba(120,120,128,0.22),rgba(120,120,128,0.1));color:var(--idle-text);border-color:rgba(120,120,128,0.28)}
.day{margin-bottom:14px;overflow:hidden;transition:border-color .2s ease}
.day:hover{border-color:var(--border-strong)}
.day>summary{cursor:pointer;padding:15px 22px;font-weight:600;color:var(--text);list-style:none;display:flex;align-items:center;gap:12px;font-size:13px;font-family:"JetBrains Mono","SF Mono",Menlo,Consolas,monospace;letter-spacing:0.06em}
.day>summary::-webkit-details-marker{display:none}
.day>summary::before{content:"";width:0;height:0;border-top:5px solid transparent;border-bottom:5px solid transparent;border-left:7px solid var(--muted);transition:transform .2s ease;flex-shrink:0}
.day[open]>summary::before{transform:rotate(90deg)}
.day[open]>summary{border-bottom:1px solid var(--border)}
.timeline{padding:4px 0}
.event{display:grid;grid-template-columns:76px 150px minmax(0,1fr);gap:16px;padding:11px 22px;align-items:start;transition:background .15s ease}
.event:hover{background:rgba(255,255,255,0.35)}
.event+.event{border-top:1px solid rgba(60,60,67,0.08)}
.event time{color:var(--muted);padding-top:1px;font-size:12px}
.event.muted{color:var(--muted);grid-template-columns:1fr;font-style:italic;padding:14px 22px}
.event .status-badge{justify-content:center;width:100%}
.event-summary{color:var(--secondary);line-height:1.5;font-size:13px;word-break:break-word}
.dashboard-metrics.wrap{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}
.dashboard-metrics.wrap .card-wide{grid-column:1 / -1}
.dashboard-metrics button.metric-card{width:100%}
.dashboard-metrics button.metric-card:hover{background:rgba(255,255,255,0.82)}
.eyebrow-sm{font-size:11px;font-weight:600;letter-spacing:0.15em;text-transform:uppercase;color:var(--muted);margin:0 0 16px}
.iteration-card h3{font-size:20px;margin-bottom:10px}
.iteration-card .progress-wrap{margin-top:18px}
.current-sprint-card .card-head{margin-bottom:0}
.decision-groups{padding:16px 22px}
.decision-entry{display:grid;grid-template-columns:76px 124px minmax(0,1fr);gap:14px;align-items:start;padding:14px 0;border-bottom:1px solid var(--border)}
.decision-entry .status-badge{justify-content:center;width:100%}
.decision-entry:last-child{border-bottom:0}
.decision-entry time{color:var(--muted);font-size:12px}
.decision-entry p{margin:0;color:var(--text);font-size:14px;line-height:1.6}
.empty-state{color:var(--muted);margin:0;font-style:italic}
.banner{display:none;margin:28px 0 0;padding:14px 16px;border:1px solid var(--border);background:rgba(255,255,255,0.46);border-radius:18px;box-shadow:var(--glass-highlight),var(--glass-depth);backdrop-filter:blur(24px);-webkit-backdrop-filter:blur(24px);font-size:13px;color:var(--secondary)}
.banner.show{display:flex;justify-content:space-between;gap:12px;align-items:center}
.filter-chip{padding:6px 14px;border-radius:999px;color:var(--muted);font-size:12px;font-weight:500;background:transparent;border:1px solid var(--border);transition:all .2s ease}
.filter-chip:hover{color:var(--text);border-color:var(--border-strong)}
.expand-actions button,.modal button{color:var(--secondary);font-size:13px;font-weight:500;padding:8px 16px;border-radius:999px;background:rgba(255,255,255,0.55);border:1px solid var(--border);box-shadow:inset 0 1px 0 rgba(255,255,255,0.8),0 1px 2px rgba(0,0,0,0.05);transition:all .2s ease}
.expand-actions button:hover,.modal button:hover{color:var(--text);background:rgba(255,255,255,0.8);border-color:var(--border-strong)}
.toasts{position:fixed;right:24px;bottom:24px;display:grid;gap:10px;z-index:30}
.toast{width:320px;background:rgba(255,255,255,0.78);color:var(--text);border:1px solid var(--border);border-radius:18px;padding:14px 16px;box-shadow:var(--glass-highlight),0 20px 48px rgba(60,60,67,0.18);backdrop-filter:blur(24px);-webkit-backdrop-filter:blur(24px);animation:fade 8s forwards;font-size:13px;line-height:1.5}
.toast strong{font-weight:600;display:block;margin-bottom:2px}
@keyframes fade{0%,85%{opacity:1}100%{opacity:0}}
.modal{position:fixed;inset:0;background:rgba(18,18,20,0.36);backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);display:none;align-items:center;justify-content:center;padding:20px;z-index:40}
.modal.open{display:flex}
.modal-card{background:linear-gradient(135deg,rgba(245,245,247,0.78) 0%,rgba(220,220,225,0.62) 50%,rgba(200,200,205,0.66) 100%);border:1px solid rgba(160,160,170,0.22);border-radius:20px;max-width:620px;width:100%;padding:32px;box-shadow:var(--glass-highlight),0 28px 64px rgba(0,0,0,0.2)}
.modal-card h2{font-size:18px;font-weight:600;margin:0 0 14px;color:var(--text)}
#riskList p{margin:10px 0;font-size:13px;color:var(--secondary);line-height:1.55}
#riskList strong{color:var(--text);font-weight:600}
.modal-card button{margin-top:16px}
@media (max-width:1024px){h1{font-size:44px}.nav-anchors{display:none}.report-grid{grid-template-columns:1fr;gap:0}.col-side{gap:48px}.metric-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media (max-width:640px){body{padding:8px}.outer-frame{padding:12px;border-radius:16px}.site-nav{padding:10px 14px;border-radius:20px;flex-wrap:wrap;gap:12px;margin-bottom:48px}.nav-meta{display:none}h1{font-size:32px}.hero{padding:32px 0 48px}.report-section{margin-top:48px}.section-heading{display:block}.section-heading span{display:block;margin-top:8px}.event{grid-template-columns:1fr;gap:8px}.decision-entry{grid-template-columns:1fr;gap:8px}.metric-card strong{font-size:36px}.subtitle{font-size:15px}.toasts{right:16px;left:16px}.toast{width:auto}}
@media (prefers-reduced-motion:reduce){.orb-core{animation:none}.metric-card,.sprint-card{transition:none}}
</style>
</head>
<body>
<a class="skip-link" href="#content">Skip to content</a>
<div class="outer-frame">
<nav class="site-nav" aria-label="Dashboard navigation">
  <div class="brand">
    <div class="orb" aria-hidden="true">
      <div class="orb-core"></div>
      <div class="orb-glass"></div>
    </div>
    <span class="brand-name">&#x1D4FF;&#x1D4F2;&#x1D4EB;&#x1D4EE; &#x1D4ED;&#x1D4F8;&#x1D4EC;&#x1D4FD;&#x1D4F8;&#x1D4FB;</span>
  </div>
  <ul class="nav-anchors">
    <li><a href="#phases">Phases</a></li>
    <li><a href="#sprints">Sprints</a></li>
    <li><a href="#timeline">Timeline</a></li>
    <li><a href="#attention">Attention</a></li>
  </ul>
  <div class="nav-meta" aria-label="Dashboard status">
    <span id="navIter">idle</span>
    <span>/</span>
    <span id="navUpdated">unknown</span>
    <span id="conn" class="conn connected"><span id="connBadge" class="status-badge" data-status="complete">connected</span></span>
  </div>
</nav>
<main id="content" class="container">
<section class="hero">
  <p class="eyebrow">Live Dashboard</p>
  <h1>Vibe Dashboard</h1>
  <p id="heroSubtitle" class="subtitle">Idle - run /vibe-init to start a project.</p>
  <div class="meta-row" aria-label="Dashboard metadata">
    <span>Updated <time id="heroUpdated" datetime="">unknown</time></span>
    <span>Iteration: <span id="heroIteration">idle</span></span>
    <span>Status: <span id="heroStatus" class="status-badge" data-status="idle">idle</span></span>
  </div>
  <div id="permissionBanner" class="banner">
    <span>Enable desktop notifications for urgent attention requests.</span>
    <button id="enableNotifications" class="filter-chip" type="button">Enable notifications</button>
  </div>
</section>
<div class="report-grid">
  <div class="col-main">
    <section id="phases" data-section="phases" class="report-section wrap">
      <div class="section-heading"><h2>Phase Progress</h2><span id="phaseContext">0 phases</span></div>
      <div id="phaseList" class="phase-list" aria-label="Phase progress"></div>
    </section>
    <section id="sprints" data-section="sprints" class="report-section wrap">
      <div class="section-heading"><h2>Sprint Roadmap</h2><span id="sprintContext">0 sprints</span></div>
      <div id="sprintGrid" class="sprint-grid"></div>
    </section>
    <section id="timeline" data-section="timeline" class="report-section wrap">
      <div class="section-heading"><h2>Timeline</h2><span>Activity by day</span></div>
      <div id="days"></div>
    </section>
  </div>
  <aside class="col-side">
    <section id="attention" data-section="attention" class="report-section wrap">
      <div class="section-heading"><h2>Attention</h2><span id="attentionContext">0 recent</span></div>
      <div id="attentionList" class="decision-groups"></div>
    </section>
    <section class="report-section wrap iteration-card" aria-label="Iteration summary">
      <p id="iterId" class="eyebrow-sm">ITERATION</p>
      <h3 id="iterLabel">No active iteration</h3>
      <span id="iterGoal" class="muted"></span>
      <div class="progress-wrap" aria-label="Iteration sprint progress">
        <div class="progress-bar"><span id="iterBarFill" style="width:0%"></span></div>
        <span id="iterPercent">0%</span>
      </div>
      <span id="iterProgressText" class="muted">0 / 0 sprints</span>
    </section>
    <section class="report-section wrap current-sprint-card" id="currentSprintCard" data-status="idle" aria-label="Current sprint summary">
      <p class="eyebrow-sm">Current Sprint</p>
      <div class="card-head">
        <h3><code id="sprintId">idle</code></h3>
        <span id="sprintStatus" class="status-badge" data-status="idle">idle</span>
      </div>
    </section>
    <section class="metric-grid dashboard-metrics report-section wrap" aria-label="Dashboard metrics">
      <button class="metric-card" id="riskButton" type="button">
        <p>Open Risks</p>
        <strong id="riskCount">0</strong>
        <span>pending</span>
      </button>
      <article class="metric-card">
        <p>Tokens Today</p>
        <strong id="tokens">n/a</strong>
        <span>cumulative</span>
      </article>
      <article class="metric-card card-wide">
        <p>Latest Test</p>
        <strong id="latestTest">n/a</strong>
        <span id="latestTestDetail"></span>
      </article>
    </section>
  </aside>
</div>
</main>
<div class="toasts" id="toasts"></div>
<div class="modal" id="riskModal" role="dialog" aria-modal="true" aria-labelledby="riskModalTitle">
  <div class="modal-card">
    <h2 id="riskModalTitle">Open pending risks</h2>
    <div id="riskList"></div>
    <button id="closeRisks" type="button">Close</button>
  </div>
</div>
</div>
<script>
const cache = new Map();
let state = null;
let retries = 0;
let lastPing = Date.now();
let es = null;
let reconnectTimer = null;
let connectionTimer = null;
let attentionEvents = [];
const today = new Intl.DateTimeFormat('en-CA',{timeZone:'UTC',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
const $ = (id) => document.getElementById(id);
function normalizeStatus(value){const raw=String(value??'idle').toLowerCase();if(raw==='passed'||raw==='complete'||raw==='completed'||raw==='resolved')return'complete';if(raw==='in_progress'||raw==='in-progress'||raw.endsWith('-in-progress')||raw==='active'||raw==='running')return'in-progress';if(raw==='partial'||raw==='blocked'||raw==='pending-risk'||raw.startsWith('pending-risk'))return'partial';if(raw==='failed'||raw==='open'||raw==='error')return'failed';return'idle'}
function statusFromEvent(type){const raw=String(type??'');if(raw.startsWith('sprint-completed'))return'complete';if(raw.startsWith('sprint-failed')||raw==='test-failed'||raw.startsWith('attention'))return'failed';if(raw.startsWith('phase'))return'in-progress';if(raw.startsWith('pending-risk'))return'partial';return'idle'}
function summary(evt){const p=evt.payload||{};return p.summary||p.detail||p.title||(p.sprintId?String(p.sprintId)+' '+(p.status||''):evt.type)}
function timePart(ts){const d=new Date(ts);return Number.isFinite(d.getTime())?d.toISOString().slice(11,19):''}
function escapeHtml(v){return String(v).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'","&#39;")}
function renderBadge(label,status){return '<span class="status-badge" data-status="'+escapeHtml(normalizeStatus(status))+'">'+escapeHtml(label)+'</span>'}
function renderEventBadge(type){return '<span class="status-badge" data-status="'+escapeHtml(statusFromEvent(type))+'">'+escapeHtml(type)+'</span>'}
async function fetchJson(url){const r=await fetch(url,{cache:'no-store'});if(!r.ok)throw new Error(url+' '+r.status);return r.json()}
function currentIterationEntry(iter){const cur=iter?.currentIteration;return cur&&Array.isArray(iter?.iterations)?iter.iterations.find((e)=>e&&e.id===cur):null}
function iterationProgress(iter){const entry=currentIterationEntry(iter);if(!entry)return{entry:null,done:0,total:0,pct:0};const done=Array.isArray(entry.completedSprints)?entry.completedSprints.length:0;const total=Array.isArray(entry.plannedSprints)?entry.plannedSprints.length:0;const pct=total?Math.round((done/total)*100):0;return{entry,done,total,pct}}
function renderIteration(iter){const cur=iter?.currentIteration;const progress=iterationProgress(iter);if(!progress.entry){$('iterId').textContent='ITERATION';$('iterLabel').textContent='No active iteration';$('iterGoal').textContent='';$('iterProgressText').textContent='0 / 0 sprints';$('iterPercent').textContent='0%';$('iterBarFill').style.width='0%';return}$('iterId').textContent=cur||progress.entry.id;$('iterLabel').textContent=progress.entry.label||progress.entry.id;$('iterGoal').textContent=progress.entry.goal||'';$('iterProgressText').textContent=progress.done+' / '+progress.total+' sprints';$('iterPercent').textContent=progress.pct+'%';$('iterBarFill').style.width=progress.pct+'%'}
function fmtUpdated(iso){if(!iso)return'unknown';try{const d=new Date(iso);if(!Number.isFinite(d.getTime()))return'unknown';return d.toISOString().slice(11,19)+' UTC'}catch{return'unknown'}}
function renderPhaseBadge(node){return renderBadge(node.id, node.state)}
function renderSprintCard(node){const status=normalizeStatus(node.state);return '<article class="sprint-card" data-sprint-id="'+escapeHtml(node.id)+'"><div class="card-head"><h3>'+escapeHtml(node.id)+'</h3>'+renderBadge(node.state||'idle',status)+'</div><p>'+escapeHtml(node.id)+' is '+escapeHtml(status.replace('-', ' '))+'.</p></article>'}
function renderHero(next){const cur=next.iteration?.currentIteration||'idle';const progress=iterationProgress(next.iteration);const sprint=next.currentSprint?.id||'idle';if(sprint==='idle'&&!next.iteration?.currentIteration){$('heroSubtitle').textContent='Idle - run /vibe-init to start a project.'}else{$('heroSubtitle').textContent=sprint+' / '+cur+' / passed '+progress.done+' / '+progress.total}$('heroIteration').textContent=cur;$('navIter').textContent=cur;$('heroUpdated').textContent=fmtUpdated(next.updatedAt);$('heroUpdated').setAttribute('datetime',next.updatedAt||'');$('navUpdated').textContent=fmtUpdated(next.updatedAt);const status=next.currentSprint?.status||'idle';$('heroStatus').dataset.status=normalizeStatus(status);$('heroStatus').textContent=status}
function renderState(next){state=next;renderHero(next);const phases=Array.isArray(next.roadmap?.phases)?next.roadmap.phases:[];const sprints=Array.isArray(next.roadmap?.sprints)?next.roadmap.sprints:[];$('phaseContext').textContent=phases.length+' phases';$('phaseList').innerHTML=phases.map(renderPhaseBadge).join('')||'<p class="empty-state">No phases detected.</p>';$('sprintContext').textContent=sprints.length+' sprints';$('sprintGrid').innerHTML=sprints.map(renderSprintCard).join('')||'<p class="empty-state">No sprints detected.</p>';$('sprintId').textContent=next.currentSprint?.id||'idle';$('sprintStatus').textContent=next.currentSprint?.status||'idle';$('sprintStatus').dataset.status=normalizeStatus(next.currentSprint?.status);const sprintCard=$('currentSprintCard');if(sprintCard)sprintCard.dataset.status=normalizeStatus(next.currentSprint?.status);$('riskCount').textContent=String(Array.isArray(next.risks)?next.risks.length:0);$('tokens').textContent=String(next.tokens?.todayTotal??next.tokens?.total??'n/a');$('latestTest').textContent=next.latestTest?.type??'n/a';$('latestTestDetail').textContent=next.latestTest?.summary??'';renderIteration(next.iteration);renderRisks(Array.isArray(next.risks)?next.risks:[])}
function renderRisks(risks){$('riskList').innerHTML=risks.length===0?'<p class="muted">No open risks.</p>':risks.map((risk)=>'<p><strong>'+escapeHtml(risk.id)+'</strong><br>'+escapeHtml(risk.text||'')+'</p>').join('')}
async function renderDays(){const data=await fetchJson('/api/daily-index');const dates=data.dates.length?data.dates:[today];$('days').innerHTML=dates.map((date)=>{const safeDate=escapeHtml(date);return '<details class="day" data-date="'+safeDate+'" '+(date===today?'open':'')+'><summary>'+safeDate+'</summary><div class="timeline" data-body="'+safeDate+'"></div></details>'}).join('');for(const detail of document.querySelectorAll('details.day')){detail.addEventListener('toggle',()=>{if(detail.open)loadDate(detail.dataset.date)});if(detail.open)loadDate(detail.dataset.date)}}
async function loadDate(date){if(!date)return;const body=document.querySelector('[data-body="'+date+'"]');if(!body)return;if(cache.has(date)){body.innerHTML=cache.get(date);return}body.innerHTML='<div class="event muted">loading</div>';try{const data=await fetchJson('/api/daily/'+date);const html=data.events.map((evt)=>'<div class="event"><time datetime="'+escapeHtml(evt.ts||'')+'">'+escapeHtml(timePart(evt.ts))+'</time><span>'+renderEventBadge(evt.type)+'</span><span class="event-summary">'+escapeHtml(summary(evt))+'</span></div>').join('')||'<div class="event muted">No events.</div>';cache.set(date,html);body.innerHTML=html}catch{body.innerHTML='<div class="event muted">No events.</div>'}}
async function refresh(){const next=await fetchJson('/api/state');renderState(next);cache.delete(today);await loadDate(today)}
function renderAttention(){const recent=attentionEvents.slice(0,3);$('attentionContext').textContent=recent.length+' recent';$('attentionList').innerHTML=recent.length===0?'<p class="empty-state">No attention requests yet.</p>':recent.map((evt)=>'<div class="decision-entry"><time datetime="'+escapeHtml(evt.ts||'')+'">'+escapeHtml(timePart(evt.ts))+'</time>'+renderEventBadge(evt.type||'attention-needed')+'<p>'+escapeHtml(evt.title||evt.detail||'Attention requested')+'</p></div>').join('')}
async function loadAttention(){try{const data=await fetchJson('/api/attention');attentionEvents=Array.isArray(data.events)?data.events.slice().reverse():[];renderAttention()}catch{renderAttention()}}
function pushToast(evt){const el=document.createElement('div');el.className='toast';el.innerHTML='<strong>'+escapeHtml(evt.title||'Attention')+'</strong><br>'+escapeHtml(evt.detail||'Attention requested');$('toasts').prepend(el);setTimeout(()=>el.remove(),8200);while($('toasts').children.length>5){$('toasts').lastElementChild.remove()}}
function handleAttention(evt){attentionEvents=[evt].concat(attentionEvents).slice(0,20);renderAttention();if(window.Notification&&Notification.permission==='granted'){const note=new Notification(evt.title||'User attention required',{body:evt.detail||'',icon:'/icon.svg',tag:evt.id,requireInteraction:evt.severity==='urgent'});note.onclick=()=>window.focus()}else{pushToast(evt)}}
function setConnection(label){const badge=$('connBadge');const status=label==='connected'?'complete':label==='reconnecting'?'partial':'failed';$('conn').className='conn '+label;badge.dataset.status=status;badge.textContent=label==='dead'?'disconnected':label}
function connect(){if(reconnectTimer){clearTimeout(reconnectTimer);reconnectTimer=null}if(es){es.close()}es=new EventSource('/events');es.onopen=()=>{retries=0;lastPing=Date.now();setConnection('connected')};es.addEventListener('state-updated',()=>{lastPing=Date.now();refresh().catch(console.error)});es.addEventListener('attention',(ev)=>{lastPing=Date.now();handleAttention(JSON.parse(ev.data))});es.onerror=()=>{if(es){es.close()}retries+=1;setConnection(retries>3?'dead':'reconnecting');reconnectTimer=setTimeout(connect,Math.min(10000,500*retries))}}
function startConnectionWatch(){if(connectionTimer)return;connectionTimer=setInterval(()=>{if(es&&es.readyState===1){lastPing=Date.now()}else if(Date.now()-lastPing>40000){setConnection('reconnecting')}},30000)}
function setupSmoothScroll(){const prefersReduced=typeof window.matchMedia==='function'&&window.matchMedia('(prefers-reduced-motion: reduce)').matches;for(const link of document.querySelectorAll('a[href^="#"]')){link.addEventListener('click',(event)=>{const id=link.getAttribute('href').slice(1);if(!id)return;const target=document.getElementById(id);if(!target)return;event.preventDefault();target.scrollIntoView({behavior:prefersReduced?'auto':'smooth',block:'start'});history.replaceState(null,'','#'+id)})}}
async function boot(){if('Notification'in window&&Notification.permission==='default'){$('permissionBanner').classList.add('show')}$('enableNotifications').onclick=()=>window.Notification&&Notification.requestPermission().then(()=>$('permissionBanner').classList.remove('show'));$('riskButton').onclick=()=>$('riskModal').classList.add('open');$('closeRisks').onclick=()=>$('riskModal').classList.remove('open');$('riskModal').addEventListener('click',(event)=>{if(event.target===$('riskModal'))$('riskModal').classList.remove('open')});setupSmoothScroll();renderAttention();await refresh();await renderDays();await loadAttention();startConnectionWatch();connect()}
boot().catch((error)=>{document.body.innerHTML='<pre>'+escapeHtml(error.message)+'</pre>'});
</script>
</body>
</html>`;
}

if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? '')).href) {
  runDashboard().then((code) => {
    if (code !== 0) {
      process.exit(code);
    }
  }).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
