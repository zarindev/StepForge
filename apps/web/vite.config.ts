import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';

const sessionFile = fileURLToPath(new URL('../../data/.session.json', import.meta.url));
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
