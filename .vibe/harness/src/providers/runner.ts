import type { ProviderExecutionInput, ProviderExecutionPlan } from './types.js';

function replaceTemplate(template: string, input: ProviderExecutionInput): string {
  return template
    .replaceAll('{prompt}', input.prompt)
    .replaceAll('{promptFile}', input.promptFile ?? '')
    .replaceAll('{cwd}', input.cwd)
    .replaceAll('{role}', input.role)
    .replaceAll('{taskId}', input.taskId);
}

export function buildExecutionPlan(input: ProviderExecutionInput): ProviderExecutionPlan {
  return {
    command: input.runner.command,
    args: input.runner.args.map((value) => replaceTemplate(value, input)).filter(Boolean),
    env: Object.fromEntries(
      Object.entries(input.runner.env ?? {}).map(([key, value]) => [
        key,
        replaceTemplate(value, input),
      ]),
    ),
  };
}
