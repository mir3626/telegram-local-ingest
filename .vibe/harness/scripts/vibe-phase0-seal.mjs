#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const DRY_RUN = process.argv.includes('--dry-run');
const CANDIDATES = [
  'docs/context/product.md',
  'docs/context/architecture.md',
  'docs/context/conventions.md',
  'docs/plans/sprint-roadmap.md',
  'README.md',
];

function git(args) {
  return execFileSync('git', args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  }).trim();
}

function tryGit(args) {
  try {
    return git(args);
  } catch {
    return null;
  }
}

export function deriveProjectName(rootDir = process.cwd()) {
  const productPath = path.join(rootDir, 'docs', 'context', 'product.md');
  if (existsSync(productPath)) {
    const firstHeader = readFileSync(productPath, 'utf8')
      .split(/\r?\n/)
      .find((line) => /^#\s+\S/.test(line));
    if (firstHeader) {
      return firstHeader.replace(/^#\s+/, '').trim();
    }
  }

  const packagePath = path.join(rootDir, 'package.json');
  if (existsSync(packagePath)) {
    try {
      const parsed = JSON.parse(readFileSync(packagePath, 'utf8'));
      if (typeof parsed.name === 'string' && parsed.name.trim() !== '') {
        return parsed.name.trim();
      }
    } catch {
      // fall through
    }
  }

  return 'unknown-project';
}

function collectInterviewLogs(rootDir = process.cwd()) {
  const interviewDir = path.join(rootDir, '.vibe', 'interview-log');
  if (!existsSync(interviewDir)) {
    return [];
  }

  return readdirSync(interviewDir)
    .filter((entry) => entry.endsWith('.json'))
    .sort((left, right) => left.localeCompare(right))
    .map((entry) => `.vibe/interview-log/${entry}`);
}

export function collectTargets(rootDir = process.cwd()) {
  return [...CANDIDATES, ...collectInterviewLogs(rootDir)].filter((relativePath) =>
    existsSync(path.join(rootDir, relativePath)),
  );
}

function main() {
  const targets = collectTargets();
  if (targets.length === 0) {
    process.stdout.write('[phase0-seal] no candidate files present\n');
    return;
  }

  if (DRY_RUN) {
    process.stdout.write(`[phase0-seal] would stage: ${targets.join(', ')}\n`);
    return;
  }

  for (const target of targets) {
    git(['add', '--', target]);
  }

  const staged = tryGit(['diff', '--cached', '--name-only', '--', ...targets]);
  if (!staged) {
    process.stdout.write('[phase0-seal] already sealed (no changes)\n');
    return;
  }

  const projectName = deriveProjectName();
  const message = `chore(phase0): vibe-init Phase 0 seal — ${projectName}`;
  git(['-c', 'commit.gpgsign=false', 'commit', '-m', message, '--', ...targets]);
  process.stdout.write(`[phase0-seal] committed: ${message}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
