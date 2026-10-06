import { defineConfig, devices } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = 4410;
const dataDir = process.env.STEPFORGE_E2E_DATA ?? mkdtempSync(join(tmpdir(), 'stepforge-e2e-'));
process.env.STEPFORGE_E2E_DATA = dataDir;

/** E2E tests for the StepForge dashboard itself, against a throwaway data folder. */
export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    viewport: { width: 1440, height: 900 },
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
  ],
  webServer: {
    command: 'npm start',
    url: `http://127.0.0.1:${PORT}/api/health`,
    reuseExistingServer: false,
    timeout: 60_000,
    env: {
      STEPFORGE_PORT: String(PORT),
      STEPFORGE_DATA_DIR: dataDir,
      STEPFORGE_OPEN_BROWSER: '0',
      STEPFORGE_LOG_LEVEL: 'warn',
    },
  },
});
