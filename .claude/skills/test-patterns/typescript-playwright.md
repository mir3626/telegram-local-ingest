# TypeScript + Playwright

Use this shard for browser flows where role-based locators and stable assertions matter more than raw DOM selectors.

## Install and config

```bash
npm install -D @playwright/test
npx playwright install
```

```ts
// playwright.config.ts
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  use: {
    baseURL: 'http://127.0.0.1:3000',
    trace: 'on-first-retry',
  },
});
```

## Example

```ts
// e2e/login.spec.ts
import { expect, test } from '@playwright/test';

test('user can sign in', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Email').fill('owner@example.com');
  await page.getByLabel('Password').fill('correct horse battery staple');
  await page.getByRole('button', { name: 'Sign in' }).click();

  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  await expect(page).toHaveURL(/dashboard/);
});
```

## Common pitfalls

- Prefer `getByRole`, `getByLabel`, and `getByTestId` over brittle CSS chains.
- Avoid fixed sleeps. Wait on an assertion or a specific network or UI state.
- Keep one user-facing concern per test. Long multi-step scripts are harder to debug and retry.

## Determinism notes

- Seed or stub backend data before the test starts; do not depend on shared mutable staging state.
- Freeze clocks and network where the page renders time-sensitive output.
- Treat this shard as a pattern reference. Generator-side browser smoke remains out of scope until M7.
