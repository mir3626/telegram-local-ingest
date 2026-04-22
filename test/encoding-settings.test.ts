import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('workspace pins text editing to UTF-8 for Markdown safety', async () => {
  const settings = JSON.parse(await readFile('.vscode/settings.json', 'utf8')) as Record<string, unknown>;

  assert.equal(settings['files.encoding'], 'utf8');
  assert.equal(settings['files.autoGuessEncoding'], false);
  assert.equal(settings['files.eol'], '\n');
});

test('editorconfig keeps repository text as UTF-8 by default', async () => {
  const editorconfig = await readFile('.editorconfig', 'utf8');

  assert.match(editorconfig, /\[\*\][\s\S]*charset = utf-8/);
});

test('sync manifest includes workspace encoding files', async () => {
  const manifest = JSON.parse(await readFile('.vibe/sync-manifest.json', 'utf8')) as {
    files?: { harness?: unknown[]; hybrid?: Record<string, { strategy?: string }> };
  };

  assert.equal(manifest.files?.harness?.includes('.vscode/settings.json'), false);
  assert.equal(manifest.files?.harness?.includes('.vscode/extensions.json'), false);
  assert.equal(manifest.files?.hybrid?.['.vscode/settings.json']?.strategy, 'json-deep-merge');
  assert.equal(manifest.files?.hybrid?.['.vscode/extensions.json']?.strategy, 'json-array-union');
});
