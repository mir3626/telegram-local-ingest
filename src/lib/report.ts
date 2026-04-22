import path from 'node:path';
import { writeText } from './fs.js';
import { paths } from './paths.js';
import { isoDate, isoStamp } from './time.js';
import { slugify } from './slug.js';

export interface ReportInput {
  title: string;
  summary: string;
  changed?: string[] | undefined;
  qa?: string[] | undefined;
  risks?: string[] | undefined;
  context?: string[] | undefined;
  usage?:
    | {
        inputTokens: number;
        outputTokens: number;
        totalTokens: number;
      }
    | undefined;
}

/**
 * Pure renderer for a completion report. Produces deterministic markdown
 * for a given {@link ReportInput} without touching the filesystem, so it
 * can be unit-tested in isolation.
 */
export function renderReport(input: ReportInput): string {
  const lines = [
    `# ${input.title}`,
    '',
    '## Summary',
    input.summary,
    '',
    '## Changed',
    ...(input.changed?.length ? input.changed.map((item) => `- ${item}`) : ['- n/a']),
    '',
    '## QA',
    ...(input.qa?.length ? input.qa.map((item) => `- ${item}`) : ['- n/a']),
    '',
    '## Risks',
    ...(input.risks?.length ? input.risks.map((item) => `- ${item}`) : ['- n/a']),
    '',
    '## Context updates',
    ...(input.context?.length ? input.context.map((item) => `- ${item}`) : ['- none']),
    '',
    '## Usage',
    input.usage
      ? `- input: ${input.usage.inputTokens}, output: ${input.usage.outputTokens}, total: ${input.usage.totalTokens}`
      : '- unavailable',
    '',
  ];
  return `${lines.join('\n')}\n`;
}

export async function writeReport(input: ReportInput): Promise<string> {
  const name = `${isoDate()}-${slugify(input.title || isoStamp())}.md`;
  const target = path.join(paths.reportsDir, name);
  await writeText(target, renderReport(input));
  return target;
}
