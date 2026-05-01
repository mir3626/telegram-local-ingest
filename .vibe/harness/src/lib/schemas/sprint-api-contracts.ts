import { z } from 'zod';

export const SprintApiContractSchema = z.object({
  publicExports: z.record(z.array(z.string())),
  types: z.record(z.array(z.string())),
});

export const SprintApiContractsSchema = z.object({
  $schema: z.string().optional(),
  schemaVersion: z.literal('0.1'),
  updatedAt: z.string().datetime(),
  contracts: z.record(SprintApiContractSchema),
});

export type SprintApiContract = z.infer<typeof SprintApiContractSchema>;
export type SprintApiContracts = z.infer<typeof SprintApiContractsSchema>;
