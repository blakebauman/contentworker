import { defineConfig, devices } from '@playwright/test';

const ADMIN_PORT = 5180;
const API_PORT = 8799;

/**
 * E2E harness: boots the API on an in-memory store (no infra) and the admin via
 * `vite preview`, which proxies the API surfaces same-origin (see vite.config.ts).
 * The space is seeded with two locales so the localization tabs are exercised.
 */
export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/global-setup.ts',
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: `http://localhost:${ADMIN_PORT}`,
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'pnpm --filter @cw/api start',
      port: API_PORT,
      reuseExistingServer: !process.env.CI,
      env: { PORT: String(API_PORT), SEED_LOCALES: 'en-US,de-DE' },
    },
    {
      command: 'pnpm dev',
      port: ADMIN_PORT,
      reuseExistingServer: !process.env.CI,
      env: {
        CW_API_URL: `http://localhost:${API_PORT}`,
        CW_ADMIN_PORT: String(ADMIN_PORT),
      },
    },
  ],
});
