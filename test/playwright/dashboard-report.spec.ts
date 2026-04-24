import { expect, test, type Page } from '@playwright/test';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repoRoot = process.cwd();

async function makeTempRoot(prefix: string): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

async function writeText(filePath: string, value: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, value, 'utf8');
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await writeText(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => {
        if (typeof address === 'object' && address) {
          resolve(address.port);
          return;
        }
        reject(new Error('no free port'));
      });
    });
  });
}

async function scaffoldDashboardRoot(root: string): Promise<void> {
  await writeJson(path.join(root, '.vibe', 'agent', 'sprint-status.json'), {
    schemaVersion: '0.1',
    project: { name: 'Dashboard UI', createdAt: '2026-04-24T00:00:00.000Z' },
    sprints: [{ id: 'sprint-ui', name: 'Sprint UI', status: 'in_progress' }],
    verificationCommands: [],
    pendingRisks: [{ id: 'risk-ui', status: 'open', text: 'Review UI wiring' }],
    lastSprintScope: [],
    lastSprintScopeGlob: [],
    sprintsSinceLastAudit: 0,
    stateUpdatedAt: '2026-04-24T00:00:00.000Z',
    handoff: {
      currentSprintId: 'sprint-ui',
      lastActionSummary: 'dashboard smoke',
      orchestratorContextBudget: 'medium',
      preferencesActive: [],
    },
  });
  await writeJson(path.join(root, '.vibe', 'agent', 'iteration-history.json'), {
    currentIteration: 'iter-ui',
    iterations: [
      {
        id: 'iter-ui',
        label: 'Dashboard UI',
        goal: 'Render dashboard state',
        plannedSprints: ['sprint-ui'],
        completedSprints: [],
      },
    ],
  });
  await writeJson(path.join(root, '.vibe', 'agent', 'tokens.json'), { todayTotal: 123 });
  await writeText(path.join(root, '.vibe', 'agent', 'handoff.md'), '## 2. Status: ACTIVE\n');
  await writeText(path.join(root, 'docs', 'plans', 'sprint-roadmap.md'), '- **id**: `sprint-ui`\n');
  await writeText(path.join(root, 'docs', 'context', 'product.md'), '# Dashboard UI\n\nPlatform: browser\n');
}

async function startDashboard(root: string): Promise<{ child: ChildProcess; url: string }> {
  const port = await freePort();
  const child = spawn(process.execPath, ['scripts/vibe-dashboard.mjs', '--port', String(port), '--no-open'], {
    cwd: repoRoot,
    env: { ...process.env, VIBE_ROOT: root },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk) => {
    stdout += String(chunk);
  });
  child.stderr?.on('data', (chunk) => {
    stderr += String(chunk);
  });

  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`dashboard did not start stdout=${stdout} stderr=${stderr}`));
    }, 5_000);
    child.on('exit', (code) => {
      if (!stdout.includes('http://')) {
        clearTimeout(timer);
        reject(new Error(`dashboard exited ${code ?? 1}: ${stderr}`));
      }
    });
    child.stdout?.on('data', () => {
      const match = stdout.match(/http:\/\/127\.0\.0\.1:\d+/);
      if (match) {
        clearTimeout(timer);
        resolve(match[0]);
      }
    });
  });

  return { child, url };
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.killed) {
    return;
  }
  child.kill('SIGTERM');
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => resolve(), 1_000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function scaffoldReportRoot(root: string): Promise<void> {
  await writeJson(path.join(root, 'package.json'), {
    name: 'downstream-ui',
    scripts: { test: 'node --test' },
  });
  await writeJson(path.join(root, '.vibe', 'config.json'), {});
  await writeJson(path.join(root, '.vibe', 'agent', 'sprint-status.json'), {
    schemaVersion: '0.1',
    project: { name: 'Demo Project', createdAt: '2026-04-24T00:00:00.000Z' },
    sprints: [
      {
        id: 'project-ui',
        name: 'Project UI',
        status: 'passed',
        completedAt: '2026-04-24T01:00:00.000Z',
        actualLoc: { added: 20, deleted: 2, net: 18, filesChanged: 3 },
      },
    ],
    verificationCommands: [{ name: 'npm test', status: 'passed', timestamp: '2026-04-24T01:01:00.000Z' }],
    pendingRisks: [],
    lastSprintScope: [],
    lastSprintScopeGlob: [],
    sprintsSinceLastAudit: 0,
    stateUpdatedAt: '2026-04-24T01:00:00.000Z',
    handoff: {
      currentSprintId: 'idle',
      lastActionSummary: 'report smoke',
      orchestratorContextBudget: 'low',
      preferencesActive: [],
    },
  });
  await writeJson(path.join(root, '.vibe', 'agent', 'iteration-history.json'), {
    currentIteration: null,
    iterations: [],
  });
  await writeText(path.join(root, 'docs', 'context', 'product.md'), '# Demo Project\n\nPlatform: browser\n');
  await writeText(
    path.join(root, 'docs', 'plans', 'sprint-roadmap.md'),
    ['# Roadmap', '', '## Sprint Project UI', '- **id**: `project-ui`', '- **Goal**: Render the UI report'].join('\n'),
  );
  await writeText(
    path.join(root, '.vibe', 'agent', 'session-log.md'),
    [
      '# Session Log',
      '',
      '## Entries',
      '- 2026-04-24T01:00:00.000Z [decision] keep the report interactive',
      '- 2026-04-24T01:02:00.000Z [failure] long failure entry for Playwright expansion checks that should render collapsed at first and expand when the report control is clicked; this sentence intentionally stays above the report collapse threshold so the real browser test covers the details element behavior.',
    ].join('\n'),
  );
}

async function openReport(page: Page, root: string): Promise<void> {
  const result = spawnSync(process.execPath, [path.join(repoRoot, 'scripts', 'vibe-project-report.mjs'), '--no-open'], {
    cwd: root,
    encoding: 'utf8',
  });
  expect(result.status, result.stderr).toBe(0);
  const outPath = result.stdout.trim().split(/\r?\n/).at(-1);
  if (!outPath) {
    throw new Error('project report did not print an output path');
  }
  await page.goto(pathToFileURL(outPath).href, { waitUntil: 'domcontentloaded' });
}

test('dashboard renders live state and receives attention toasts', async ({ page }) => {
  const root = await makeTempRoot('vibe-dashboard-playwright-');
  let child: ChildProcess | null = null;
  try {
    await scaffoldDashboardRoot(root);
    const dashboard = await startDashboard(root);
    child = dashboard.child;

    await page.goto(dashboard.url, { waitUntil: 'domcontentloaded' });

    await expect(page.getByRole('heading', { name: 'Vibe Dashboard' })).toBeVisible();
    await expect(page.locator('#sprintId')).toHaveText('sprint-ui');
    await expect(page.locator('[data-sprint-id="sprint-ui"]')).toBeVisible();
    await expect(page.locator('#riskCount')).toHaveText('1');

    const notify = spawnSync(
      process.execPath,
      [
        'scripts/vibe-attention.mjs',
        '--severity',
        'urgent',
        '--title',
        'Permission needed',
        '--detail',
        'Approve the pending tool call',
        '--source',
        'playwright',
      ],
      { cwd: repoRoot, env: { ...process.env, VIBE_ROOT: root }, encoding: 'utf8' },
    );
    expect(notify.status, notify.stderr).toBe(0);

    await expect(page.locator('.toast').filter({ hasText: 'Permission needed' })).toBeVisible();
    await expect(page.locator('#attentionList')).toContainText('Permission needed');
  } finally {
    if (child) {
      await stopChild(child);
    }
    await rm(root, { recursive: true, force: true });
  }
});

test('project report renders and decision controls work in a real browser', async ({ page }) => {
  const root = await makeTempRoot('vibe-report-playwright-');
  try {
    await scaffoldReportRoot(root);
    await openReport(page, root);

    await expect(page.getByRole('heading', { name: 'Demo Project' })).toBeVisible();
    await expect(page.locator('[data-sprint-id="project-ui"]')).toContainText('passed');
    await expect(page.getByRole('link', { name: 'Decisions' })).toBeVisible();

    const groups = page.locator('.decision-groups');
    await expect(groups).toHaveAttribute('data-active-tags', /decision/);

    await page.getByRole('button', { name: 'failure' }).click();
    await expect(groups).toHaveAttribute('data-active-tags', 'failure');
    await expect(page.locator('.decision-entry[data-tag="failure"]')).toBeVisible();

    const collapsed = page.locator('#decisions details').first();
    await expect(collapsed).not.toHaveAttribute('open', '');
    await page.getByRole('button', { name: 'Expand all' }).click();
    await expect(collapsed).toHaveAttribute('open', '');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
