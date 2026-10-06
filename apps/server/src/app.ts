import fastifyWebsocket from '@fastify/websocket';
import { loadOrCreateKey } from '@stepforge/crypto';
import { getSetting, openDatabase, schema } from '@stepforge/db';
import { inArray } from 'drizzle-orm';
import Fastify, { type FastifyInstance, LogController } from 'fastify';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ZodError } from 'zod';
import { loadConfig, type ServerConfig } from './config.ts';
import { EventBus, type AppContext } from './context.ts';
import { registerApplicationRoutes } from './routes/applications.ts';
import { registerLiveRoutes } from './routes/live.ts';
import { registerStaticRoutes } from './routes/static.ts';
import { registerSystemRoutes } from './routes/system.ts';
import { registerRunRoutes } from './routes/runs.ts';
import { registerTestRoutes } from './routes/tests.ts';
import { SpecService } from './api/specs.ts';
import { RecorderManager } from './recorder/manager.ts';
import { registerApiRoutes } from './routes/api.ts';
import { registerRecorderRoutes } from './routes/recorder.ts';
import { registerDatabaseRoutes } from './routes/database.ts';
import { DatabaseService } from './database/service.ts';
import { EmailService } from './email/service.ts';
import { registerEmailRoutes } from './routes/email.ts';
import { PerfService } from './perf/service.ts';
import { DiagnosisService } from './diagnosis/service.ts';
import { registerPerfRoutes } from './routes/perf.ts';
import { registerBugRoutes } from './routes/bugs.ts';
import { closePdfBrowser } from '@stepforge/reports';
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
  const specs = new SpecService(db, join(config.dataDir, 'specs'));
  const bus = new EventBus();
  const database = new DatabaseService(
    db,
    masterKey,
    config.dbFile === ':memory:' ? undefined : config.dbFile,
  );
  const email = new EmailService(db, masterKey, config.dataDir, config.binDir, config.mailpit);
  const diagnosis = new DiagnosisService(db, config.artifactsDir, join(config.dataDir, 'rules'));
  const perf = new PerfService(db, masterKey, bus, config.binDir, config.artifactsDir);
  const ctx: AppContext = {
    config,
    db,
    sqlite,
    masterKey,
    token: opts.token ?? generateSessionToken(),
    bus,
    runs: new RunManager(
      db,
      bus,
      config.artifactsDir,
      masterKey,
      () => ({
        timeoutMs: getSetting(db, 'defaultTimeoutMs', 15_000),
      }),
      specs,
      database,
      email,
      perf,
      diagnosis,
    ),
    recorder: new RecorderManager(db, masterKey, bus),
    specs,
    database,
    email,
    perf,
    diagnosis,
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
  registerApiRoutes(app, ctx);
  registerDatabaseRoutes(app, ctx);
  registerEmailRoutes(app, ctx);
  registerPerfRoutes(app, ctx);
  registerBugRoutes(app, ctx);
  await registerStaticRoutes(app, ctx);

  // Optional: start the local Mailpit with StepForge (Settings → Email). Failures are logged, not fatal.
  if (getSetting(db, 'mailpitAutostart', false))
    email.mailpit.start().catch((err: Error) => app.log.warn(`Mailpit did not start: ${err.message}`));

  app.addHook('onClose', async () => {
    await ctx.runs.shutdown();
    await email.mailpit.stop();
    await closePdfBrowser();
    ctx.recorder.discard();
    sqlite.close();
  });
  return { app, ctx };
}
