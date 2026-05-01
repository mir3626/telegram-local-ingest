import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { runMain } from '../lib/cli.js';
import { logger } from '../lib/logger.js';
import { paths } from '../lib/paths.js';
import type { UsageSummary } from '../lib/usage.js';
import { sumUsage } from '../lib/usage.js';

async function collectJsonlFiles(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    const nested = await Promise.all(
      entries.map(async (entry) => {
        const target = path.join(root, entry.name);
        if (entry.isDirectory()) {
          return collectJsonlFiles(target);
        }
        return target.endsWith('.jsonl') ? [target] : [];
      }),
    );

    return nested.flat();
  } catch {
    return [];
  }
}

async function main(): Promise<void> {
  const files = await collectJsonlFiles(paths.vibeRunsDir);
  const items: UsageSummary[] = [];

  for (const file of files) {
    const content = await readFile(file, 'utf8');
    const lines = content.split(/\r?\n/).filter(Boolean);

    for (const line of lines) {
      try {
        const parsed = JSON.parse(line) as {
          usage?: UsageSummary;
        };
        if (parsed.usage) {
          items.push(parsed.usage);
        }
      } catch {
        // ignore malformed lines
      }
    }
  }

  const total = sumUsage(items);

  logger.info(`usage files: ${files.length}`);
  logger.info(`input tokens: ${total.inputTokens}`);
  logger.info(`output tokens: ${total.outputTokens}`);
  logger.info(`total tokens: ${total.totalTokens}`);
}

runMain(main, import.meta.url);
