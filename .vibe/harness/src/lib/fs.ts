import { mkdir, readFile, writeFile, appendFile, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';

export async function ensureDir(dirPath: string): Promise<void> {
  await mkdir(dirPath, { recursive: true });
}

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function readText(filePath: string): Promise<string> {
  return readFile(filePath, 'utf8');
}

export async function writeText(filePath: string, value: string): Promise<void> {
  await ensureDir(path.dirname(filePath));
  await writeFile(filePath, value, 'utf8');
}

/**
 * Reads and parses a JSON file. The generic `T` is a **trust assertion**,
 * not a runtime check — use this only with files you own (config,
 * package.json). For untrusted input, call `readText` and validate
 * with a schema library before casting.
 *
 * On parse failure, the error includes the file path so stack traces
 * are actionable.
 */
export async function readJson<T>(filePath: string): Promise<T> {
  const raw = await readText(filePath);
  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse JSON at ${filePath}: ${reason}`);
  }
}

export async function writeJson(filePath: string, value: unknown): Promise<void> {
  await writeText(filePath, `${JSON.stringify(value, null, 2)}
`);
}

export async function appendJsonl(filePath: string, value: unknown): Promise<void> {
  await ensureDir(path.dirname(filePath));
  await appendFile(filePath, `${JSON.stringify(value)}
`, 'utf8');
}
