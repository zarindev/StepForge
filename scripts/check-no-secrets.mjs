// Fails if StepForge runtime data or environment files are tracked by git (Section 9).
import { execSync } from 'node:child_process';

const tracked = execSync('git ls-files', { encoding: 'utf8' }).split('\n').filter(Boolean);
const offenders = tracked.filter(
  (f) =>
    (f.startsWith('data/') && f !== 'data/.gitkeep') ||
    (/(^|\/)\.env(\.|$)/.test(f) && !f.endsWith('.env.example')),
);
if (offenders.length > 0) {
  console.error('These files must never be committed (runtime data / secrets):');
  for (const f of offenders) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`OK: ${tracked.length} tracked files, no runtime data or .env files.`);
