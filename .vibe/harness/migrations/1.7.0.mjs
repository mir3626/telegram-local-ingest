#!/usr/bin/env node

import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  rmdirSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

const OLD_HARNESS_PATTERNS = [
  'src/commands/*.ts',
  'src/lib/*.ts',
  'src/lib/schemas/*.ts',
  'src/providers/*.ts',
  'scripts/run-codex.sh',
  'scripts/run-codex.cmd',
  'scripts/vibe-*.mjs',
  'scripts/vibe-*.ts',
  'test/*.test.ts',
  'test/integration/*.test.ts',
  'test/playwright/*.ts',
  'migrations/*.mjs',
  'playwright.config.ts',
  'tsconfig.harness.json',
];

const ROOT_BOOTSTRAP_BRIDGE = 'scripts/vibe-sync-bootstrap.mjs';

const OLD_TEST_UI_VALUES = new Set([
  'playwright test',
  'node scripts/vibe-playwright-test.mjs',
  'node .vibe/harness/scripts/vibe-playwright-test.mjs',
]);

function normalizeRelativePath(filePath) {
  return filePath.split(path.sep).join('/');
}

function readJson(filePath, fallback) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function sha256(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function segmentMatchesPattern(patternSegment, candidateSegment) {
  const regex = new RegExp(`^${escapeRegExp(patternSegment).replaceAll('\\*', '[^/]*')}$`);
  return regex.test(candidateSegment);
}

function matchGlobSegments(patternSegments, candidateSegments, patternIndex = 0, candidateIndex = 0) {
  if (patternIndex >= patternSegments.length) {
    return candidateIndex === candidateSegments.length;
  }

  const patternSegment = patternSegments[patternIndex];
  if (patternSegment === '**') {
    if (patternIndex === patternSegments.length - 1) {
      return candidateIndex < candidateSegments.length;
    }

    for (let nextIndex = candidateIndex; nextIndex <= candidateSegments.length; nextIndex += 1) {
      if (matchGlobSegments(patternSegments, candidateSegments, patternIndex + 1, nextIndex)) {
        return true;
      }
    }

    return false;
  }

  const candidateSegment = candidateSegments[candidateIndex];
  if (candidateSegment === undefined || !segmentMatchesPattern(patternSegment, candidateSegment)) {
    return false;
  }

  return matchGlobSegments(patternSegments, candidateSegments, patternIndex + 1, candidateIndex + 1);
}

function matchesGlob(pattern, candidate) {
  return matchGlobSegments(
    normalizeRelativePath(pattern).split('/'),
    normalizeRelativePath(candidate).split('/'),
  );
}

function listFiles(root) {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => normalizeRelativePath(path.relative(root, path.join(entry.parentPath, entry.name))));
}

function findOldHarnessFiles(root) {
  const files = listFiles(root);
  return files
    .filter((candidate) => candidate !== ROOT_BOOTSTRAP_BRIDGE)
    .filter((candidate) => OLD_HARNESS_PATTERNS.some((pattern) => matchesGlob(pattern, candidate)))
    .sort((left, right) => left.localeCompare(right));
}

function pruneEmptyDirs(root, relativePaths) {
  const dirs = Array.from(
    new Set(
      relativePaths
        .map((relativePath) => path.dirname(relativePath))
        .filter((dir) => dir !== '.')
        .sort((left, right) => right.length - left.length),
    ),
  );

  for (const dir of dirs) {
    try {
      rmdirSync(path.join(root, dir));
    } catch {
      // Directory is not empty or cannot be removed; leave it alone.
    }
  }
}

function migrateLegacyRootHarnessFiles(root) {
  const syncHashesPath = path.join(root, '.vibe', 'sync-hashes.json');
  const syncHashes = readJson(syncHashesPath, { files: {} });
  const hashMap = syncHashes.files && typeof syncHashes.files === 'object' ? syncHashes.files : {};
  const deleted = [];
  const retained = [];

  for (const relativePath of findOldHarnessFiles(root)) {
    const absolutePath = path.join(root, relativePath);
    const trackedHash = hashMap[relativePath];
    if (!trackedHash) {
      retained.push(`${relativePath}: no sync hash`);
      continue;
    }

    if (trackedHash !== sha256(absolutePath)) {
      retained.push(`${relativePath}: locally modified`);
      continue;
    }

    rmSync(absolutePath, { force: true });
    delete hashMap[relativePath];
    deleted.push(relativePath);
  }

  if (deleted.length > 0) {
    syncHashes.files = hashMap;
    writeJson(syncHashesPath, syncHashes);
    pruneEmptyDirs(root, deleted);
  }

  if (retained.length > 0) {
    const reportPath = path.join(root, '.vibe', 'harness-migration-1.7.0.md');
    writeFileSync(
      reportPath,
      [
        '# Harness Migration v1.7.0',
        '',
        'The harness runtime moved to `.vibe/harness/**`.',
        'The following legacy root-level files were left in place because the migration could not prove they were unmodified synced harness files:',
        '',
        ...retained.map((entry) => `- ${entry}`),
        '',
        'Review them manually. Product-owned `src/**`, `scripts/**`, and `test/**` files must not be deleted by the harness.',
        '',
      ].join('\n'),
      'utf8',
    );
  }

  return { deleted, retained };
}

function migratePackageJson(root) {
  const packagePath = path.join(root, 'package.json');
  if (!existsSync(packagePath)) {
    return 'missing';
  }

  const pkg = readJson(packagePath, {});
  if (!pkg.scripts || typeof pkg.scripts !== 'object') {
    return 'idempotent';
  }

  if (OLD_TEST_UI_VALUES.has(pkg.scripts['test:ui'])) {
    pkg.scripts['test:ui'] = 'npm run vibe:test-ui';
    writeJson(packagePath, pkg);
    return 'updated-test-ui';
  }

  return 'idempotent';
}

function migrateCodexProvider(root) {
  const configPath = path.join(root, '.vibe', 'config.json');
  if (!existsSync(configPath)) {
    return 'missing';
  }

  const config = readJson(configPath, {});
  const providers = config.providers && typeof config.providers === 'object' ? config.providers : {};
  const codex = providers.codex && typeof providers.codex === 'object' ? providers.codex : null;
  if (!codex) {
    return 'missing-provider';
  }

  if (codex.command === './scripts/run-codex.sh' || codex.command === 'scripts/run-codex.sh') {
    codex.command = './.vibe/harness/scripts/run-codex.sh';
    if (typeof codex.note === 'string') {
      codex.note = codex.note
        .replaceAll('./scripts/run-codex.sh', './.vibe/harness/scripts/run-codex.sh')
        .replaceAll('scripts/run-codex.cmd', '.vibe/harness/scripts/run-codex.cmd');
    }
    config.providers = providers;
    writeJson(configPath, config);
    return 'updated';
  }

  return 'idempotent';
}

function main() {
  const root = path.resolve(process.argv[2] ?? process.cwd());
  const rootHarness = migrateLegacyRootHarnessFiles(root);
  const packageResult = migratePackageJson(root);
  const providerResult = migrateCodexProvider(root);

  process.stdout.write(
    [
      '[migrate 1.7.0]',
      `rootDeleted=${rootHarness.deleted.length}`,
      `rootRetained=${rootHarness.retained.length}`,
      `package=${packageResult}`,
      `codexProvider=${providerResult}`,
    ].join(' ') + '\n',
  );
}

try {
  main();
  process.exit(0);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
