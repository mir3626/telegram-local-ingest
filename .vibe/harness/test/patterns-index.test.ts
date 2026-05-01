import assert from 'node:assert/strict';
import { access, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';

function extractFrontMatter(content: string): string {
  const match = /^---\n([\s\S]*?)\n---/.exec(content);
  assert.ok(match, 'expected YAML front matter');
  const frontMatter = match[1];
  assert.ok(frontMatter !== undefined, 'expected captured front matter');
  return frontMatter;
}

function parseMapping(frontMatter: string): Record<string, string> {
  const mapping: Record<string, string> = {};
  let insideMapping = false;

  for (const line of frontMatter.split('\n')) {
    if (line.trim() === 'mapping:') {
      insideMapping = true;
      continue;
    }

    if (!insideMapping) {
      continue;
    }

    if (!line.startsWith('  ')) {
      break;
    }

    const trimmed = line.trim();
    const separatorIndex = trimmed.indexOf(':');
    assert.notEqual(separatorIndex, -1, `invalid mapping line: ${trimmed}`);
    const key = trimmed.slice(0, separatorIndex).trim();
    const value = trimmed.slice(separatorIndex + 1).trim();
    mapping[key] = value;
  }

  return mapping;
}

async function assertIndexMatchesDirectory(relativeDirectory: string): Promise<void> {
  const directory = path.join(process.cwd(), relativeDirectory);
  const indexPath = path.join(directory, '_index.md');
  const frontMatter = extractFrontMatter(await readFile(indexPath, 'utf8'));
  const mapping = parseMapping(frontMatter);
  const mappedFiles = Object.values(mapping).sort((left, right) => left.localeCompare(right));
  const directoryFiles = (await readdir(directory))
    .filter((entry) => entry.endsWith('.md') && entry !== '_index.md')
    .sort((left, right) => left.localeCompare(right));

  assert.equal(mappedFiles.length, directoryFiles.length);
  assert.deepEqual(mappedFiles, directoryFiles);

  for (const fileName of mappedFiles) {
    await access(path.join(directory, fileName));
  }
}

describe('pattern shard indexes', () => {
  it('test-patterns index maps every shard file', async () => {
    await assertIndexMatchesDirectory(path.join('.claude', 'skills', 'test-patterns'));
  });

  it('lint-patterns index maps every shard file', async () => {
    await assertIndexMatchesDirectory(path.join('.claude', 'skills', 'lint-patterns'));
  });
});
