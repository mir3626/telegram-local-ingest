import path from 'node:path';
import { fileExists, readJson, writeJson } from './fs.js';
import { paths } from './paths.js';

export interface IterationEntry {
  id: string;
  label: string;
  startedAt: string;
  completedAt: string | null;
  goal: string;
  plannedSprints: string[];
  completedSprints: string[];
  milestoneProgress: Record<string, number>;
  summary: string;
}

export interface IterationHistory {
  currentIteration: string | null;
  iterations: IterationEntry[];
}

export interface Milestone {
  id: string;
  name: string;
  targetIteration: string;
  progressMetric: 'sprint_complete_ratio' | 'feature_coverage' | 'passing_tests_ratio' | string;
  definition?: string;
}

function resolveRoot(root?: string): string {
  return root ?? paths.root;
}

function iterationHistoryPath(root?: string): string {
  return path.join(resolveRoot(root), '.vibe', 'agent', 'iteration-history.json');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function normalizeEntry(value: unknown): IterationEntry | null {
  if (!isRecord(value)) {
    return null;
  }

  if (
    typeof value.id !== 'string' ||
    typeof value.label !== 'string' ||
    typeof value.startedAt !== 'string' ||
    !(typeof value.completedAt === 'string' || value.completedAt === null) ||
    typeof value.goal !== 'string' ||
    !isStringArray(value.plannedSprints) ||
    !isStringArray(value.completedSprints) ||
    !isRecord(value.milestoneProgress) ||
    typeof value.summary !== 'string'
  ) {
    return null;
  }

  const milestoneProgress: Record<string, number> = {};
  for (const [key, rawValue] of Object.entries(value.milestoneProgress)) {
    if (typeof rawValue === 'number' && Number.isFinite(rawValue)) {
      milestoneProgress[key] = rawValue;
    }
  }

  return {
    id: value.id,
    label: value.label,
    startedAt: value.startedAt,
    completedAt: value.completedAt,
    goal: value.goal,
    plannedSprints: [...value.plannedSprints],
    completedSprints: [...value.completedSprints],
    milestoneProgress,
    summary: value.summary,
  };
}

function normalizeHistory(value: unknown): IterationHistory {
  if (!isRecord(value)) {
    return { currentIteration: null, iterations: [] };
  }

  const currentIteration =
    typeof value.currentIteration === 'string' ? value.currentIteration : null;
  const iterations = Array.isArray(value.iterations)
    ? value.iterations.map(normalizeEntry).filter((entry): entry is IterationEntry => entry !== null)
    : [];

  return { currentIteration, iterations };
}

export async function readIterationHistory(root?: string): Promise<IterationHistory> {
  const filePath = iterationHistoryPath(root);
  if (!(await fileExists(filePath))) {
    return { currentIteration: null, iterations: [] };
  }

  return normalizeHistory(await readJson<unknown>(filePath));
}

export async function writeIterationHistory(
  history: IterationHistory,
  root?: string,
): Promise<void> {
  await writeJson(iterationHistoryPath(root), normalizeHistory(history));
}

export async function startIteration(
  input: { id: string; label: string; goal: string; plannedSprints: string[] },
  root?: string,
): Promise<IterationEntry> {
  const history = await readIterationHistory(root);
  if (history.iterations.some((entry) => entry.id === input.id)) {
    throw new Error(`iteration already exists: ${input.id}`);
  }

  const entry: IterationEntry = {
    id: input.id,
    label: input.label,
    startedAt: new Date().toISOString(),
    completedAt: null,
    goal: input.goal,
    plannedSprints: [...input.plannedSprints],
    completedSprints: [],
    milestoneProgress: {},
    summary: '',
  };
  history.currentIteration = input.id;
  history.iterations.push(entry);
  await writeIterationHistory(history, root);
  return { ...entry, plannedSprints: [...entry.plannedSprints], completedSprints: [] };
}

export async function recordSprintCompletion(sprintId: string, root?: string): Promise<void> {
  const history = await readIterationHistory(root);
  const current =
    history.iterations.find((entry) => entry.id === history.currentIteration) ??
    history.iterations.find(
      (entry) => entry.completedAt === null && entry.plannedSprints.includes(sprintId),
    );

  if (!current || current.completedSprints.includes(sprintId)) {
    return;
  }

  current.completedSprints.push(sprintId);
  await writeIterationHistory(history, root);
}

export async function completeIteration(summary: string, root?: string): Promise<IterationEntry> {
  const history = await readIterationHistory(root);
  const current = history.iterations.find((entry) => entry.id === history.currentIteration);
  if (!current) {
    throw new Error('no current iteration to complete');
  }

  current.completedAt = new Date().toISOString();
  current.summary = summary;
  history.currentIteration = null;
  await writeIterationHistory(history, root);
  return {
    ...current,
    plannedSprints: [...current.plannedSprints],
    completedSprints: [...current.completedSprints],
    milestoneProgress: { ...current.milestoneProgress },
  };
}

export function computeMilestoneProgress(
  history: IterationHistory,
  milestones: Milestone[],
): Record<string, number> {
  const progress: Record<string, number> = {};

  for (const milestone of milestones) {
    if (milestone.progressMetric !== 'sprint_complete_ratio') {
      progress[milestone.id] = 0;
      continue;
    }

    const target = history.iterations.find((entry) => entry.id === milestone.targetIteration);
    if (!target || target.plannedSprints.length === 0) {
      progress[milestone.id] = 0;
      continue;
    }

    progress[milestone.id] = target.completedSprints.length / target.plannedSprints.length;
  }

  return progress;
}
