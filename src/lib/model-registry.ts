import path from 'node:path';
import { ZodError } from 'zod';
import { readJson } from './fs.js';
import { paths } from './paths.js';
import { ModelRegistrySchema } from './schemas/model-registry.js';

export type { ModelEntry, ModelRegistry, ProviderRegistryEntry } from './schemas/model-registry.js';
import type { ModelRegistry, ProviderRegistryEntry } from './schemas/model-registry.js';

export type TierRef = {
  provider: string;
  tier: 'flagship' | 'performant' | 'efficient';
};

export type RoleRef = string | TierRef;

export interface ResolvedModel {
  provider: string;
  tier?: 'flagship' | 'performant' | 'efficient';
  familyAlias: string;
  apiId: string;
  legacy: boolean;
}

const TIER_ORDER: TierRef['tier'][] = ['flagship', 'performant', 'efficient'];

function registryPath(root?: string): string {
  return path.join(root ?? paths.root, '.vibe', 'model-registry.json');
}

function formatAvailable(values: string[]): string {
  return values.length > 0 ? values.join(', ') : 'none';
}

function availableProviders(registry: ModelRegistry): string[] {
  return Object.keys(registry.providers).sort();
}

function availableTiers(provider: ProviderRegistryEntry): TierRef['tier'][] {
  return TIER_ORDER.filter((tier) => typeof provider.tiers[tier] === 'string');
}

export async function loadRegistry(root?: string): Promise<ModelRegistry> {
  const filePath = registryPath(root);
  const loaded = await readJson<unknown>(filePath);

  try {
    return ModelRegistrySchema.parse(loaded);
  } catch (error) {
    if (error instanceof ZodError) {
      const versionIssue = error.issues.find((issue) => issue.path.includes('schemaVersion'));
      if (versionIssue && typeof loaded === 'object' && loaded !== null && 'schemaVersion' in loaded) {
        const schemaVersion = (loaded as { schemaVersion: unknown }).schemaVersion;
        throw new Error(
          `registry schemaVersion ${String(schemaVersion)} is unsupported; run npm run vibe:sync to refresh the harness registry`,
        );
      }
    }
    throw error;
  }
}

export function resolveModel(
  registry: ModelRegistry,
  providerId: string,
  tier: TierRef['tier'],
): ResolvedModel {
  const provider = registry.providers[providerId];
  if (!provider) {
    throw new Error(
      `registry: unknown provider "${providerId}" (available: ${formatAvailable(availableProviders(registry))})`,
    );
  }

  const familyAlias = provider.tiers[tier];
  if (!familyAlias) {
    throw new Error(
      `registry: provider "${providerId}" has no tier "${tier}" (available: ${formatAvailable(availableTiers(provider))})`,
    );
  }

  const model = provider.knownModels[familyAlias];
  if (!model) {
    throw new Error(
      `registry: provider "${providerId}" tier "${tier}" points to unknown family alias "${familyAlias}"`,
    );
  }

  return {
    provider: providerId,
    tier,
    familyAlias,
    apiId: model.apiId,
    legacy: false,
  };
}

export function resolveRoleRef(registry: ModelRegistry | null, ref: RoleRef): ResolvedModel {
  if (typeof ref === 'string') {
    return {
      provider: ref,
      familyAlias: ref,
      apiId: ref,
      legacy: true,
    };
  }

  if (!registry) {
    throw new Error(
      `registry: provider "${ref.provider}" tier "${ref.tier}" requires .vibe/model-registry.json`,
    );
  }

  return resolveModel(registry, ref.provider, ref.tier);
}

export function resolveFromConfig(
  sprintRoles: Record<string, RoleRef>,
  roleName: string,
  registry: ModelRegistry | null,
): ResolvedModel {
  const ref = sprintRoles[roleName];
  if (!ref) {
    const available = Object.keys(sprintRoles).sort();
    throw new Error(`unknown role "${roleName}" (available: ${formatAvailable(available)})`);
  }

  return resolveRoleRef(registry, ref);
}
