import type { ProviderRunner } from '../lib/config.js';

export interface ProviderExecutionInput {
  provider: string;
  role: string;
  prompt: string;
  promptFile?: string | undefined;
  cwd: string;
  taskId: string;
  runner: ProviderRunner;
}

export interface ProviderExecutionPlan {
  command: string;
  args: string[];
  env: Record<string, string>;
}
