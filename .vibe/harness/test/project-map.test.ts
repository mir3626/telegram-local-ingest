import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import {
  loadProjectMap,
  mergeProjectMaps,
  registerModule,
  registerPlatformRule,
  type ProjectMap,
} from '../src/lib/project-map.js';

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await import('node:fs/promises').then(({ rm }) => rm(dir, { recursive: true, force: true }));
    }
  }
});

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

describe('project-map', () => {
  it('loadProjectMap returns an empty skeleton when the file is absent', async () => {
    const root = await makeTempDir('project-map-empty-');
    const map = await loadProjectMap(root);

    assert.equal(map.schemaVersion, '0.1');
    assert.deepEqual(map.modules, {});
    assert.deepEqual(map.activePlatformRules, []);
  });

  it('registerModule overwrites exports/imports and preserves first sprintAdded', async () => {
    const root = await makeTempDir('project-map-module-');

    await registerModule({
      path: 'src\\lib\\demo.ts',
      exports: ['loadDemo'],
      imports: ['node:path'],
      sprintId: 'M1',
      root,
    });
    const map = await registerModule({
      path: 'src/lib/demo.ts',
      exports: ['loadDemo', 'saveDemo'],
      imports: ['node:fs'],
      sprintId: 'M2',
      root,
    });

    assert.deepEqual(map.modules['src/lib/demo.ts'], {
      exports: ['loadDemo', 'saveDemo'],
      imports: ['node:fs'],
      sprintAdded: 'M1',
    });
    assert.equal(map.lastSprintId, 'M2');
  });

  it('registerPlatformRule ignores duplicate rule/location tuples', async () => {
    const root = await makeTempDir('project-map-rule-');

    await registerPlatformRule({
      rule: 'all routes go through middleware',
      location: 'src/middleware/auth.ts',
      sprintId: 'M1',
      root,
    });
    const map = await registerPlatformRule({
      rule: 'all routes go through middleware',
      location: 'src/middleware/auth.ts',
      sprintId: 'M2',
      root,
    });

    assert.equal(map.activePlatformRules.length, 1);
    assert.equal(map.activePlatformRules[0]?.sprintAdded, 'M1');
  });

  it('mergeProjectMaps overwrites module collisions and deduplicates platform rules', () => {
    const base: ProjectMap = {
      schemaVersion: '0.1',
      updatedAt: '2026-04-01T00:00:00.000Z',
      modules: {
        'src/a.ts': {
          exports: ['a'],
          imports: ['b'],
          sprintAdded: 'M0',
        },
      },
      activePlatformRules: [
        {
          rule: 'auth required',
          location: 'global',
          sprintAdded: 'M0',
        },
      ],
    };

    const merged = mergeProjectMaps(base, {
      updatedAt: '2026-04-02T00:00:00.000Z',
      modules: {
        'src/a.ts': {
          exports: ['nextA'],
          imports: ['c'],
          sprintAdded: 'M1',
        },
        'src/b.ts': {
          exports: ['b'],
          imports: [],
        },
      },
      activePlatformRules: [
        {
          rule: 'auth required',
          location: 'global',
          sprintAdded: 'M2',
        },
        {
          rule: 'tenant header required',
          location: 'src/middleware/tenant.ts',
          sprintAdded: 'M2',
        },
      ],
    });

    assert.deepEqual(merged.modules['src/a.ts'], {
      exports: ['nextA'],
      imports: ['c'],
      sprintAdded: 'M1',
    });
    assert.deepEqual(merged.modules['src/b.ts'], {
      exports: ['b'],
      imports: [],
    });
    assert.equal(merged.activePlatformRules.length, 2);
  });
});
