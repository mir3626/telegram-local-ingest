import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vibe-dashboard-'));
  await mkdir(path.join(root, '.vibe', 'agent', 'daily'), { recursive: true });
  await mkdir(path.join(root, 'docs', 'plans'), { recursive: true });
  await mkdir(path.join(root, 'docs', 'context'), { recursive: true });
  await writeFile(
    path.join(root, '.vibe', 'agent', 'sprint-status.json'),
    JSON.stringify({
      schemaVersion: '1',
      project: { name: 'test', createdAt: '2026-04-16T00:00:00.000Z' },
      sprints: [{ id: 'sprint-1', name: 'Sprint 1', status: 'in_progress' }],
      verificationCommands: [],
      handoff: {
        currentSprintId: 'sprint-1',
        lastActionSummary: 'testing',
        orchestratorContextBudget: 'high',
        preferencesActive: [],
      },
      pendingRisks: [],
      lastSprintScope: [],
      lastSprintScopeGlob: [],
      sprintsSinceLastAudit: 0,
      stateUpdatedAt: '2026-04-16T00:00:00.000Z',
    }),
    'utf8',
  );
  await writeFile(path.join(root, '.vibe', 'agent', 'handoff.md'), '## 2. Status: ACTIVE\n', 'utf8');
  await writeFile(path.join(root, '.vibe', 'agent', 'iteration-history.json'), '{"currentIteration":"iter-1","iterations":[]}\n', 'utf8');
  await writeFile(path.join(root, '.vibe', 'agent', 'tokens.json'), '{"todayTotal":123}\n', 'utf8');
  await writeFile(path.join(root, 'docs', 'plans', 'sprint-roadmap.md'), '- **id**: `sprint-1`\n', 'utf8');
  await writeFile(path.join(root, 'docs', 'context', 'product.md'), '# Test\n', 'utf8');
  return root;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => {
        if (typeof address === 'object' && address) {
          resolve(address.port);
          return;
        }
        reject(new Error('no port'));
      });
    });
  });
}

function startDashboard(root: string, port: number): Promise<{ child: ChildProcess; url: string }> {
  const child = spawn(process.execPath, ['scripts/vibe-dashboard.mjs', '--port', String(port), '--no-open'], {
    cwd: process.cwd(),
    env: { ...process.env, VIBE_ROOT: root },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += String(chunk);
  });
  child.stderr.on('data', (chunk) => {
    stderr += String(chunk);
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`dashboard did not start stdout=${stdout} stderr=${stderr}`));
    }, 4_000);
    child.on('exit', (code) => {
      if (!stdout.includes('http://')) {
        clearTimeout(timer);
        reject(new Error(`dashboard exited ${code ?? 1}: ${stderr}`));
      }
    });
    child.stdout.on('data', () => {
      const match = stdout.match(/http:\/\/127\.0\.0\.1:\d+/);
      if (match) {
        clearTimeout(timer);
        resolve({ child, url: match[0] });
      }
    });
  });
}

function getJson<T>(url: string): Promise<T> {
  return new Promise((resolve, reject) => {
    http.get(url, (response) => {
      let raw = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        raw += chunk;
      });
      response.on('end', () => {
        try {
          resolve(JSON.parse(raw) as T);
        } catch (error) {
          reject(error);
        }
      });
    }).on('error', reject);
  });
}

function getStatus(url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    http.get(url, (response) => {
      response.resume();
      response.on('end', () => resolve(response.statusCode ?? 0));
    }).on('error', reject);
  });
}

test('server boots and /api/state returns expected shape', async () => {
  const root = await tempRoot();
  const port = await freePort();
  const { child, url } = await startDashboard(root, port);
  try {
    const state = await getJson<Record<string, unknown>>(`${url}/api/state`);
    assert.ok(state.roadmap);
    assert.ok(state.currentSprint);
    assert.ok(Array.isArray(state.todayEvents));
  } finally {
    child.kill('SIGTERM');
  }
});

test('/api/daily rejects traversal and invalid dates', async () => {
  const root = await tempRoot();
  const port = await freePort();
  const { child, url } = await startDashboard(root, port);
  try {
    assert.equal(await getStatus(`${url}/api/daily/%2e%2e%2fetc`), 400);
    assert.equal(await getStatus(`${url}/api/daily/2024-99-99`), 400);
  } finally {
    child.kill('SIGTERM');
  }
});

test('refuses bind to 0.0.0.0', async () => {
  const root = await tempRoot();
  const result = spawnSync(process.execPath, ['scripts/vibe-dashboard.mjs', '--host', '0.0.0.0', '--no-open'], {
    cwd: process.cwd(),
    env: { ...process.env, VIBE_ROOT: root },
    encoding: 'utf8',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /localhost only/);
});

test('auto-port discovery uses next free port', async () => {
  const root = await tempRoot();
  const port = await freePort();
  const blocker = http.createServer();
  await new Promise<void>((resolve) => blocker.listen(port, '127.0.0.1', () => resolve()));
  const { child, url } = await startDashboard(root, port);
  try {
    assert.equal(url, `http://127.0.0.1:${port + 1}`);
  } finally {
    child.kill('SIGTERM');
    blocker.close();
  }
});

test('SSE emits state-updated after daily log append', async () => {
  const root = await tempRoot();
  const port = await freePort();
  const { child, url } = await startDashboard(root, port);
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('no SSE update')), 4_000);
      const request = http.get(`${url}/events`, { headers: { Accept: 'text/event-stream' } }, (response) => {
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          if (String(chunk).includes('state-updated')) {
            clearTimeout(timeout);
            request.destroy();
            resolve();
          }
        });
      });
      request.on('error', reject);
      setTimeout(() => {
        spawnSync(process.execPath, [
          'scripts/vibe-daily-log.mjs',
          'session-started',
          '--date',
          '2026-04-16',
          '--payload',
          '{"source":"test"}',
        ], {
          cwd: process.cwd(),
          env: { ...process.env, VIBE_ROOT: root },
          stdio: 'ignore',
        });
      }, 250);
    });
  } finally {
    child.kill('SIGTERM');
  }
});

test('PID lease makes a second instance exit cleanly', async () => {
  const root = await tempRoot();
  const port = await freePort();
  const { child } = await startDashboard(root, port);
  try {
    const second = spawnSync(process.execPath, ['scripts/vibe-dashboard.mjs', '--port', String(port), '--no-open'], {
      cwd: process.cwd(),
      env: { ...process.env, VIBE_ROOT: root },
      encoding: 'utf8',
    });
    assert.equal(second.status, 0);
    assert.match(second.stdout, /dashboard already running/);
  } finally {
    child.kill('SIGTERM');
  }
});
