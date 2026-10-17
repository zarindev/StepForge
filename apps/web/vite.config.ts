import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
/** The server's data folder: STEPFORGE_DATA_DIR from the environment or the repository's .env, else ./data. */
function dataDir(): string {
  let dir = process.env.STEPFORGE_DATA_DIR;
  const envFile = resolve(repoRoot, '.env');
  if (!dir && existsSync(envFile))
    dir = /^\s*STEPFORGE_DATA_DIR\s*=\s*["']?([^"'\r\n]+?)["']?\s*$/m.exec(
      readFileSync(envFile, 'utf8'),
    )?.[1];
  return resolve(repoRoot, dir || 'data');
}
const sessionFile = resolve(dataDir(), '.session.json');
const readSession = (): { port: number; token: string } | null =>
  existsSync(sessionFile) ? JSON.parse(readFileSync(sessionFile, 'utf8')) : null;

/** In dev, inject the running server's session token the same way the server does in production. */
function devSessionToken(): Plugin {
  return {
    name: 'stepforge-dev-session',
    apply: 'serve',
    transformIndexHtml(html) {
      const s = readSession();
      return html.replace(
        '<!--STEPFORGE_SESSION-->',
        s ? `<script>window.__STEPFORGE__=${JSON.stringify({ token: s.token })}</script>` : '',
      );
    },
  };
}

const apiTarget = `http://127.0.0.1:${readSession()?.port ?? 4400}`;

export default defineConfig({
  plugins: [react(), tailwindcss(), devSessionToken()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: { '/api': { target: apiTarget, ws: true, changeOrigin: true } },
  },
  build: { outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 1500 },
});
