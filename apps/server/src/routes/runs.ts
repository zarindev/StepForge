import fastifyStatic from '@fastify/static';
import { schema } from '@stepforge/db';
import * as repo from '@stepforge/db/repos';
import { and, desc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve, sep } from 'node:path';
import { z } from 'zod';
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

  /** The block (and its step) that owns a failed run step, when it is inside a block. */
  const blockFailure = (scenarioId: string, runStepId: string) => {
    try {
      const o = repo.stepOwner(db, scenarioId, runStepId);
      if (o.kind !== 'block') return null;
      const step = repo.getBlock(db, o.id).steps.findIndex((x) => x.id === o.stepId);
      return {
        blockId: o.id,
        blockName: o.name,
        stepId: o.stepId,
        stepNumber: step >= 0 ? step + 1 : null,
        affectedScenarios: o.affectedScenarios ?? 0,
      };
    } catch {
      return null; // the scenario or block changed since the run
    }
  };

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
    // Failures inside blocks, grouped by the block step that failed: one fix there repairs all of them.
    const groups = new Map<string, NonNullable<ReturnType<typeof blockFailure>> & { itemIds: string[] }>();
    for (const it of items) {
      if (!['failed', 'broken'].includes(it.status) || !it.scenarioId || !it.failedStepId?.includes('>'))
        continue;
      const f = blockFailure(it.scenarioId, it.failedStepId);
      if (!f) continue;
      const key = `${f.blockId}|${f.stepId}`;
      const g = groups.get(key) ?? { ...f, itemIds: [] };
      g.itemIds.push(it.id);
      groups.set(key, g);
    }
    return {
      ...run,
      items,
      blockFailures: [...groups.values()].sort((a, b) => b.itemIds.length - a.itemIds.length),
      environment: env
        ? { id: env.id, name: env.name, baseUrl: env.baseUrl, isProduction: env.isProduction }
        : null,
      application: {
        id: application.id,
        name: application.name,
        color: application.color,
        platform: application.platform,
      },
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

  // Manual runs: the checklist of one test, its results, screenshots, and finishing the run.
  app.get<P<'id'>>('/api/run-items/:id/manual', async (req) => ({
    ...ctx.manual.checklist(req.params.id),
    browserOpen: ctx.manualBrowser.isOpen(req.params.id),
    app: ctx.manualBrowser.appOf(req.params.id),
  }));
  // The tester's browser for a manual test (StepForge panel on top, session recorded), and bug reports from a step.
  app.post<P<'id'>>('/api/run-items/:id/manual/browser', async (req) =>
    ctx.manualBrowser.open(req.params.id),
  );
  app.delete<P<'id'>>('/api/run-items/:id/manual/browser', async (req, reply) => {
    await ctx.manualBrowser.close(req.params.id);
    return reply.code(204).send();
  });
  // A phone or desktop app open for a manual test: its screen, what the tester does on it, and the panel's actions
  // (a screenshot from the app, a clip of its screen recording, a result) as in the browser's panel.
  app.get<P<'id'>>('/api/run-items/:id/manual/screen', async (req, reply) => {
    const { png, width, height } = await ctx.manualBrowser.screen(req.params.id);
    return reply
      .header('cache-control', 'no-store')
      .header('x-screen-size', `${width}x${height}`)
      .type('image/png')
      .send(png);
  });
  const ManualPoint = { x: z.number().min(0).max(1), y: z.number().min(0).max(1) };
  const ManualAct = z.discriminatedUnion('action', [
    z.object({
      action: z.literal('tap'),
      ...ManualPoint,
      button: z.enum(['left', 'right']).optional(),
      count: z.number().int().min(1).max(2).optional(),
      holdMs: z.number().int().min(0).max(10_000).optional(),
    }),
    z.object({ action: z.literal('type'), text: z.string().max(5000) }),
    z.object({ action: z.literal('key'), key: z.string().min(1).max(100) }),
    z.object({ action: z.literal('swipe'), direction: z.enum(['up', 'down', 'left', 'right']) }),
    z.object({ action: z.literal('scroll'), direction: z.enum(['up', 'down']) }),
    z.object({ action: z.literal('menu'), path: z.string().min(1).max(500) }),
    z.object({ action: z.literal('back') }),
    z.object({ action: z.literal('hideKeyboard') }),
  ]);
  app.post<P<'id'>>('/api/run-items/:id/manual/act', async (req) => {
    await ctx.manualBrowser.act(req.params.id, ManualAct.parse(req.body));
    return { ok: true };
  });
  app.post<P<'id'>>('/api/run-items/:id/manual/panel', async (req) => {
    const body = z
      .object({
        type: z.enum(['mark', 'screenshot', 'clipStart', 'clipStop', 'go']),
        number: z.string().max(100).default(''),
        status: z.enum(['passed', 'failed', 'blocked', 'skipped']).optional(),
        note: z.string().max(5000).optional(),
      })
      .parse(req.body);
    return ctx.manualBrowser.panel(req.params.id, body);
  });
  app.post<P<'id'>>('/api/run-items/:id/manual/bug', async (req, reply) =>
    reply.code(201).send(ctx.manual.reportBug(req.params.id, req.body)),
  );
  app.put<P<'id'>>('/api/run-items/:id/manual', async (req) => ctx.manual.save(req.params.id, req.body));
  app.post<P<'id'>>(
    '/api/run-items/:id/manual/attachments',
    { bodyLimit: 15 * 1024 * 1024 },
    async (req, reply) => reply.code(201).send(ctx.manual.attach(req.params.id, req.body)),
  );
  app.post<P<'id'>>('/api/runs/:id/manual/finish', async (req) => ctx.manual.finishRun(req.params.id));

  /** Visual checkpoint: the screenshot of this result becomes the approved baseline (the page changed on purpose). */
  app.post<P<'id'>>('/api/step-results/:id/accept-baseline', async (req, reply) => {
    const row = db.select().from(schema.stepResults).where(eq(schema.stepResults.id, req.params.id)).get();
    const visual = (row?.responseJson as { visual?: { baseline: string; actual: string } } | null)?.visual;
    if (!row || !visual)
      return reply.code(404).send({ error: 'not_found', message: 'No visual checkpoint here' });
    const root = resolve(ctx.config.artifactsDir);
    const from = resolve(root, visual.actual);
    const to = resolve(root, visual.baseline);
    // Both paths come from the run, but stay inside the artifacts folder whatever is stored.
    if (!from.startsWith(root + sep) || !to.startsWith(join(root, 'baselines') + sep) || !existsSync(from))
      return reply
        .code(400)
        .send({ error: 'invalid', message: 'The screenshot of this run is no longer available' });
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(from, to);
    db.update(schema.stepResults)
      .set({ responseJson: { ...(row.responseJson as object), visual: { ...visual, accepted: true } } })
      .where(eq(schema.stepResults.id, row.id))
      .run();
    return { ok: true, baseline: visual.baseline };
  });

  // The run queue: what runs now and what waits, in order; a waiting run's priority can change.
  app.get('/api/runs/queue', async () => runs.queueState());
  app.post<P<'id'>>('/api/runs/:id/priority', async (req) => {
    const { priority } = z.object({ priority: z.enum(['high', 'normal', 'low', 'next']) }).parse(req.body);
    return runs.setPriority(req.params.id, priority);
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
