import fastifyStatic from '@fastify/static';
import { schema } from '@stepforge/db';
import * as repo from '@stepforge/db/repos';
import { and, desc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { AppContext } from '../context.ts';

type P<T extends string> = { Params: Record<T, string> };
export const ARTIFACT_PREFIX = '/api/artifacts/files/';

/** Locates Playwright's bundled Trace Viewer (static assets shipped in playwright-core). */
export function traceViewerDir(): string | null {
  try {
    const require = createRequire(import.meta.url);
    const core = dirname(
      require.resolve('playwright-core/package.json', { paths: [dirname(require.resolve('playwright'))] }),
    );
    const dir = join(core, 'lib', 'vite', 'traceViewer');
    return existsSync(join(dir, 'index.html')) ? dir : null;
  } catch {
    return null;
  }
}

export async function registerRunRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const { db, runs } = ctx;

  app.get<{ Querystring: { applicationId?: string; limit?: string } }>('/api/runs', async (req) => {
    const limit = Math.min(200, Number(req.query.limit ?? 50));
    const rows = db
      .select({
        run: schema.runs,
        applicationName: schema.applications.name,
        applicationColor: schema.applications.color,
        environmentName: schema.environments.name,
      })
      .from(schema.runs)
      .innerJoin(schema.applications, eq(schema.applications.id, schema.runs.applicationId))
      .leftJoin(schema.environments, eq(schema.environments.id, schema.runs.environmentId))
      .where(req.query.applicationId ? eq(schema.runs.applicationId, req.query.applicationId) : undefined)
      .orderBy(desc(schema.runs.createdAt))
      .limit(limit)
      .all();
    return rows.map((r) => ({
      ...r.run,
      applicationName: r.applicationName,
      applicationColor: r.applicationColor,
      environmentName: r.environmentName,
    }));
  });

  app.post('/api/runs', async (req, reply) => reply.code(201).send(runs.create(req.body as never)));

  app.get<P<'id'>>('/api/runs/:id', async (req) => {
    const run = runs.getRun(req.params.id);
    const items = db
      .select()
      .from(schema.runItems)
      .where(eq(schema.runItems.runId, run.id))
      .orderBy(schema.runItems.position)
      .all();
    const env = run.environmentId
      ? db.select().from(schema.environments).where(eq(schema.environments.id, run.environmentId)).get()
      : undefined;
    const application = repo.getApplication(db, run.applicationId);
    return {
      ...run,
      items,
      environment: env
        ? { id: env.id, name: env.name, baseUrl: env.baseUrl, isProduction: env.isProduction }
        : null,
      application: { id: application.id, name: application.name, color: application.color },
    };
  });

  app.get<P<'id'>>('/api/run-items/:id', async (req) => {
    const item = db.select().from(schema.runItems).where(eq(schema.runItems.id, req.params.id)).get();
    if (!item) throw repo.notFound('Run item', req.params.id);
    const steps = db
      .select()
      .from(schema.stepResults)
      .where(eq(schema.stepResults.runItemId, item.id))
      .orderBy(schema.stepResults.position)
      .all();
    const artifacts = db.select().from(schema.artifacts).where(eq(schema.artifacts.runItemId, item.id)).all();
    const bug = db
      .select({
        id: schema.bugs.id,
        code: schema.bugs.code,
        status: schema.bugs.status,
        occurrences: schema.bugs.occurrences,
      })
      .from(schema.bugs)
      .where(eq(schema.bugs.runItemId, item.id))
      .get();
    return { ...item, steps, artifacts, bug: bug ?? null };
  });

  app.post<P<'id'>>('/api/runs/:id/cancel', async (req) => runs.cancel(req.params.id));
  app.post<P<'id'>>('/api/runs/:id/resume', async (req) => runs.resume(req.params.id));
  app.delete<P<'id'>>('/api/runs/:id', async (req, reply) => {
    runs.delete(req.params.id);
    return reply.code(204).send();
  });

  /** Latest result per scenario, for status dots in the Test Explorer. */
  app.get<P<'id'>>('/api/applications/:id/last-results', async (req) => {
    const rows = db
      .select({
        scenarioId: schema.runItems.scenarioId,
        status: schema.runItems.status,
        at: schema.runItems.updatedAt,
      })
      .from(schema.runItems)
      .innerJoin(schema.runs, eq(schema.runs.id, schema.runItems.runId))
      .where(and(eq(schema.runs.applicationId, req.params.id)))
      .orderBy(desc(schema.runItems.updatedAt))
      .limit(2000)
      .all();
    const latest: Record<string, string> = {};
    for (const r of rows)
      if (r.scenarioId && !latest[r.scenarioId] && !['queued', 'running'].includes(r.status))
        latest[r.scenarioId] = r.status;
    return latest;
  });

  // Evidence files (screenshots, videos with range requests, traces, logs). Token required like all /api routes.
  mkdirSync(ctx.config.artifactsDir, { recursive: true });
  await app.register(fastifyStatic, {
    root: ctx.config.artifactsDir,
    prefix: ARTIFACT_PREFIX,
    decorateReply: false,
    index: false,
    acceptRanges: true,
  });

  // Playwright Trace Viewer: public static assets (no user data); the trace itself is fetched with the token.
  const tv = traceViewerDir();
  if (tv) {
    await app.register(fastifyStatic, { root: tv, prefix: '/trace-viewer/', decorateReply: false });
  } else {
    app.log.warn(
      'Playwright Trace Viewer assets not found; traces can still be downloaded and opened with "npx playwright show-trace".',
    );
  }
}
