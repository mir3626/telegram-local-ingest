import { readJson } from './fs.js';
import { paths } from './paths.js';

export interface ProviderRunner {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export type SprintRoleDefinition =
  | string
  | {
      provider: string;
      tier: 'flagship' | 'performant' | 'efficient';
    };

export interface SprintRoles {
  planner: SprintRoleDefinition;
  generator: SprintRoleDefinition;
  evaluator: SprintRoleDefinition;
}

export interface SprintConfig {
  unit: string;
  subAgentPerRole: boolean;
  freshContextPerSprint: boolean;
}

export interface BundleConfig {
  enabled: boolean;
  dir: string;
  path?: string;
  limitGzipKB: number;
  excludeExt: string[];
}

export interface BrowserSmokeConfig {
  enabled: boolean;
  configPath: string;
  dist?: string;
}

export interface VibeConfig {
  orchestrator: string;
  harnessVersion?: string;
  harnessVersionInstalled?: string;
  mode?: 'human' | 'agent';
  upstream?: {
    type: 'git' | 'local';
    url: string;
    ref?: string;
  };
  sprintRoles: SprintRoles;
  sprint: SprintConfig;
  providers: Record<string, ProviderRunner>;
  qa?: {
    preferScripts?: string[];
  };
  bundle?: BundleConfig;
  browserSmoke?: BrowserSmokeConfig;
}

export type VibeConfigOverride = Partial<
  Omit<VibeConfig, 'sprintRoles' | 'sprint' | 'providers' | 'qa' | 'bundle' | 'browserSmoke'>
> & {
  sprintRoles?: Partial<SprintRoles>;
  sprint?: Partial<SprintConfig>;
  providers?: Record<string, ProviderRunner>;
  qa?: Partial<NonNullable<VibeConfig['qa']>>;
  bundle?: Partial<BundleConfig>;
  browserSmoke?: Partial<BrowserSmokeConfig>;
};

function resolveBundleConfig(
  base: Partial<BundleConfig> | undefined,
  override: Partial<BundleConfig> | undefined,
): BundleConfig {
  const dir = override?.dir ?? base?.dir ?? 'dist';

  return {
    enabled: override?.enabled ?? base?.enabled ?? false,
    dir,
    path: override?.path ?? base?.path ?? dir,
    limitGzipKB: override?.limitGzipKB ?? base?.limitGzipKB ?? 80,
    excludeExt: override?.excludeExt ?? base?.excludeExt ?? ['.map'],
  };
}

function resolveBrowserSmokeConfig(
  base: Partial<BrowserSmokeConfig> | undefined,
  override: Partial<BrowserSmokeConfig> | undefined,
): BrowserSmokeConfig {
  return {
    enabled: override?.enabled ?? base?.enabled ?? false,
    configPath: override?.configPath ?? base?.configPath ?? '.vibe/smoke.config.js',
    dist: override?.dist ?? base?.dist ?? 'dist',
  };
}

function mergeConfig(base: VibeConfig, override: VibeConfigOverride): VibeConfig {
  const {
    sprintRoles,
    sprint,
    providers,
    qa,
    bundle,
    browserSmoke,
    ...overrideRest
  } = override;
  const merged: VibeConfig = {
    ...base,
    ...overrideRest,
    sprintRoles: {
      ...base.sprintRoles,
      ...(sprintRoles ?? {}),
    },
    sprint: {
      ...base.sprint,
      ...(sprint ?? {}),
    },
    providers: {
      ...base.providers,
      ...(providers ?? {}),
    },
    qa: {
      ...(base.qa ?? {}),
      ...(qa ?? {}),
    },
  };

  if (base.bundle || bundle) {
    merged.bundle = resolveBundleConfig(base.bundle, bundle);
  }

  if (base.browserSmoke || browserSmoke) {
    merged.browserSmoke = resolveBrowserSmokeConfig(base.browserSmoke, browserSmoke);
  }

  return merged;
}

export async function loadConfig(): Promise<VibeConfig> {
  const shared = await readJson<VibeConfig>(paths.sharedConfig);

  try {
    const local = await readJson<VibeConfigOverride>(paths.localConfig);
    return mergeConfig(shared, local);
  } catch {
    return shared;
  }
}

export { mergeConfig };
