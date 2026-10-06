// Development mode: API server with auto-restart + Vite dev server with HMR (http://127.0.0.1:5173).
import { spawn } from 'node:child_process';

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const env = { ...process.env, STEPFORGE_DEV: '1' };
const procs = [
  spawn(npm, ['run', 'dev', '-w', '@stepforge/server'], {
    stdio: 'inherit',
    env,
    shell: process.platform === 'win32',
  }),
  // Give the server a moment to write data/.session.json so Vite can pick up the token and port.
  new Promise((r) => setTimeout(r, 2500)).then(() =>
    spawn(npm, ['run', 'dev', '-w', '@stepforge/web'], {
      stdio: 'inherit',
      env,
      shell: process.platform === 'win32',
    }),
  ),
];

const stop = async () => {
  for (const p of await Promise.all(procs)) p.kill();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
