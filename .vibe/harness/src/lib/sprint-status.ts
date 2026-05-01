import path from 'node:path';
import { readJson, writeJson } from './fs.js';
import { paths } from './paths.js';
import {
  PendingRiskSchema,
  SprintStatusSchema,
  type ActualLoc,
  type HandoffBlock,
  type PendingRisk,
  type SandboxNote,
  type SprintEntry,
  type SprintStatus as ParsedSprintStatus,
  type VerificationCommand,
} from './schemas/sprint-status.js';

export type {
  ActualLoc,
  HandoffBlock,
  PendingRisk,
  SandboxNote,
  SprintEntry,
  VerificationCommand,
};

export type SprintStatus = ParsedSprintStatus & {
  pendingRisks: PendingRisk[];
  lastSprintScope: string[];
  lastSprintScopeGlob: string[];
  sprintsSinceLastAudit: number;
  stateUpdatedAt: string;
};

function resolveRoot(root?: string): string {
  return root ?? paths.root;
}

function sprintStatusPath(root?: string): string {
  return path.join(resolveRoot(root), '.vibe', 'agent', 'sprint-status.json');
}

function normalizeScopeEntry(entry: string): string {
  return entry.replace(/\\/g, '/');
}

function mergeScopeEntries(existing: string[], incoming: string[]): string[] {
  const seen = new Set<string>();
  const merged: string[] = [];

  for (const rawEntry of [...existing, ...incoming]) {
    const entry = normalizeScopeEntry(rawEntry);
    if (seen.has(entry)) {
      continue;
    }
    seen.add(entry);
    merged.push(entry);
  }

  return merged;
}

function isIsoDateString(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function nextStateUpdatedAt(
  partial: Partial<ParsedSprintStatus> & {
    project: ParsedSprintStatus['project'];
  },
): string {
  if (isIsoDateString(partial.stateUpdatedAt)) {
    return partial.stateUpdatedAt;
  }

  if (isIsoDateString(partial.handoff?.updatedAt)) {
    return partial.handoff.updatedAt;
  }

  if (isIsoDateString(partial.project.createdAt)) {
    return partial.project.createdAt;
  }

  return new Date().toISOString();
}

export function isPendingRisk(value: unknown): value is PendingRisk {
  return PendingRiskSchema.safeParse(value).success;
}

export function isSprintStatus(value: unknown): value is SprintStatus {
  return SprintStatusSchema.safeParse(value).success;
}

export function withDefaults(
  partial: Partial<ParsedSprintStatus> & {
    schemaVersion: '0.1';
    project: ParsedSprintStatus['project'];
    sprints: SprintEntry[];
    verificationCommands: VerificationCommand[];
  },
): SprintStatus {
  const parsed = SprintStatusSchema.parse({
    ...partial,
    stateUpdatedAt: nextStateUpdatedAt(partial),
  });
  return cloneJson(parsed) as SprintStatus;
}

async function loadStatusForMutation(root?: string): Promise<SprintStatus> {
  return loadSprintStatus(root);
}

async function persistStatus(
  status: SprintStatus,
  updateStateUpdatedAt: boolean,
  root?: string,
): Promise<void> {
  const nextStatus = withDefaults(status);
  if (updateStateUpdatedAt) {
    nextStatus.stateUpdatedAt = new Date().toISOString();
  }
  await writeJson(sprintStatusPath(root), nextStatus);
}

export async function loadSprintStatus(root?: string): Promise<SprintStatus> {
  const filePath = sprintStatusPath(root);
  const loaded = await readJson<unknown>(filePath);
  const parsed = SprintStatusSchema.safeParse(loaded);
  if (!parsed.success) {
    throw new Error(`Invalid sprint status at ${filePath}: ${parsed.error.message}`);
  }

  return withDefaults(parsed.data);
}

export async function saveSprintStatus(status: SprintStatus, root?: string): Promise<void> {
  await persistStatus(status, true, root);
}

export async function appendPendingRisk(
  risk: Omit<PendingRisk, 'createdAt' | 'status'> & { status?: PendingRisk['status'] },
  root?: string,
): Promise<PendingRisk> {
  const status = await loadStatusForMutation(root);
  if (status.pendingRisks.some((entry) => entry.id === risk.id)) {
    throw new Error(`pendingRisk id already exists: ${risk.id}`);
  }

  const nextRisk: PendingRisk = {
    ...risk,
    status: risk.status ?? 'open',
    createdAt: new Date().toISOString(),
  };
  status.pendingRisks.push(nextRisk);
  await saveSprintStatus(status, root);
  return cloneJson(nextRisk);
}

export async function resolvePendingRisk(id: string, root?: string): Promise<PendingRisk | null> {
  const status = await loadStatusForMutation(root);
  const risk = status.pendingRisks.find((entry) => entry.id === id);
  if (!risk) {
    return null;
  }

  risk.status = 'resolved';
  risk.resolvedAt = new Date().toISOString();
  await saveSprintStatus(status, root);
  return cloneJson(risk);
}

export async function resolvePendingRisksByPrefix(
  prefix: string,
  root?: string,
): Promise<number> {
  const status = await loadStatusForMutation(root);
  let resolvedCount = 0;

  for (const risk of status.pendingRisks) {
    if (!risk.id.startsWith(prefix) || risk.status !== 'open') {
      continue;
    }

    risk.status = 'resolved';
    risk.resolvedAt = new Date().toISOString();
    resolvedCount += 1;
  }

  if (resolvedCount > 0) {
    await saveSprintStatus(status, root);
  }

  return resolvedCount;
}

export async function incrementAuditCounter(root?: string): Promise<number> {
  const status = await loadStatusForMutation(root);
  status.sprintsSinceLastAudit += 1;
  await saveSprintStatus(status, root);
  return status.sprintsSinceLastAudit;
}

export async function resetAuditCounter(root?: string): Promise<void> {
  const status = await loadStatusForMutation(root);
  status.sprintsSinceLastAudit = 0;
  await saveSprintStatus(status, root);
}

export async function touchStateUpdated(root?: string): Promise<string> {
  const status = await loadStatusForMutation(root);
  const nextIso = new Date().toISOString();
  status.stateUpdatedAt = nextIso;
  await persistStatus(status, false, root);
  return nextIso;
}

export async function markVerified(root?: string): Promise<string> {
  const status = await loadStatusForMutation(root);
  const nextIso = new Date().toISOString();
  status.verifiedAt = nextIso;
  await persistStatus(status, false, root);
  return nextIso;
}

export async function extendLastSprintScope(
  scopePaths: string[],
  globs?: string[],
  root?: string,
): Promise<{ lastSprintScope: string[]; lastSprintScopeGlob: string[] }> {
  if (scopePaths.length === 0 && globs === undefined) {
    const status = await loadSprintStatus(root);
    return {
      lastSprintScope: [...status.lastSprintScope],
      lastSprintScopeGlob: [...status.lastSprintScopeGlob],
    };
  }

  const status = await loadStatusForMutation(root);
  const nextScope = mergeScopeEntries(status.lastSprintScope, scopePaths);
  const nextGlobs =
    globs === undefined
      ? [...status.lastSprintScopeGlob]
      : mergeScopeEntries(status.lastSprintScopeGlob, globs);

  if (
    nextScope.length === status.lastSprintScope.length &&
    nextGlobs.length === status.lastSprintScopeGlob.length &&
    nextScope.every((entry, index) => entry === status.lastSprintScope[index]) &&
    nextGlobs.every((entry, index) => entry === status.lastSprintScopeGlob[index])
  ) {
    return {
      lastSprintScope: [...status.lastSprintScope],
      lastSprintScopeGlob: [...status.lastSprintScopeGlob],
    };
  }

  status.lastSprintScope = nextScope;
  status.lastSprintScopeGlob = nextGlobs;
  await saveSprintStatus(status, root);

  return {
    lastSprintScope: [...status.lastSprintScope],
    lastSprintScopeGlob: [...status.lastSprintScopeGlob],
  };
}
