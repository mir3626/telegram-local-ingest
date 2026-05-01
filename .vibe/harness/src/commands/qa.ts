import process from 'node:process';
import path from 'node:path';
import { access } from 'node:fs/promises';
import { runMain } from '../lib/cli.js';
import { readJson, appendJsonl } from '../lib/fs.js';
import { logger } from '../lib/logger.js';
import { paths } from '../lib/paths.js';
import { runCommand } from '../lib/shell.js';
import { isoDate, isoStamp } from '../lib/time.js';

interface PackageJson {
  scripts?: Record<string, string>;
}

/**
 * Canonical execution order for QA scripts. The order matters: faster
 * signals come first (unit tests fail loudest before a full build).
 */
export const QA_SCRIPT_ORDER = [
  'test:unit',
  'test',
  'typecheck',
  'lint',
  'build',
] as const;

/**
 * Returns the subset of {@link QA_SCRIPT_ORDER} that exist in the given
 * package.json `scripts` map, preserving canonical order.
 */
export function selectQaScripts(
  available: Record<string, string> | undefined,
): string[] {
  if (!available) {
    return [];
  }
  return QA_SCRIPT_ORDER.filter((name) => Boolean(available[name]));
}

async function isTsxInstalled(): Promise<boolean> {
  try {
    await access(path.join(paths.root, 'node_modules', 'tsx', 'package.json'));
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const packageJson = await readJson<PackageJson>(path.join(paths.root, 'package.json'));
  const selected = selectQaScripts(packageJson.scripts);

  const results: Array<{ script: string; ok: boolean; note?: string }> = [];
  const writeAndExit = async (): Promise<void> => {
    const outputFile = path.join(paths.vibeRunsDir, isoDate(), 'qa.jsonl');
    await appendJsonl(outputFile, {
      type: 'qa',
      timestamp: new Date().toISOString(),
      runId: isoStamp(),
      results,
    });

    if (results.some((item) => !item.ok)) {
      process.exitCode = 1;
    }
  };

  if (selected.length === 0) {
    logger.warn('No QA scripts found. Create at least test or typecheck automation.');
    results.push({ script: 'qa-bootstrap-needed', ok: false, note: 'No scripts found' });
  }

  const tsxDependent = selected.filter((name) =>
    (packageJson.scripts?.[name] ?? '').includes('tsx'),
  );

  if (tsxDependent.length > 0) {
    const tsxInstalled = await isTsxInstalled();
    if (!tsxInstalled) {
      logger.error(
        `tsx is not installed but is required by: ${tsxDependent.join(', ')}. Run \`npm install\` first.`,
      );
      for (const name of tsxDependent) {
        results.push({
          script: name,
          ok: false,
          note: 'tsx not installed - run npm install',
        });
      }
      for (const script of selected.filter((name) => !tsxDependent.includes(name))) {
        logger.info(`Running npm run ${script}`);
        try {
          await runCommand('npm', ['run', script], { cwd: paths.root });
          results.push({ script, ok: true });
        } catch (error) {
          const note = error instanceof Error ? error.message : String(error);
          logger.error(note);
          results.push({ script, ok: false, note });
          break;
        }
      }
      await writeAndExit();
      return;
    }
  }

  for (const script of selected) {
    logger.info(`Running npm run ${script}`);
    try {
      await runCommand('npm', ['run', script], { cwd: paths.root });
      results.push({ script, ok: true });
    } catch (error) {
      const note = error instanceof Error ? error.message : String(error);
      logger.error(note);
      results.push({ script, ok: false, note });
      break;
    }
  }

  await writeAndExit();
}

runMain(main, import.meta.url);
