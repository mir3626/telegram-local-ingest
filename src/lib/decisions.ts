import path from 'node:path';
import { appendJsonl, fileExists, readText } from './fs.js';
import { paths } from './paths.js';

export interface ProjectDecision {
  sprintId: string;
  decision: string;
  affectedFiles: string[];
  tag: 'decision' | 'discovery' | 'deviation' | 'risk';
  text: string;
  createdAt: string;
}

function decisionsPath(root?: string): string {
  const baseRoot = root ?? paths.root;
  return path.join(baseRoot, '.vibe', 'agent', 'project-decisions.jsonl');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeScopeEntry(entry: string): string {
  return entry.replace(/\\/g, '/');
}

function scopePatternToRegex(entry: string): RegExp | null {
  if (!entry.includes('*')) {
    return null;
  }

  const normalized = normalizeScopeEntry(entry);
  let pattern = '^';

  for (let index = 0; index < normalized.length; index += 1) {
    const current = normalized[index];
    if (current === undefined) {
      continue;
    }
    if (current === '*') {
      const next = normalized[index + 1];
      if (next === '*') {
        pattern += '.*';
        index += 1;
      } else {
        pattern += '[^/]*';
      }
      continue;
    }

    pattern += escapeRegExp(current);
  }

  pattern += '$';
  return new RegExp(pattern);
}

export function isProjectDecision(value: unknown): value is ProjectDecision {
  return (
    isRecord(value) &&
    typeof value.sprintId === 'string' &&
    typeof value.decision === 'string' &&
    isStringArray(value.affectedFiles) &&
    (value.tag === 'decision' ||
      value.tag === 'discovery' ||
      value.tag === 'deviation' ||
      value.tag === 'risk') &&
    typeof value.text === 'string' &&
    typeof value.createdAt === 'string'
  );
}

export async function appendDecision(
  input: Omit<ProjectDecision, 'createdAt'> & { createdAt?: string },
  root?: string,
): Promise<ProjectDecision> {
  const record: ProjectDecision = {
    ...input,
    affectedFiles: input.affectedFiles.map((entry) => normalizeScopeEntry(entry)),
    createdAt: input.createdAt ?? new Date().toISOString(),
  };
  await appendJsonl(decisionsPath(root), record);
  return record;
}

export async function readDecisions(root?: string): Promise<ProjectDecision[]> {
  const filePath = decisionsPath(root);
  if (!(await fileExists(filePath))) {
    return [];
  }

  const raw = await readText(filePath);
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  const decisions: ProjectDecision[] = [];
  const lines = text.split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }

    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (!isProjectDecision(parsed)) {
        console.error(`[decisions] invalid record skipped: ${trimmed}`);
        continue;
      }
      decisions.push({
        ...parsed,
        affectedFiles: parsed.affectedFiles.map((entry) => normalizeScopeEntry(entry)),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.error(`[decisions] failed to parse record: ${reason}`);
    }
  }

  return decisions;
}

export function filterDecisionsByScope(
  decisions: ProjectDecision[],
  scope: string[],
): ProjectDecision[] {
  const normalizedScope = scope.map((entry) => normalizeScopeEntry(entry));
  const matched = new Set<number>();
  const result: ProjectDecision[] = [];

  decisions.forEach((decision, index) => {
    const affectedFiles = decision.affectedFiles.map((entry) => normalizeScopeEntry(entry));
    const hit = normalizedScope.some((scopeEntry) => {
      const pattern = scopePatternToRegex(scopeEntry);
      if (pattern) {
        return affectedFiles.some((filePath) => pattern.test(filePath));
      }

      return affectedFiles.some(
        (filePath) => filePath === scopeEntry || filePath.startsWith(scopeEntry),
      );
    });

    if (!hit || matched.has(index)) {
      return;
    }

    matched.add(index);
    result.push(decision);
  });

  return result;
}
