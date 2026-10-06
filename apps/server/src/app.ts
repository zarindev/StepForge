import fastifyWebsocket from '@fastify/websocket';
import { loadOrCreateKey } from '@stepforge/crypto';
import { getSetting, openDatabase, schema } from '@stepforge/db';
import { inArray } from 'drizzle-orm';
import Fastify, { type FastifyInstance, LogController } from 'fastify';
import { mkdirSync } from 'node:fs';
import { ZodError } from 'zod';
import { loadConfig, type ServerConfig } from './config.ts';
import { EventBus, type AppContext } from './context.ts';
import { registerApplicationRoutes } from './routes/applications.ts';
import { registerLiveRoutes } from './routes/live.ts';
import { registerStaticRoutes } from './routes/static.ts';
import { registerSystemRoutes } from './routes/system.ts';
import { registerRunRoutes } from './routes/runs.ts';
import { registerTestRoutes } from './routes/tests.ts';
import { RecorderManager } from './recorder/manager.ts';
import { registerRecorderRoutes } from './routes/recorder.ts';
import { RunManager } from './runner/manager.ts';
import { generateSessionToken, registerSecurity } from './security.ts';

export type BuildOptions = {
  config?: Partial<ServerConfig>;
  token?: string;
  logger?: boolean | object;
};

export async function buildApp(opts: BuildOptions = {}): Promise<{ app: FastifyInstance; ctx: AppContext }> {
  const config = loadConfig(opts.config);
  const app = Fastify({
    logger: opts.logger ?? false,
    bodyLimit: 50 * 1024 * 1024,
    // Never log request bodies/headers: they may carry secrets or the session token.
    logController: new LogController({ disableRequestLogging: true }),
  });

  if (config.dbFile !== ':memory:') mkdirSync(config.dataDir, { recursive: true });
  mkdirSync(config.artifactsDir, { recursive: true });
  const { db, sqlite, backupPath, applied } = openDatabase({
    file: config.dbFile,
    backupDir: `${config.dataDir}/backups`,
    log: (m) => app.log.info(m),
  });
  if (applied > 0)
    app.log.info(`Applied ${applied} database migration(s)${backupPath ? ` (backup: ${backupPath})` : ''}`);

  // Runs left queued/running by a crash or restart are marked interrupted (Section 10).
  const interrupted = db
    .update(schema.runs)
    .set({ status: 'interrupted', updatedAt: new Date().toISOString() })
    .where(inArray(schema.runs.status, ['queued', 'running']))
    .run();
  if (interrupted.changes > 0) app.log.warn(`Marked ${interrupted.changes} unfinished run(s) as interrupted`);

  const masterKey = loadOrCreateKey(config.keyFile);
  const bus = new EventBus();
  const ctx: AppContext = {
    config,
    db,
    sqlite,
    masterKey,
    token: opts.token ?? generateSessionToken(),
    bus,
    runs: new RunManager(db, bus, config.artifactsDir, masterKey, () => ({
      timeoutMs: getSetting(db, 'defaultTimeoutMs', 15_000),
    })),
    recorder: new RecorderManager(db, masterKey, bus),
    startedAt: new Date(),
  };

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) {
      return reply
        .code(400)
        .send({ error: 'validation_error', message: 'Invalid request', issues: err.issues });
    }
    const e = err as Error & { statusCode?: number; code?: string };
    const status = e.statusCode ?? 500;
    if (status >= 500) {
      app.log.error(e);
      return reply.code(status).send({ error: 'internal_error', message: 'Internal error' });
    }
    // Name check, not instanceof: workspace symlinks can load the repos module twice.
    const code = e.name === 'RepoError' && e.code ? e.code : 'bad_request';
    return reply.code(status).send({ error: code, message: e.message });
  });

  registerSecurity(app, ctx.token);
  await app.register(fastifyWebsocket);
  registerSystemRoutes(app, ctx);
  registerLiveRoutes(app, ctx);
  registerApplicationRoutes(app, ctx);
  registerTestRoutes(app, ctx);
  await registerRunRoutes(app, ctx);
  registerRecorderRoutes(app, ctx);
  await registerStaticRoutes(app, ctx);

  app.addHook('onClose', async () => {
    await ctx.runs.shutdown();
    ctx.recorder.discard();
    sqlite.close();
  });
  return { app, ctx };
}
