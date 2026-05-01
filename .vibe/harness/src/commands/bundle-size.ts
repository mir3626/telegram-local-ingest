import { readFileSync, statSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { gzipSync } from 'node:zlib';
import { runMain } from '../lib/cli.js';
import { loadConfig, type BundleConfig } from '../lib/config.js';

export interface BundleEntry {
  rel: string;
  rawBytes: number;
  gzBytes: number;
}

function formatKb(bytes: number): string {
  return (bytes / 1024).toFixed(1);
}

export async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];

  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await walk(full)));
    } else if (entry.isFile()) {
      out.push(full);
    }
  }

  return out.sort((left, right) => left.localeCompare(right));
}

export function summarize(
  files: string[],
  rootDir: string,
  excludeExt: string[],
): BundleEntry[] {
  return files
    .filter((filePath) => !excludeExt.includes(path.extname(filePath)))
    .map((filePath) => ({
      rel: path.relative(rootDir, filePath).replace(/\\/g, '/'),
      rawBytes: statSync(filePath).size,
      gzBytes: gzipSync(readFileSync(filePath)).length,
    }))
    .sort((left, right) => left.rel.localeCompare(right.rel));
}

export function renderTable(entries: BundleEntry[], limitGzipKB: number): string {
  const nameWidth = Math.max('file'.length, ...entries.map((entry) => entry.rel.length), 'total'.length);
  const rawWidth = Math.max(
    'raw KB'.length,
    ...entries.map((entry) => formatKb(entry.rawBytes).length),
    formatKb(entries.reduce((sum, entry) => sum + entry.rawBytes, 0)).length,
  );
  const gzWidth = Math.max(
    'gz KB'.length,
    ...entries.map((entry) => formatKb(entry.gzBytes).length),
    formatKb(entries.reduce((sum, entry) => sum + entry.gzBytes, 0)).length,
  );
  const totalRawBytes = entries.reduce((sum, entry) => sum + entry.rawBytes, 0);
  const totalGzBytes = entries.reduce((sum, entry) => sum + entry.gzBytes, 0);
  const status = totalGzBytes / 1024 <= limitGzipKB ? 'PASS' : 'FAIL';
  const rows = entries.map(
    (entry) =>
      `${entry.rel.padEnd(nameWidth)}  ${formatKb(entry.rawBytes).padStart(rawWidth)}  ${formatKb(entry.gzBytes).padStart(gzWidth)}`,
  );
  const separator = '-'.repeat(nameWidth + rawWidth + gzWidth + 4);
  const totalRow =
    `${'total'.padEnd(nameWidth)}  ${formatKb(totalRawBytes).padStart(rawWidth)}  ${formatKb(totalGzBytes).padStart(gzWidth)}` +
    `   limit=${limitGzipKB.toFixed(1)}  status=${status}`;

  return [
    `${'file'.padEnd(nameWidth)}  ${'raw KB'.padStart(rawWidth)}  ${'gz KB'.padStart(gzWidth)}`,
    ...rows,
    separator,
    totalRow,
  ].join('\n');
}

export type ResolvedBundleConfig = Required<Omit<BundleConfig, 'path'>> & { path: string };

export function resolveBundleConfig(bundle: Partial<BundleConfig> | undefined): ResolvedBundleConfig {
  const resolvedPath = bundle?.path ?? bundle?.dir ?? 'dist';

  return {
    enabled: bundle?.enabled ?? false,
    dir: bundle?.dir ?? 'dist',
    path: resolvedPath,
    limitGzipKB: bundle?.limitGzipKB ?? 80,
    excludeExt: bundle?.excludeExt ?? ['.map'],
  };
}

async function main(): Promise<void> {
  const config = await loadConfig();
  const bundle = resolveBundleConfig(config.bundle);

  if (!bundle.enabled) {
    process.stdout.write('[bundle-size] disabled (opt-in via .vibe/config.json)\n');
    return;
  }

  const rootDir = path.resolve(bundle.path);
  const files = await walk(rootDir);
  const entries = summarize(files, rootDir, bundle.excludeExt);
  const output = renderTable(entries, bundle.limitGzipKB);
  const totalGzipKb = entries.reduce((sum, entry) => sum + entry.gzBytes, 0) / 1024;

  process.stdout.write(`${output}\n`);
  if (totalGzipKb > bundle.limitGzipKB) {
    process.exitCode = 1;
  }
}

runMain(main, import.meta.url);
