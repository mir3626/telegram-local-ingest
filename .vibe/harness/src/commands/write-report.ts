import process from 'node:process';
import { parseArgs, getStringFlag } from '../lib/args.js';
import { runMain } from '../lib/cli.js';
import { logger } from '../lib/logger.js';
import { writeReport } from '../lib/report.js';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { paths } from '../lib/paths.js';
import { sumUsage } from '../lib/usage.js';

async function getUsageSummary(): Promise<
  { inputTokens: number; outputTokens: number; totalTokens: number } | undefined
> {
  try {
    const dates = await readdir(paths.vibeRunsDir, { withFileTypes: true });
    const files: string[] = [];

    for (const entry of dates) {
      if (!entry.isDirectory()) {
        continue;
      }
      const dir = path.join(paths.vibeRunsDir, entry.name);
      const names = await readdir(dir);
      for (const name of names) {
        if (name.endsWith('.jsonl')) {
          files.push(path.join(dir, name));
        }
      }
    }

    const usageItems = [] as Array<{
      inputTokens: number;
      outputTokens: number;
      totalTokens: number;
    }>;
    for (const file of files) {
      const lines = (await readFile(file, 'utf8')).split(/\r?\n/).filter(Boolean);
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line) as {
            usage?: { inputTokens: number; outputTokens: number; totalTokens: number };
          };
          if (parsed.usage) {
            usageItems.push(parsed.usage);
          }
        } catch {
          // noop
        }
      }
    }

    return sumUsage(usageItems);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    logger.warn(`Usage summary unavailable: ${reason}`);
    return undefined;
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const title = getStringFlag(args, 'title', 'task-report') ?? 'task-report';
  const summary =
    getStringFlag(
      args,
      'summary',
      'Completed task. Add concrete summary via --summary for production use.',
    ) ?? 'Completed task.';
  const changed = getStringFlag(args, 'changed')
    ?.split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  const qa = getStringFlag(args, 'qa')
    ?.split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  const risks = getStringFlag(args, 'risks')
    ?.split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  const context = getStringFlag(args, 'context')
    ?.split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  const usage = await getUsageSummary();

  const target = await writeReport({
    title,
    summary,
    changed,
    qa,
    risks,
    context,
    usage,
  });

  logger.info(`report created: ${target}`);
}

runMain(main, import.meta.url);
