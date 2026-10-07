import { writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { buildApp } from './app.ts';
import { openBrowser } from './open-browser.ts';

const MAX_PORT_ATTEMPTS = 10;

async function main(): Promise<void> {
  const { app, ctx } = await buildApp({
    logger: {
      level: process.env.STEPFORGE_LOG_LEVEL ?? 'info',
      transport: process.stdout.isTTY
        ? { target: 'pino-pretty', options: { ignore: 'pid,hostname' } }
        : undefined,
    },
  });

  let port = ctx.config.port;
  for (let attempt = 0; ; attempt++) {
    try {
      // Hard-coded loopback bind: StepForge must never be reachable from the network.
      await app.listen({ host: '127.0.0.1', port });
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE' && attempt < MAX_PORT_ATTEMPTS) {
        app.log.warn(`Port ${port} is in use, trying ${port + 1}`);
        port += 1;
        continue;
      }
      throw err;
    }
  }

  // The Vite dev server reads this file to inject the token during development.
  const sessionFile = join(ctx.config.dataDir, '.session.json');
  writeFileSync(sessionFile, JSON.stringify({ port, token: ctx.token }), { mode: 0o600 });

  const url = `http://127.0.0.1:${port}`;
  app.log.info(`StepForge is running at ${url}`);
  // `npm start -- --demo` (or STEPFORGE_DEMO=1): load the demo workspace — sample data only when asked for.
  if (process.argv.includes('--demo') || process.env.STEPFORGE_DEMO === '1') {
    ctx.demo
      .load()
      .then((r) =>
        app.log.info(
          `Demo workspace ${r.created ? 'loaded' : 'already loaded'}; CareClinic at ${r.clinicUrl}${r.warnings.length ? ` (${r.warnings.join(' ')})` : ''}`,
        ),
      )
      .catch((err: Error) => app.log.error(`Demo workspace failed: ${err.message}`));
  }
  if (ctx.config.openBrowser && !process.env.STEPFORGE_DEV) openBrowser(url);

  let closing = false;
  const shutdown = async (signal: string) => {
    if (closing) return;
    closing = true;
    app.log.info(`${signal} received, shutting down`);
    rmSync(sessionFile, { force: true });
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('StepForge failed to start:', err);
  process.exit(1);
});
