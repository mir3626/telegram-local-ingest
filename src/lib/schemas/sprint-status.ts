import { z } from 'zod';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeLegacyHandoff(value: unknown): unknown {
  if (!isRecord(value)) {
    return value;
  }

  return {
    ...value,
    lastActionSummary:
      typeof value.lastActionSummary === 'string'
        ? value.lastActionSummary
        : typeof value.nextAction === 'string'
          ? value.nextAction
          : '',
    orchestratorContextBudget:
      value.orchestratorContextBudget === 'low' ||
      value.orchestratorContextBudget === 'medium' ||
      value.orchestratorContextBudget === 'high'
        ? value.orchestratorContextBudget
        : 'medium',
    preferencesActive: Array.isArray(value.preferencesActive) ? value.preferencesActive : [],
    updatedAt:
      typeof value.updatedAt === 'string'
        ? value.updatedAt
        : typeof value.lastHandoffAt === 'string'
          ? value.lastHandoffAt
          : undefined,
  };
}

function normalizeLegacySprintStatus(value: unknown): unknown {
  if (!isRecord(value)) {
    return value;
  }

  const policies = isRecord(value.policies) ? value.policies : {};
  const verificationCommands = Array.isArray(value.verificationCommands)
    ? value.verificationCommands
    : Array.isArray(policies.verificationCommands)
      ? policies.verificationCommands
      : [];

  return {
    ...value,
    verificationCommands,
    handoff: value.handoff === undefined ? undefined : normalizeLegacyHandoff(value.handoff),
  };
}

export const PendingRiskSchema = z.object({
  id: z.string(),
  raisedBy: z.string(),
  targetSprint: z.string(),
  text: z.string(),
  status: z.enum(['open', 'acknowledged', 'resolved']),
  createdAt: z.string().datetime(),
  resolvedAt: z.string().datetime().optional(),
});

export const VerificationCommandSchema = z.object({
  id: z.string(),
  command: z.string(),
  expectExitCode: z.number().int().default(0),
  expectStdoutContains: z.string().optional(),
  introducedInSprint: z.string().optional(),
  runOutsideSandbox: z.boolean().optional(),
});

export const ActualLocSchema = z.object({
  added: z.number().int(),
  deleted: z.number().int(),
  net: z.number().int(),
  filesChanged: z.number().int(),
});

export const SprintEntrySchema = z.object({
  id: z.string(),
  name: z.string(),
  status: z.enum(['planned', 'in_progress', 'passed', 'failed', 'skipped']),
  startedAt: z.string().optional(),
  completedAt: z.string().optional(),
  planPromptPath: z.string().optional(),
  generatorReportPath: z.string().optional(),
  evaluatorVerdict: z.enum(['pass', 'fail', 'skipped']).optional(),
  addedVerificationCommands: z.array(VerificationCommandSchema).optional(),
  deviations: z.array(z.string()).optional(),
  actualLoc: ActualLocSchema.optional(),
});

export const HandoffBlockSchema = z
  .preprocess(
    normalizeLegacyHandoff,
    z
      .object({
        currentSprintId: z.string(),
        lastActionSummary: z.string(),
        openIssues: z.array(z.string()).optional(),
        orchestratorContextBudget: z.enum(['low', 'medium', 'high']),
        preferencesActive: z.array(z.string()),
        handoffDocPath: z.string().optional(),
        updatedAt: z.string().datetime().optional(),
      })
      .passthrough(),
  );

export const SandboxNoteSchema = z.object({
  command: z.string(),
  reason: z.string(),
  runOutsideSandbox: z.boolean().optional(),
});

export const SprintStatusSchema = z.preprocess(
  normalizeLegacySprintStatus,
  z
    .object({
      $schema: z.string().optional(),
      schemaVersion: z.literal('0.1'),
      project: z.object({
        name: z.string(),
        createdAt: z.string().datetime(),
        runtime: z.string().optional(),
        framework: z.string().optional(),
      }),
      sprints: z.array(SprintEntrySchema),
      verificationCommands: z.array(VerificationCommandSchema),
      handoff: HandoffBlockSchema.optional(),
      sandboxNotes: z.array(SandboxNoteSchema).optional(),
      pendingRisks: z.array(PendingRiskSchema).default([]),
      lastSprintScope: z.array(z.string()).default([]),
      lastSprintScopeGlob: z.array(z.string()).default([]),
      sprintsSinceLastAudit: z.number().int().min(0).default(0),
      stateUpdatedAt: z.string().datetime().optional(),
      verifiedAt: z.string().datetime().nullable().optional(),
    })
    .passthrough(),
);

export type SprintStatus = z.infer<typeof SprintStatusSchema>;
export type PendingRisk = z.infer<typeof PendingRiskSchema>;
export type VerificationCommand = z.infer<typeof VerificationCommandSchema>;
export type ActualLoc = z.infer<typeof ActualLocSchema>;
export type SprintEntry = z.infer<typeof SprintEntrySchema>;
export type HandoffBlock = z.infer<typeof HandoffBlockSchema>;
export type SandboxNote = z.infer<typeof SandboxNoteSchema>;
