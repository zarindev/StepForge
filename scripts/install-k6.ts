/**
 * Optional: downloads the pinned k6 release into <data>/bin so load tests can also run with k6.
 * Usage: npm run k6:install
 */
import { findK6, installK6, K6_VERSION } from '@stepforge/perf';
import { loadConfig } from '../apps/server/src/config.js';

// Same folders as the server: .env, STEPFORGE_DATA_DIR and STEPFORGE_BIN_DIR all count.
const { binDir } = loadConfig();

const existing = findK6({ binDir });
if (existing && !process.argv.includes('--force')) {
  console.log(`k6 is already available at ${existing}.`);
} else {
  try {
    console.log(`Installed k6 ${K6_VERSION} at ${await installK6(binDir)}`);
  } catch (err) {
    console.error(`Could not install k6: ${(err as Error).message}`);
    process.exitCode = 1;
  }
}
