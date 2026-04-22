export interface UsageSummary {
  provider?: string | undefined;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

function asNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function fromObject(value: Record<string, unknown>): UsageSummary {
  const inputTokens =
    asNumber(value.input_tokens) ||
    asNumber(value.inputTokens) ||
    asNumber(value.prompt_tokens) ||
    asNumber(value.promptTokens);

  const outputTokens =
    asNumber(value.output_tokens) ||
    asNumber(value.outputTokens) ||
    asNumber(value.completion_tokens) ||
    asNumber(value.completionTokens) ||
    asNumber(value.candidatesTokenCount);

  const totalTokens =
    asNumber(value.total_tokens) ||
    asNumber(value.totalTokens) ||
    inputTokens + outputTokens;

  return {
    provider: typeof value.provider === 'string' ? value.provider : undefined,
    inputTokens,
    outputTokens,
    totalTokens,
  };
}

function tryParseJsonLine(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }

    return null;
  } catch {
    return null;
  }
}

export function extractUsage(raw: string, provider?: string): UsageSummary {
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (const line of lines) {
    const parsed = tryParseJsonLine(line);
    if (!parsed) {
      continue;
    }

    const direct = fromObject(parsed);
    if (direct.totalTokens > 0) {
      return {
        ...direct,
        provider: direct.provider ?? provider,
      };
    }

    const usage = parsed.usage;
    if (usage && typeof usage === 'object' && !Array.isArray(usage)) {
      const nested = fromObject(usage as Record<string, unknown>);
      if (nested.totalTokens > 0) {
        return {
          ...nested,
          provider: nested.provider ?? provider,
        };
      }
    }
  }

  return {
    provider,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
  };
}

export function sumUsage(items: UsageSummary[]): UsageSummary {
  return items.reduce<UsageSummary>(
    (accumulator, current) => ({
      inputTokens: accumulator.inputTokens + current.inputTokens,
      outputTokens: accumulator.outputTokens + current.outputTokens,
      totalTokens: accumulator.totalTokens + current.totalTokens,
      provider: accumulator.provider ?? current.provider,
    }),
    {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    },
  );
}
