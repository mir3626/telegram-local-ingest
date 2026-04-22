import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, it } from 'node:test';

const browserSmokePath = path.resolve('scripts', 'vibe-browser-smoke.mjs');
const playwrightShardPath = path.resolve('.claude', 'skills', 'test-patterns', 'typescript-playwright.md');

async function loadCheckContract(): Promise<
  (smokeConfig: Record<string, unknown>, shardText: string) => string[]
> {
  const module = await import(pathToFileURL(browserSmokePath).href);
  return module.checkContract as (smokeConfig: Record<string, unknown>, shardText: string) => string[];
}

describe('vibe-browser-smoke contract checks', () => {
  it('warns when fixed sleep keys are present', async () => {
    const [checkContract, shardText] = await Promise.all([
      loadCheckContract(),
      readFile(playwrightShardPath, 'utf8'),
    ]);

    const warnings = checkContract(
      {
        url: 'http://localhost:5173',
        expectDom: ['[data-testid="app"]'],
        sleep: 250,
      },
      shardText,
    );

    assert.equal(
      warnings.some((warning) => warning.includes('sleep/delayMs')),
      true,
    );
  });

  it('warns when expectDom relies only on ID/class selectors', async () => {
    const [checkContract, shardText] = await Promise.all([
      loadCheckContract(),
      readFile(playwrightShardPath, 'utf8'),
    ]);

    const warnings = checkContract(
      {
        url: 'http://localhost:5173',
        expectDom: ['#stage', '.card'],
      },
      shardText,
    );

    assert.equal(
      warnings.some((warning) => warning.includes('role-based locators')),
      true,
    );
  });

  it('warns when the smoke URL shape differs from the shard baseURL example', async () => {
    const [checkContract, shardText] = await Promise.all([
      loadCheckContract(),
      readFile(playwrightShardPath, 'utf8'),
    ]);

    const warnings = checkContract(
      {
        url: 'http://localhost:5173',
        expectDom: ['[data-testid="app"]'],
      },
      shardText,
    );

    assert.equal(
      warnings.some((warning) => warning.includes('differs from shard example')),
      true,
    );
  });
});
