import { defineConfig, devices } from '@playwright/test';

/**
 * Browser acceptance tests. global-setup boots the mock external services and
 * the real API (ports below); the web app runs on Vite and proxies /api to it.
 */
export const PORTS = { api: 4100, mocks: 4110, web: 5180 };

export default defineConfig({
  testDir: './ui',
  timeout: 8 * 60_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  globalSetup: './ui/global-setup.ts',
  use: {
    baseURL: `http://localhost:${PORTS.web}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    ...(process.env.PLAYWRIGHT_CHROMIUM_PATH && { launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH } }),
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 960 } } }],
  webServer: {
    command: `pnpm --dir ../apps/web exec vite --port ${PORTS.web} --strictPort`,
    url: `http://localhost:${PORTS.web}`,
    reuseExistingServer: !process.env.CI,
    env: { VITE_DEV_API_PROXY: `http://127.0.0.1:${PORTS.api}` },
    timeout: 120_000,
  },
});
