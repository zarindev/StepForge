/**
 * Optional: downloads the pinned k6 release into <data>/bin so load tests can also run with k6.
 * Usage: npm run k6:install
 */
import { findK6, installK6, K6_VERSION } from '@stepforge/perf';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const raw = process.env.STEPFORGE_DATA_DIR ?? './data';
const binDir = join(isAbsolute(raw) ? raw : resolve(root, raw), 'bin');

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
