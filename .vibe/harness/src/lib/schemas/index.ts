import { z, type ZodError } from 'zod';
import { SprintStatusSchema } from './sprint-status.js';
import { ProjectMapSchema } from './project-map.js';
import { SprintApiContractsSchema } from './sprint-api-contracts.js';
import { IterationHistorySchema } from './iteration-history.js';
import { ModelRegistrySchema } from './model-registry.js';

export const STATE_FILE_SCHEMAS = {
  'sprint-status.json': SprintStatusSchema,
  'project-map.json': ProjectMapSchema,
  'sprint-api-contracts.json': SprintApiContractsSchema,
  'iteration-history.json': IterationHistorySchema,
  'model-registry.json': ModelRegistrySchema,
} as const;

export type StateFileName = keyof typeof STATE_FILE_SCHEMAS;

export interface ParseStateResult {
  ok: boolean;
  data?: unknown;
  error?: string;
  fixSuggestion?: string;
}

export function generateFixSuggestion(err: ZodError): string {
  const issues = err.issues.slice(0, 5).map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join('.') : '<root>';
    return `- ${path}: ${issue.message} (code=${issue.code})`;
  });

  return `Missing/invalid fields:\n${issues.join('\n')}\n\nSuggested: run 'node .vibe/harness/migrations/1.4.0.mjs' to patch bootstrap defaults.`;
}

export function parseStateFile(name: string, content: string): ParseStateResult {
  const schema = (STATE_FILE_SCHEMAS as Record<string, z.ZodTypeAny>)[name];
  if (!schema) {
    return { ok: false, error: `Unknown state file: ${name}` };
  }

  let json: unknown;
  try {
    json = JSON.parse(content);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `JSON parse error: ${message}` };
  }

  const parsed = schema.safeParse(json);
  if (parsed.success) {
    return { ok: true, data: parsed.data };
  }

  return {
    ok: false,
    error: parsed.error.message,
    fixSuggestion: generateFixSuggestion(parsed.error),
  };
}

export {
  SprintStatusSchema,
  PendingRiskSchema,
  VerificationCommandSchema,
  ActualLocSchema,
  SprintEntrySchema,
  HandoffBlockSchema,
  SandboxNoteSchema,
} from './sprint-status.js';
export { ProjectMapSchema, ProjectMapModuleSchema, ActivePlatformRuleSchema } from './project-map.js';
export { SprintApiContractsSchema, SprintApiContractSchema } from './sprint-api-contracts.js';
export { IterationHistorySchema, IterationEntrySchema } from './iteration-history.js';
export { ModelRegistrySchema, ModelEntrySchema, ProviderRegistryEntrySchema } from './model-registry.js';
