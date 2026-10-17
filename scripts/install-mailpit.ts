/**
 * Downloads the pinned Mailpit release into <data>/bin (run by setup; also available from Settings → Email).
 * Usage: npm run mailpit:install            (skips if already installed)
 *        npm run mailpit:install -- --force
 */
import { installMailpit, mailpitBinary, MAILPIT_VERSION } from '@stepforge/email';
import { existsSync } from 'node:fs';
import { loadConfig } from '../apps/server/src/config.js';

// Same folders as the server: .env, STEPFORGE_DATA_DIR and STEPFORGE_BIN_DIR all count.
const { binDir } = loadConfig();

if (existsSync(mailpitBinary(binDir)) && !process.argv.includes('--force')) {
  console.log(`Mailpit is already installed at ${mailpitBinary(binDir)} (pinned ${MAILPIT_VERSION}).`);
} else {
  try {
    await installMailpit(binDir, (m) => console.log(`    ${m}`));
  } catch (err) {
    console.error(`Could not install Mailpit: ${(err as Error).message}`);
    console.error('Email steps can still use IMAP inboxes; retry later from Settings → Email.');
    process.exitCode = 1;
  }
}
