import {
  appAnalytics,
  applicationGates,
  compareRuns,
  DEFAULT_GATE,
  deleteGate,
  GateInput,
  homeSummary,
  listGates,
  saveGate,
} from '@stepforge/analytics';
import { schema } from '@stepforge/db';
import * as repo from '@stepforge/db/repos';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.ts';

type P<T extends string> = { Params: Record<T, string> };

export function registerAnalyticsRoutes(app: FastifyInstance, ctx: AppContext) {
  const { db } = ctx;

  app.get('/api/analytics/home', async () => homeSummary(db));

  app.get<P<'id'> & { Querystring: { days?: string; environmentId?: string } }>(
    '/api/applications/:id/analytics',
    async (req) => {
      repo.getApplication(db, req.params.id);
      return appAnalytics(db, req.params.id, {
        days: req.query.days ? Number(req.query.days) : undefined,
        environmentId: req.query.environmentId || undefined,
      });
    },
  );

  // ─── Quality gates ─────────────────────────────────────────────────────
  app.get<P<'id'>>('/api/applications/:id/quality-gates', async (req) => {
    repo.getApplication(db, req.params.id);
    return { ...applicationGates(db, req.params.id), definitions: listGates(db, req.params.id) };
  });
  app.post<P<'id'>>('/api/applications/:id/quality-gates', async (req, reply) => {
    repo.getApplication(db, req.params.id);
    const body = (req.body ?? {}) as { preset?: string };
    const input = body.preset === 'default' ? DEFAULT_GATE : GateInput.parse(req.body);
    const id = saveGate(db, req.params.id, input);
    return reply.code(201).send({ id });
  });
  app.put<P<'id'>>('/api/quality-gates/:id', async (req) => {
    const gate = db.select().from(schema.qualityGates).where(eq(schema.qualityGates.id, req.params.id)).get();
    if (!gate) throw repo.notFound('Quality gate', req.params.id);
    saveGate(db, gate.applicationId, GateInput.parse(req.body), gate.id);
    return { id: gate.id };
  });
  app.delete<P<'id'>>('/api/quality-gates/:id', async (req, reply) => {
    deleteGate(db, req.params.id);
    return reply.code(204).send();
  });

  // ─── Run comparison ────────────────────────────────────────────────────
  app.get<{ Querystring: { base?: string; head?: string } }>('/api/runs/compare', async (req) => {
    const q = z.object({ base: z.string().min(1), head: z.string().min(1) }).parse(req.query);
    try {
      return compareRuns(db, q.base, q.head);
    } catch (err) {
      throw new repo.RepoError(404, 'not_found', (err as Error).message);
    }
  });
}
