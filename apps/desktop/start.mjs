// Starts the desktop app. Terminals inside editors built on Electron (VS Code, for one) can set ELECTRON_RUN_AS_NODE,
// which would make Electron run as plain Node.js: it is removed here.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const electron = createRequire(import.meta.url)('electron');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electron, [dirname(fileURLToPath(import.meta.url)), ...process.argv.slice(2)], {
  env,
  stdio: 'inherit',
});
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
