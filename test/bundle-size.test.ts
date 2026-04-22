import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, it } from 'node:test';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const tempDirs: string[] = [];
const tscCliPath = path.resolve('node_modules', 'typescript', 'lib', 'tsc.js');
const sourceRoot = process.cwd();

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

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function writeText(filePath: string, value: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, value, 'utf8');
}

async function compileBundleSize(root: string): Promise<string> {
  const outDir = path.join(root, '.compiled');
  await execFile(
    process.execPath,
    [
      tscCliPath,
      '--module',
      'nodenext',
      '--moduleResolution',
      'nodenext',
      '--target',
      'es2024',
      '--outDir',
      outDir,
      '--rootDir',
      sourceRoot,
      path.join(sourceRoot, 'src', 'commands', 'bundle-size.ts'),
      path.join(sourceRoot, 'src', 'lib', 'cli.ts'),
      path.join(sourceRoot, 'src', 'lib', 'config.ts'),
      path.join(sourceRoot, 'src', 'lib', 'fs.ts'),
      path.join(sourceRoot, 'src', 'lib', 'paths.ts'),
    ],
    {
      cwd: sourceRoot,
      env: process.env,
    },
  );

  return path.join(outDir, 'src', 'commands', 'bundle-size.js');
}

async function runBundleSize(root: string) {
  const compiledEntry = await compileBundleSize(root);
  return execFile(process.execPath, [compiledEntry], {
    cwd: root,
    env: process.env,
  });
}

function parseTotalGzipKb(stdout: string): number {
  const match = stdout.match(/^total\s+\S+\s+([0-9.]+)\s+limit=/m);
  assert.ok(match, `expected total row in output:\n${stdout}`);
  return Number(match[1]);
}

describe('bundle-size command', () => {
  it('returns exit 0 with a skip message when disabled', async () => {
    const root = await makeTempDir('bundle-size-disabled-');
    await writeJson(path.join(root, '.vibe', 'config.json'), {
      bundle: {
        enabled: false,
      },
    });

    const { stdout } = await runBundleSize(root);
    assert.match(stdout, /\[bundle-size\] disabled \(opt-in via \.vibe\/config\.json\)/);
  });

  it('reports the total gzip size within a tight tolerance', async () => {
    const root = await makeTempDir('bundle-size-pass-');
    const jsBody = 'console.log("hello bundle");\n'.repeat(80);
    const cssBody = '.card{display:grid;gap:12px;padding:24px;}\n'.repeat(60);
    const mapBody = 'ignored map body\n'.repeat(120);

    await writeJson(path.join(root, '.vibe', 'config.json'), {
      bundle: {
        enabled: true,
        dir: 'dist',
        limitGzipKB: 80,
        excludeExt: ['.map'],
      },
    });
    await writeText(path.join(root, 'dist', 'index.js'), jsBody);
    await writeText(path.join(root, 'dist', 'app.css'), cssBody);
    await writeText(path.join(root, 'dist', 'index.js.map'), mapBody);

    const { stdout } = await runBundleSize(root);
    assert.match(stdout, /status=PASS/);

    const actualGzipKb = parseTotalGzipKb(stdout);
    const expectedGzipKb = (
      gzipSync(Buffer.from(jsBody)).length + gzipSync(Buffer.from(cssBody)).length
    ) / 1024;
    const tolerance = 0.05 + Number.EPSILON;

    assert.ok(Math.abs(actualGzipKb - expectedGzipKb) <= tolerance);
    assert.doesNotMatch(stdout, /index\.js\.map/);
  });

  it('returns exit code 1 when the gzip budget is exceeded', async () => {
    const root = await makeTempDir('bundle-size-fail-');
    const largeBody = Array.from({ length: 400 }, (_, index) => `line-${index}-${'x'.repeat(40)}`).join('\n');

    await writeJson(path.join(root, '.vibe', 'config.json'), {
      bundle: {
        enabled: true,
        dir: 'dist',
        limitGzipKB: 0.1,
        excludeExt: ['.map'],
      },
    });
    await writeText(path.join(root, 'dist', 'index.js'), `${largeBody}\n`);

    try {
      await runBundleSize(root);
      assert.fail('expected bundle-size to exit non-zero');
    } catch (error) {
      const stdout =
        typeof error === 'object' &&
        error !== null &&
        'stdout' in error &&
        typeof error.stdout === 'string'
          ? error.stdout
          : '';
      assert.match(stdout, /status=FAIL/);
    }
  });
});
