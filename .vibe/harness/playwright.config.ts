import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './test/playwright',
  fullyParallel: false,
  reporter: process.env.CI ? 'dot' : 'list',
  timeout: 30_000,
  expect: {
    timeout: 5_000,
  },
  use: {
    ...devices['Desktop Chrome'],
    headless: true,
    trace: 'retain-on-failure',
  },
  workers: 1,
});
