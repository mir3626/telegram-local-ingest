#!/usr/bin/env node
// Gate vibe:qa so Stop hooks only run when the repo has code changes.

import { execFileSync, execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

const EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.cs', '.py', '.go', '.rs',
  '.java', '.kt', '.swift', '.rb', '.php', '.c', '.cpp', '.h', '.hpp', '.m', '.mm',
]);
const FILENAMES = new Set([
  'package.json', 'tsconfig.json', 'Cargo.toml', 'go.mod',
  'pyproject.toml', 'requirements.txt', 'pom.xml',
]);
const SUFFIXES = ['.csproj', '.asmdef'];
const DENY_PREFIXES = [
  'node_modules/', '.git/', 'dist/', 'build/', 'coverage/',
  '.vibe/sync-backup/', '.vibe/runs/',
];

function git(repoRoot, ...args) {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'buffer' });
}

function normalizeGitPath(filePath) {
  return filePath.replaceAll('\\', '/');
}

function classify(filePath) {
  const normalized = normalizeGitPath(filePath);
  if (DENY_PREFIXES.some((prefix) => normalized.startsWith(prefix))) {
    return false;
  }

  const base = path.posix.basename(normalized);
  if (FILENAMES.has(base) || SUFFIXES.some((suffix) => normalized.endsWith(suffix))) {
    return true;
  }

  return EXTENSIONS.has(path.posix.extname(base).toLowerCase());
}

function parseStatusZ(buffer) {
  const tokens = buffer.toString('utf8').split('\0');
  const paths = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const entry = tokens[index];
    if (!entry) {
      continue;
    }

    const status = entry.slice(0, 2);
    const candidate = entry.slice(3);
    if (status[0] === 'R' || status[0] === 'C' || status[1] === 'R' || status[1] === 'C') {
      const destination = tokens[index + 1];
      if (destination) {
        paths.push(destination);
        index += 1;
      } else if (candidate) {
        paths.push(candidate);
      }
      continue;
    }

    if (candidate) {
      paths.push(candidate);
    }
  }

  return paths;
}

function parseListZ(buffer) {
  return buffer.toString('utf8').split('\0').filter(Boolean);
}

function main() {
  try {
    const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
    const changed = new Set([
      ...parseStatusZ(git(repoRoot, 'status', '--porcelain=v1', '-z')),
      ...parseListZ(git(repoRoot, 'ls-files', '--others', '--exclude-standard', '-z')),
    ].map(normalizeGitPath));

    const codePaths = [...changed].filter(classify);
    if (codePaths.length === 0) {
      console.log('[vibe-qa] skip: no code changes');
      process.exit(0);
    }

    const sample = codePaths.slice(0, 3).join(', ');
    console.log(`[vibe-qa] run: ${sample}`);
    const tsxInstalled = existsSync(path.join(repoRoot, 'node_modules', 'tsx', 'package.json'));
    if (!tsxInstalled) {
      console.log('[vibe-qa] skip: tsx not installed \u2014 run `npm install` first');
      process.exit(0);
    }
    try {
      execSync('npm run vibe:qa --silent', {
        cwd: repoRoot,
        stdio: 'inherit',
      });
      process.exit(0);
    } catch (error) {
      const status = typeof error?.status === 'number' ? error.status : 1;
      process.exit(status);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[vibe-qa] gate error: ${message}`);
    process.exit(0);
  }
}

main();
