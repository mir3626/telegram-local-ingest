import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, it } from 'node:test';
import { resolveBundleConfig } from '../src/commands/bundle-size.js';
import { mergeConfig, type VibeConfig } from '../src/lib/config.js';

const tempDirs: string[] = [];
const browserSmokePath = path.resolve('scripts', 'vibe-browser-smoke.mjs');

const baseConfig: VibeConfig = {
  orchestrator: 'claude-opus',
  sprintRoles: {
    planner: 'claude-opus',
    generator: 'codex',
    evaluator: 'claude-opus',
  },
  sprint: {
    unit: 'feature',
    subAgentPerRole: true,
    freshContextPerSprint: true,
  },
  providers: {
    'claude-opus': { command: 'claude', args: ['-p', '{prompt}'] },
    codex: { command: 'codex', args: ['exec', '--json', '{prompt}'] },
  },
  bundle: {
    enabled: true,
    dir: 'dist',
    limitGzipKB: 80,
    excludeExt: ['.map'],
  },
  browserSmoke: {
    enabled: false,
    configPath: '.vibe/smoke.config.js',
  },
};

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function loadBrowserSmokeSettings(root: string): Promise<() => {
  enabled: boolean;
  configPath: string;
  dist: string;
}> {
  const originalCwd = process.cwd();
  process.chdir(root);
  try {
    const module = await import(`${pathToFileURL(browserSmokePath).href}?case=${Date.now()}-${Math.random()}`);
    return module.loadBrowserSmokeSettings as () => {
      enabled: boolean;
      configPath: string;
      dist: string;
    };
  } finally {
    process.chdir(originalCwd);
  }
}

describe('config path resolution', () => {
  it('mergeConfig preserves legacy bundle.dir while accepting bundle.path override', () => {
    const merged = mergeConfig(baseConfig, {
      bundle: {
        path: 'app/dist',
      },
    });

    assert.equal(merged.bundle?.path, 'app/dist');
    assert.equal(merged.bundle?.dir, 'dist');
  });

  it('mergeConfig accepts browserSmoke.dist override', () => {
    const merged = mergeConfig(baseConfig, {
      browserSmoke: {
        dist: 'app/dist',
      },
    });

    assert.equal(merged.browserSmoke?.dist, 'app/dist');
    assert.equal(merged.browserSmoke?.configPath, '.vibe/smoke.config.js');
  });

  it('resolveBundleConfig prefers path, falls back to dir, then defaults to dist', () => {
    assert.equal(
      resolveBundleConfig({
        enabled: true,
        path: 'app/dist',
        dir: 'old',
        limitGzipKB: 80,
        excludeExt: ['.map'],
      }).path,
      'app/dist',
    );
    assert.equal(resolveBundleConfig({ dir: 'legacy' }).path, 'legacy');
    assert.equal(resolveBundleConfig({}).path, 'dist');
  });

  it('loadBrowserSmokeSettings exposes custom dist with dist default fallback', async () => {
    const customRoot = await makeTempDir('browser-smoke-dist-custom-');
    await writeJson(path.join(customRoot, '.vibe', 'config.json'), {
      browserSmoke: {
        enabled: true,
        configPath: '.vibe/smoke.config.js',
        dist: 'shared/dist',
      },
    });
    await writeJson(path.join(customRoot, '.vibe', 'config.local.json'), {
      browserSmoke: {
        dist: 'app/dist',
      },
    });

    const customSettings = await loadBrowserSmokeSettings(customRoot);
    assert.equal(customSettings().enabled, true);
    assert.equal(customSettings().dist, 'app/dist');

    const defaultRoot = await makeTempDir('browser-smoke-dist-default-');
    await writeJson(path.join(defaultRoot, '.vibe', 'config.json'), {
      browserSmoke: {
        enabled: true,
        configPath: '.vibe/smoke.config.js',
      },
    });

    const defaultSettings = await loadBrowserSmokeSettings(defaultRoot);
    assert.equal(defaultSettings().dist, 'dist');
  });
});
