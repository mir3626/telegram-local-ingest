import { z } from 'zod';

export const ModelEntrySchema = z.object({
  apiId: z.string(),
  release: z.string(),
});

export const ProviderRegistryEntrySchema = z.object({
  tiers: z
    .object({
      flagship: z.string().optional(),
      performant: z.string().optional(),
      efficient: z.string().optional(),
    })
    .strict(),
  knownModels: z.record(ModelEntrySchema),
});

export const ModelRegistrySchema = z.object({
  $schema: z.string().optional(),
  schemaVersion: z.literal(1),
  updatedAt: z.string().datetime(),
  source: z.string(),
  providers: z.record(ProviderRegistryEntrySchema),
});

export type ModelEntry = z.infer<typeof ModelEntrySchema>;
export type ProviderRegistryEntry = z.infer<typeof ProviderRegistryEntrySchema>;
export type ModelRegistry = z.infer<typeof ModelRegistrySchema>;
