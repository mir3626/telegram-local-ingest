import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileExists, readJson, readText, writeJson, writeText } from './fs.js';
import type { VibeConfig } from './config.js';
import { runCommand } from './shell.js';

export interface SyncManifest {
  manifestVersion: string;
  files: {
    harness: string[];
    hybrid: Record<string, HybridFileConfig>;
    project: string[];
  };
  migrations: Record<string, string | null>;
}

export interface HybridFileConfig {
  strategy: 'section-merge' | 'json-deep-merge' | 'template-regenerate' | 'line-union';
  harnessMarkers?: string[];
  preserveMarkers?: string[];
  harnessKeys?: string[];
  projectKeys?: string[];
  note?: string;
}

export type SyncAction =
  | { type: 'replace'; path: string; reason: string }
  | { type: 'section-merge'; path: string; sections: string[] }
  | { type: 'json-merge'; path: string; keys: string[] }
  | { type: 'line-merge'; path: string; reason: string }
  | { type: 'template-regen'; path: string }
  | { type: 'skip'; path: string; reason: string }
  | { type: 'conflict'; path: string; reason: string }
  | { type: 'new-file'; path: string }
  | { type: 'delete'; path: string; reason: string };

export interface SyncPlan {
  fromVersion: string | null;
  toVersion: string;
  actions: SyncAction[];
  migrations: string[];
}

interface SyncHashes {
  files: Record<string, string>;
}

interface SectionBlock {
  name: string;
  full: string;
  body: string;
}

type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

function normalizeVersion(version: string): string {
  return version.startsWith('v') ? version.slice(1) : version;
}

function normalizeRelativePath(filePath: string): string {
  return filePath.split(path.sep).join('/');
}

function compareVersions(left: string, right: string): number {
  const leftParts = normalizeVersion(left).split('.').map((part) => Number(part));
  const rightParts = normalizeVersion(right).split('.').map((part) => Number(part));
  const length = Math.max(leftParts.length, rightParts.length);

  for (let index = 0; index < length; index += 1) {
    const leftValue = leftParts[index] ?? 0;
    const rightValue = rightParts[index] ?? 0;
    if (leftValue !== rightValue) {
      return leftValue - rightValue;
    }
  }

  return 0;
}

function isRecord(value: JsonValue | unknown): value is Record<string, JsonValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cloneJson<T extends JsonValue | unknown>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function splitPath(keyPath: string): string[] {
  return keyPath.split('.').filter((segment) => segment.length > 0);
}

function getAtPath(value: JsonValue | unknown, keyPath: string): JsonValue | undefined {
  const parts = splitPath(keyPath);
  let current: JsonValue | unknown = value;

  for (const part of parts) {
    if (!isRecord(current) || !(part in current)) {
      return undefined;
    }
    current = current[part];
  }

  return current as JsonValue | undefined;
}

function setAtPath(target: JsonValue | unknown, keyPath: string, nextValue: JsonValue): void {
  const parts = splitPath(keyPath);
  if (parts.length === 0 || !isRecord(target)) {
    return;
  }

  let current = target;
  for (let index = 0; index < parts.length - 1; index += 1) {
    const part = parts[index];
    if (!part) {
      return;
    }

    const existing = current[part];
    if (!isRecord(existing)) {
      current[part] = {};
    }

    const next = current[part];
    if (!isRecord(next)) {
      return;
    }
    current = next;
  }

  const leaf = parts[parts.length - 1];
  if (!leaf) {
    return;
  }
  current[leaf] = cloneJson(nextValue);
}

function deleteAtPath(target: JsonValue | unknown, keyPath: string): void {
  const parts = splitPath(keyPath);
  if (parts.length === 0 || !isRecord(target)) {
    return;
  }

  let current = target;
  for (let index = 0; index < parts.length - 1; index += 1) {
    const part = parts[index];
    if (!part) {
      return;
    }
    const next = current[part];
    if (!isRecord(next)) {
      return;
    }
    current = next;
  }

  const leaf = parts[parts.length - 1];
  if (!leaf) {
    return;
  }
  delete current[leaf];
}

function findSectionBlocks(content: string): SectionBlock[] {
  const pattern = /<!-- BEGIN:([A-Za-z0-9:_-]+) -->[\s\S]*?<!-- END:\1 -->/g;
  const blocks: SectionBlock[] = [];
  let match = pattern.exec(content);

  while (match) {
    const full = match[0];
    const name = match[1];
    if (name) {
      const body = full
        .replace(`<!-- BEGIN:${name} -->`, '')
        .replace(`<!-- END:${name} -->`, '')
        .trim();
      blocks.push({ name, full, body });
    }
    match = pattern.exec(content);
  }

  return blocks;
}

function hasMarkers(content: string): boolean {
  return /<!-- BEGIN:[A-Za-z0-9:_-]+ -->/.test(content);
}

function shouldPreserveMarker(name: string, config: HybridFileConfig): boolean {
  return name.startsWith('PROJECT:') || (config.preserveMarkers ?? []).includes(name);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isGlob(pattern: string): boolean {
  return pattern.includes('*');
}

function segmentMatchesPattern(patternSegment: string, candidateSegment: string): boolean {
  const regex = new RegExp(`^${escapeRegExp(patternSegment).replaceAll('\\*', '[^/]*')}$`);
  return regex.test(candidateSegment);
}

function matchGlobSegments(
  patternSegments: string[],
  candidateSegments: string[],
  patternIndex = 0,
  candidateIndex = 0,
): boolean {
  if (patternIndex >= patternSegments.length) {
    return candidateIndex === candidateSegments.length;
  }

  const patternSegment = patternSegments[patternIndex];
  if (patternSegment === '**') {
    if (patternIndex === patternSegments.length - 1) {
      return candidateIndex < candidateSegments.length;
    }

    for (let nextIndex = candidateIndex; nextIndex <= candidateSegments.length; nextIndex += 1) {
      if (matchGlobSegments(patternSegments, candidateSegments, patternIndex + 1, nextIndex)) {
        return true;
      }
    }

    return false;
  }

  if (patternSegment === undefined) {
    return candidateIndex === candidateSegments.length;
  }

  const candidateSegment = candidateSegments[candidateIndex];
  if (candidateSegment === undefined || !segmentMatchesPattern(patternSegment, candidateSegment)) {
    return false;
  }

  return matchGlobSegments(patternSegments, candidateSegments, patternIndex + 1, candidateIndex + 1);
}

function matchesHarnessGlob(pattern: string, candidate: string): boolean {
  const normalizedPattern = normalizeRelativePath(pattern);
  const normalizedCandidate = normalizeRelativePath(candidate);
  return matchGlobSegments(normalizedPattern.split('/'), normalizedCandidate.split('/'));
}

function readConfigFromRoot(root: string): Promise<VibeConfig> {
  return readJson<VibeConfig>(path.join(root, '.vibe', 'config.json'));
}

async function loadSyncHashes(localRoot: string): Promise<SyncHashes> {
  const hashPath = path.join(localRoot, '.vibe', 'sync-hashes.json');
  if (!(await fileExists(hashPath))) {
    return { files: {} };
  }

  try {
    const loaded = await readJson<SyncHashes>(hashPath);
    return { files: loaded.files ?? {} };
  } catch {
    return { files: {} };
  }
}

function collectMigrationPaths(
  manifest: SyncManifest,
  fromVersion: string | null,
  toVersion: string,
): string[] {
  return Object.entries(manifest.migrations)
    .filter(([version, scriptPath]) => {
      if (scriptPath === null) {
        return false;
      }

      if (compareVersions(version, toVersion) > 0) {
        return false;
      }

      if (fromVersion === null) {
        return true;
      }

      return compareVersions(version, fromVersion) > 0;
    })
    .sort(([left], [right]) => compareVersions(left, right))
    .map(([, scriptPath]) => scriptPath)
    .filter((scriptPath): scriptPath is string => typeof scriptPath === 'string');
}

export async function loadManifest(upstreamDir: string): Promise<SyncManifest> {
  return readJson<SyncManifest>(path.join(upstreamDir, '.vibe', 'sync-manifest.json'));
}

export async function expandHarnessGlob(
  upstreamRoot: string,
  pattern: string,
): Promise<string[]> {
  const entries = await readdir(upstreamRoot, { recursive: true, withFileTypes: true });

  return entries
    .filter((entry) => entry.isFile())
    .map((entry) =>
      normalizeRelativePath(path.relative(upstreamRoot, path.join(entry.parentPath, entry.name))),
    )
    .filter((candidate) => matchesHarnessGlob(pattern, candidate))
    .sort((left, right) => left.localeCompare(right));
}

export async function buildSyncPlan(
  localRoot: string,
  upstreamRoot: string,
  manifest: SyncManifest,
): Promise<SyncPlan> {
  const [localConfig, upstreamConfig, syncHashes] = await Promise.all([
    readConfigFromRoot(localRoot),
    readConfigFromRoot(upstreamRoot),
    loadSyncHashes(localRoot),
  ]);

  const actions: SyncAction[] = [];
  const resolvedHarness = Array.from(
    new Set(
      (
        await Promise.all(
          manifest.files.harness.map(async (entry) =>
            isGlob(entry) ? expandHarnessGlob(upstreamRoot, entry) : [normalizeRelativePath(entry)],
          ),
        )
      ).flat(),
    ),
  );

  for (const relativePath of resolvedHarness) {
    const localPath = path.join(localRoot, relativePath);
    const upstreamPath = path.join(upstreamRoot, relativePath);
    const localExists = await fileExists(localPath);
    const upstreamExists = await fileExists(upstreamPath);

    if (!upstreamExists) {
      actions.push({
        type: 'skip',
        path: relativePath,
        reason: 'missing from upstream source',
      });
      continue;
    }

    if (!localExists) {
      actions.push({ type: 'new-file', path: relativePath });
      continue;
    }

    const localHash = await computeFileHash(localPath);
    const trackedHash = syncHashes.files[relativePath];

    if (!trackedHash) {
      actions.push({
        type: 'conflict',
        path: relativePath,
        reason: 'local file exists without sync history',
      });
      continue;
    }

    if (trackedHash !== localHash) {
      actions.push({
        type: 'conflict',
        path: relativePath,
        reason: 'local file changed since last sync',
      });
      continue;
    }

    actions.push({
      type: 'replace',
      path: relativePath,
      reason: 'tracked harness file',
    });
  }

  for (const [relativePath, config] of Object.entries(manifest.files.hybrid)) {
    const localPath = path.join(localRoot, relativePath);
    const upstreamPath = path.join(upstreamRoot, relativePath);
    const localExists = await fileExists(localPath);
    const upstreamExists = await fileExists(upstreamPath);

    if (!upstreamExists) {
      actions.push({
        type: 'skip',
        path: relativePath,
        reason: 'missing from upstream source',
      });
      continue;
    }

    if (!localExists) {
      actions.push({ type: 'new-file', path: relativePath });
      continue;
    }

    if (config.strategy === 'section-merge') {
      const [localContent, upstreamContent] = await Promise.all([
        readText(localPath),
        readText(upstreamPath),
      ]);
      const merged = sectionMerge(localContent, upstreamContent, config);
      if (merged === null) {
        actions.push({
          type: 'conflict',
          path: relativePath,
          reason: 'legacy file without sync markers',
        });
      } else {
        const sections = [
          ...(config.harnessMarkers ?? []),
          ...(config.preserveMarkers ?? []),
        ];
        actions.push({ type: 'section-merge', path: relativePath, sections });
      }
      continue;
    }

    if (config.strategy === 'json-deep-merge') {
      const keys = [...(config.harnessKeys ?? []), ...(config.projectKeys ?? [])];
      actions.push({ type: 'json-merge', path: relativePath, keys });
      continue;
    }

    if (config.strategy === 'line-union') {
      actions.push({ type: 'line-merge', path: relativePath, reason: config.note ?? 'line union merge' });
      continue;
    }

    actions.push({ type: 'template-regen', path: relativePath });
  }

  const fromVersion = localConfig.harnessVersionInstalled ?? null;
  const toVersion = upstreamConfig.harnessVersion ?? manifest.manifestVersion;

  return {
    fromVersion,
    toVersion,
    actions,
    migrations: collectMigrationPaths(manifest, fromVersion, toVersion),
  };
}

export function sectionMerge(
  localContent: string,
  upstreamContent: string,
  config: HybridFileConfig,
): string | null {
  if (!hasMarkers(localContent)) {
    return null;
  }

  const localSections = new Map(
    findSectionBlocks(localContent).map((block) => [block.name, block.full]),
  );

  return upstreamContent.replace(
    /<!-- BEGIN:([A-Za-z0-9:_-]+) -->[\s\S]*?<!-- END:\1 -->/g,
    (fullMatch, rawName: string) => {
      const name = rawName;
      if (shouldPreserveMarker(name, config)) {
        return localSections.get(name) ?? fullMatch;
      }

      if ((config.harnessMarkers ?? []).includes(name)) {
        return fullMatch;
      }

      return fullMatch;
    },
  );
}

export function jsonDeepMerge(
  localJson: JsonValue | unknown,
  upstreamJson: JsonValue | unknown,
  config: HybridFileConfig,
): JsonValue {
  const result = cloneJson((isRecord(localJson) ? localJson : {}) as JsonValue);
  const harnessKeys = config.harnessKeys ?? [];

  for (const keyPath of harnessKeys) {
    if (keyPath.endsWith(':*')) {
      const prefixPath = keyPath.slice(0, -2);
      const parts = splitPath(prefixPath);
      const last = parts.at(-1);
      const parentPath = parts.slice(0, -1).join('.');
      const localParent = parentPath ? getAtPath(result, parentPath) : result;
      const upstreamParent = parentPath ? getAtPath(upstreamJson, parentPath) : upstreamJson;

      if (!last || !isRecord(localParent) || !isRecord(upstreamParent)) {
        continue;
      }

      for (const existingKey of Object.keys(localParent)) {
        if (existingKey.startsWith(last)) {
          delete localParent[existingKey];
        }
      }

      for (const [childKey, childValue] of Object.entries(upstreamParent)) {
        if (childKey.startsWith(last)) {
          localParent[childKey] = cloneJson(childValue);
        }
      }

      continue;
    }

    const upstreamValue = getAtPath(upstreamJson, keyPath);
    if (upstreamValue === undefined) {
      deleteAtPath(result, keyPath);
      continue;
    }
    setAtPath(result, keyPath, upstreamValue);
  }

  return result as JsonValue;
}

function splitLogicalLines(content: string): string[] {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  if (lines.at(-1) === '') {
    lines.pop();
  }
  return lines;
}

export function lineUnionMerge(localContent: string, upstreamContent: string): string {
  const merged = splitLogicalLines(localContent);
  const seen = new Set(merged);
  let appended = false;

  for (const line of splitLogicalLines(upstreamContent)) {
    if (line.length === 0 || seen.has(line)) {
      continue;
    }

    if (!appended && merged.length > 0 && merged.at(-1) !== '') {
      merged.push('');
    }
    merged.push(line);
    seen.add(line);
    appended = true;
  }

  return `${merged.join('\n')}\n`;
}

export async function computeFileHash(filePath: string): Promise<string> {
  const content = await readFile(filePath);
  return createHash('sha256').update(content).digest('hex');
}

export async function createBackup(localRoot: string, files: string[]): Promise<string> {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = path.join(localRoot, '.vibe', 'sync-backup', stamp);
  await mkdir(backupDir, { recursive: true });

  for (const relativePath of files) {
    const source = path.join(localRoot, relativePath);
    if (!(await fileExists(source))) {
      continue;
    }

    const target = path.join(backupDir, relativePath);
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(source, target);
  }

  return backupDir;
}

export async function applySyncPlan(
  localRoot: string,
  upstreamRoot: string,
  plan: SyncPlan,
  manifest: SyncManifest,
): Promise<void> {
  const syncHashes = await loadSyncHashes(localRoot);
  const hashTargets = new Set<string>();

  for (const action of plan.actions) {
    const localPath = path.join(localRoot, action.path);
    const upstreamPath = path.join(upstreamRoot, action.path);

    if (action.type === 'skip' || action.type === 'conflict') {
      continue;
    }

    if (action.type === 'delete') {
      await rm(localPath, { force: true });
      delete syncHashes.files[action.path];
      continue;
    }

    if (action.type === 'replace' || action.type === 'new-file' || action.type === 'template-regen') {
      await mkdir(path.dirname(localPath), { recursive: true });
      await copyFile(upstreamPath, localPath);
      hashTargets.add(action.path);
      continue;
    }

    if (action.type === 'section-merge') {
      const [localContent, upstreamContent] = await Promise.all([
        readText(localPath),
        readText(upstreamPath),
      ]);
      const config = manifest.files.hybrid[action.path];
      if (!config) {
        throw new Error(`Missing hybrid config for ${action.path}`);
      }
      const merged = sectionMerge(localContent, upstreamContent, config);
      if (merged === null) {
        throw new Error(`Cannot merge legacy file without markers: ${action.path}`);
      }
      await writeText(localPath, merged);
      hashTargets.add(action.path);
      continue;
    }

    if (action.type === 'json-merge') {
      const config = manifest.files.hybrid[action.path];
      if (!config) {
        throw new Error(`Missing hybrid config for ${action.path}`);
      }
      const [localJson, upstreamJson] = await Promise.all([
        readJson<JsonValue>(localPath),
        readJson<JsonValue>(upstreamPath),
      ]);
      const merged = jsonDeepMerge(localJson, upstreamJson, config);
      await writeJson(localPath, merged);
      hashTargets.add(action.path);
      continue;
    }

    if (action.type === 'line-merge') {
      const [localContent, upstreamContent] = await Promise.all([
        readText(localPath),
        readText(upstreamPath),
      ]);
      await writeText(localPath, lineUnionMerge(localContent, upstreamContent));
      hashTargets.add(action.path);
    }
  }

  for (const relativePath of hashTargets) {
    const target = path.join(localRoot, relativePath);
    if (await fileExists(target)) {
      syncHashes.files[relativePath] = await computeFileHash(target);
    }
  }

  await writeJson(path.join(localRoot, '.vibe', 'sync-hashes.json'), syncHashes);
}

export async function runMigrations(
  localRoot: string,
  upstreamRoot: string,
  migrations: string[],
): Promise<void> {
  for (const migration of migrations) {
    const scriptPath = path.join(upstreamRoot, migration);
    await runCommand('node', [scriptPath, localRoot], {
      cwd: localRoot,
    });
  }
}
