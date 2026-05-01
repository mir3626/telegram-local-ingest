import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { logger } from './logger.js';

/**
 * Entry-point helper for CLI command modules.
 *
 * Runs `main` only when the module is the Node entry script (not when
 * imported by tests), and reports fatal errors through the shared
 * logger with a consistent exit code. This replaces the
 * `main().catch(...)` + `isMain` boilerplate previously duplicated
 * across every `src/commands/*.ts` file.
 *
 * Usage:
 * ```ts
 * async function main() { ... }
 * runMain(main, import.meta.url);
 * ```
 */
export function runMain(
  main: () => Promise<void>,
  importMetaUrl: string,
): void {
  const entry = process.argv[1];
  if (typeof entry !== 'string') {
    return;
  }

  const isEntry = resolve(entry) === resolve(fileURLToPath(importMetaUrl));
  if (!isEntry) {
    return;
  }

  main().catch((error: unknown) => {
    logger.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
