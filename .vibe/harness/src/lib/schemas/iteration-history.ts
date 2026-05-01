import { z } from 'zod';

export const IterationEntrySchema = z
  .object({
    id: z.string(),
    label: z.string(),
    startedAt: z.string(),
    completedAt: z.string().nullable(),
    goal: z.string(),
    plannedSprints: z.array(z.string()),
    completedSprints: z.array(z.string()),
    milestoneProgress: z.record(z.number()),
    summary: z.string(),
  })
  .passthrough();

export const IterationHistorySchema = z
  .object({
    $schema: z.string().optional(),
    currentIteration: z.string().nullable(),
    iterations: z.array(IterationEntrySchema),
  })
  .passthrough();

export type IterationEntry = z.infer<typeof IterationEntrySchema>;
export type IterationHistory = z.infer<typeof IterationHistorySchema>;
