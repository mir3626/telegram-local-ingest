import process from 'node:process';
import path from 'node:path';
import { runMain } from '../lib/cli.js';
import { appendJsonl } from '../lib/fs.js';
import { logger } from '../lib/logger.js';
import { paths } from '../lib/paths.js';
import { runCommand } from '../lib/shell.js';
import { isoDate } from '../lib/time.js';

export const forbiddenPatterns = [
  '.env',
  '.env.local',
  '.env.production',
  'config/credentials.json',
  'secrets/',
] as const;

/**
 * Returns the subset of tracked files that look like sensitive files or
 * directories. Patterns ending in `/` are treated as directory prefixes,
 * everything else requires exact equality — this prevents `.env.example`
 * from colliding with `.env`.
 */
export function findViolations(
  tracked: string[],
  patterns: readonly string[] = forbiddenPatterns,
): string[] {
  return tracked.filter((file) =>
    patterns.some((pattern) =>
      pattern.endsWith('/') ? file.startsWith(pattern) : file === pattern,
    ),
  );
}

async function main(): Promise<void> {
  const result = await runCommand('git', ['ls-files'], {
    cwd: paths.root,
    allowFailure: true,
  });

  const tracked = result.stdout.split(/\r?\n/).filter(Boolean);
  const violations = findViolations(tracked);

  await appendJsonl(path.join(paths.vibeRunsDir, isoDate(), 'audit.jsonl'), {
    type: 'config-audit',
    timestamp: new Date().toISOString(),
    violations,
  });

  if (violations.length > 0) {
    logger.error(`Sensitive files appear tracked: ${violations.join(', ')}`);
    process.exitCode = 1;
    return;
  }

  logger.info('Config audit passed');
}

runMain(main, import.meta.url);
