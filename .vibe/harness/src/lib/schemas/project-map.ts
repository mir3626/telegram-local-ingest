import { z } from 'zod';

export const ProjectMapModuleSchema = z.object({
  exports: z.array(z.string()),
  imports: z.array(z.string()),
  sprintAdded: z.string().optional(),
});

export const ActivePlatformRuleSchema = z.object({
  rule: z.string(),
  location: z.string(),
  sprintAdded: z.string(),
});

export const ProjectMapSchema = z.object({
  $schema: z.string().optional(),
  schemaVersion: z.literal('0.1'),
  updatedAt: z.string().datetime(),
  lastSprintId: z.string().optional(),
  modules: z.record(ProjectMapModuleSchema),
  activePlatformRules: z.array(ActivePlatformRuleSchema),
});

export type ProjectMapModule = z.infer<typeof ProjectMapModuleSchema>;
export type ActivePlatformRule = z.infer<typeof ActivePlatformRuleSchema>;
export type ProjectMap = z.infer<typeof ProjectMapSchema>;
