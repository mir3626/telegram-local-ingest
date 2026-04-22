import path from 'node:path';
import { fileExists, readJson, writeJson } from './fs.js';
import { paths } from './paths.js';
import {
  ActivePlatformRuleSchema,
  ProjectMapModuleSchema,
  ProjectMapSchema,
  type ActivePlatformRule,
  type ProjectMap,
  type ProjectMapModule,
} from './schemas/project-map.js';

export type { ActivePlatformRule, ProjectMap, ProjectMapModule };

function resolveRoot(root?: string): string {
  return root ?? paths.root;
}

function projectMapPath(root?: string): string {
  return path.join(resolveRoot(root), '.vibe', 'agent', 'project-map.json');
}

function normalizeModulePath(value: string): string {
  return value.replace(/\\/g, '/');
}

function emptyProjectMap(): ProjectMap {
  return {
    schemaVersion: '0.1',
    updatedAt: new Date().toISOString(),
    modules: {},
    activePlatformRules: [],
  };
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function isProjectMap(value: unknown): value is ProjectMap {
  return ProjectMapSchema.safeParse(value).success;
}

export async function loadProjectMap(root?: string): Promise<ProjectMap> {
  const filePath = projectMapPath(root);
  if (!(await fileExists(filePath))) {
    return emptyProjectMap();
  }

  const loaded = await readJson<unknown>(filePath);
  const parsed = ProjectMapSchema.safeParse(loaded);
  if (!parsed.success) {
    throw new Error(`Invalid project map at ${filePath}: ${parsed.error.message}`);
  }

  return cloneJson(parsed.data);
}

export async function saveProjectMap(map: ProjectMap, root?: string): Promise<void> {
  const nextMap = ProjectMapSchema.parse(cloneJson(map));
  nextMap.updatedAt = new Date().toISOString();
  await writeJson(projectMapPath(root), nextMap);
}

export async function registerModule(args: {
  path: string;
  exports: string[];
  imports: string[];
  sprintId: string;
  root?: string;
}): Promise<ProjectMap> {
  const map = await loadProjectMap(args.root);
  const key = normalizeModulePath(args.path);
  const existing = map.modules[key];
  map.modules[key] = {
    exports: [...args.exports],
    imports: [...args.imports],
    sprintAdded: existing?.sprintAdded ?? args.sprintId,
  };
  map.lastSprintId = args.sprintId;
  await saveProjectMap(map, args.root);
  return loadProjectMap(args.root);
}

export async function registerPlatformRule(args: {
  rule: string;
  location: string;
  sprintId: string;
  root?: string;
}): Promise<ProjectMap> {
  const map = await loadProjectMap(args.root);
  const exists = map.activePlatformRules.some(
    (entry) => entry.rule === args.rule && entry.location === args.location,
  );
  if (exists) {
    return map;
  }

  map.activePlatformRules.push({
    rule: args.rule,
    location: args.location,
    sprintAdded: args.sprintId,
  });
  map.lastSprintId = args.sprintId;
  await saveProjectMap(map, args.root);
  return loadProjectMap(args.root);
}

export function mergeProjectMaps(base: ProjectMap, incoming: Partial<ProjectMap>): ProjectMap {
  const mergedModules: Record<string, ProjectMapModule> = Object.fromEntries(
    Object.entries(base.modules).map(([key, value]) => [key, cloneJson(value)]),
  );
  for (const [key, value] of Object.entries(incoming.modules ?? {})) {
    const parsed = ProjectMapModuleSchema.safeParse(value);
    if (parsed.success) {
      mergedModules[key] = cloneJson(parsed.data);
    }
  }

  const rules: ActivePlatformRule[] = [];
  const seen = new Set<string>();
  for (const rule of [...base.activePlatformRules, ...(incoming.activePlatformRules ?? [])]) {
    const parsed = ActivePlatformRuleSchema.safeParse(rule);
    if (!parsed.success) {
      continue;
    }
    const dedupeKey = `${parsed.data.rule}\u0000${parsed.data.location}`;
    if (seen.has(dedupeKey)) {
      continue;
    }
    seen.add(dedupeKey);
    rules.push(cloneJson(parsed.data));
  }

  return ProjectMapSchema.parse({
    ...(incoming.$schema !== undefined
      ? { $schema: incoming.$schema }
      : base.$schema !== undefined
        ? { $schema: base.$schema }
        : {}),
    schemaVersion: incoming.schemaVersion ?? base.schemaVersion,
    updatedAt: incoming.updatedAt ?? base.updatedAt,
    ...(incoming.lastSprintId !== undefined
      ? { lastSprintId: incoming.lastSprintId }
      : base.lastSprintId !== undefined
        ? { lastSprintId: base.lastSprintId }
        : {}),
    modules: mergedModules,
    activePlatformRules: rules,
  });
}
