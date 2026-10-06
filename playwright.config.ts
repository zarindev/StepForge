import { defineConfig, devices } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = 4410;
const dataDir = process.env.STEPFORGE_E2E_DATA ?? mkdtempSync(join(tmpdir(), 'stepforge-e2e-'));
process.env.STEPFORGE_E2E_DATA = dataDir;
/** A file (not :memory:) so the SQL Workbench E2E can connect to the demo's database. */
const CLINIC_DB = join(dataDir, 'clinic-e2e.db');

/** E2E tests for the StepForge dashboard itself, against a throwaway data folder. */
export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  retries: process.env.CI ? 1 : 0,
  // Specs share one CareClinic instance (and resetting it logs everyone out), so they run one at a time.
  workers: 1,
  fullyParallel: false,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    viewport: { width: 1440, height: 900 },
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
  ],
  webServer: [
    {
      command: 'npm run start -w @stepforge/demo-clinic',
      url: 'http://127.0.0.1:8191/api/health',
      reuseExistingServer: false,
      timeout: 60_000,
      env: { CLINIC_PORT: '8191', CLINIC_DB },
    },
    {
      command: 'npm start',
      url: `http://127.0.0.1:${PORT}/api/health`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        STEPFORGE_PORT: String(PORT),
        STEPFORGE_DATA_DIR: dataDir,
        STEPFORGE_OPEN_BROWSER: '0',
        STEPFORGE_LOG_LEVEL: 'warn',
        STEPFORGE_RECORDER_HEADLESS: '1',
        STEPFORGE_RECORDER_CDP_PORT: '9333',
      },
    },
  ],
});
