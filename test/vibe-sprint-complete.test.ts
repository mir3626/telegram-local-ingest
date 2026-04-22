import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, it } from 'node:test';

const tempDirs: string[] = [];
const sprintCompleteScriptPath = path.resolve('scripts', 'vibe-sprint-complete.mjs');
type ArchiveSprintPrompts = (sprintId: string, rootDir?: string) => string[];

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

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

async function loadArchiveSprintPrompts(): Promise<ArchiveSprintPrompts> {
  const moduleUrl = pathToFileURL(sprintCompleteScriptPath).href;
  const loaded: unknown = await import(moduleUrl);

  if (!isRecord(loaded) || typeof loaded.archiveSprintPrompts !== 'function') {
    throw new Error('archiveSprintPrompts export missing');
  }

  return loaded.archiveSprintPrompts as ArchiveSprintPrompts;
}

describe('vibe-sprint-complete', () => {
  it('archives exact sprint prompt names and suffixed prompt names only', async () => {
    const root = await makeTempDir('vibe-sprint-complete-');
    const sprintId = 'sprint-M5-native-interview';
    const promptDir = path.join(root, 'docs', 'prompts');
    const archiveDir = path.join(root, '.vibe', 'archive', 'prompts');

    await mkdir(promptDir, { recursive: true });
    await writeFile(path.join(promptDir, `${sprintId}.md`), 'exact\n', 'utf8');
    await writeFile(path.join(promptDir, `${sprintId}-fix.md`), 'suffix\n', 'utf8');
    await writeFile(path.join(promptDir, 'sprint-M5.md'), 'partial\n', 'utf8');

    const archiveSprintPrompts = await loadArchiveSprintPrompts();
    const archived = archiveSprintPrompts(sprintId, root);

    assert.deepEqual(
      archived.toSorted(),
      [
        path.join(archiveDir, `${sprintId}.md`).replace(/\\/g, '/'),
        path.join(archiveDir, `${sprintId}-fix.md`).replace(/\\/g, '/'),
      ].toSorted(),
    );
    assert.equal(await fileExists(path.join(promptDir, `${sprintId}.md`)), false);
    assert.equal(await fileExists(path.join(promptDir, `${sprintId}-fix.md`)), false);
    assert.equal(await readFile(path.join(promptDir, 'sprint-M5.md'), 'utf8'), 'partial\n');
    assert.equal(await readFile(path.join(archiveDir, `${sprintId}.md`), 'utf8'), 'exact\n');
    assert.equal(await readFile(path.join(archiveDir, `${sprintId}-fix.md`), 'utf8'), 'suffix\n');
    assert.equal(await fileExists(path.join(archiveDir, 'sprint-M5.md')), false);
  });
});
