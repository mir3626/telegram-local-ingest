# TypeScript + Vitest

Use this shard for Node-first TypeScript modules that need fast deterministic unit tests.

## Install and config

```bash
npm install -D vitest
```

```ts
// vitest.config.ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    restoreMocks: true,
    clearMocks: true,
  },
});
```

## Example

```ts
// src/token.ts
export function issueToken(now = Date.now()): string {
  return `token-${now}`;
}
```

```ts
// test/token.test.ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { issueToken } from '../src/token';

describe('issueToken', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('uses the mocked clock', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));

    expect(issueToken()).toBe('token-1767225600000');
  });

  it('accepts an explicit timestamp for pure tests', () => {
    expect(issueToken(123)).toBe('token-123');
  });
});
```

## Common pitfalls

- Prefer explicit inputs over global clock reads when the production API allows it.
- Reset fake timers in `afterEach`; leaking them into later tests causes non-local failures.
- Snapshot only stable data. Do not snapshot timestamps, random IDs, or locale-dependent formatting.

## Determinism notes

- Freeze time with `vi.useFakeTimers()` and `vi.setSystemTime()` before code under test runs.
- Keep mocks local to the spec file unless a shared helper removes duplication without hiding setup.
- If a snapshot is necessary, serialize sorted objects and strip volatile fields first.
