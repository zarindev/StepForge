import * as repo from '@stepforge/db/repos';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.ts';

type P<T extends string> = { Params: Record<T, string> };
const StepsBody = z.object({ steps: z.array(z.record(z.string(), z.unknown())) });
const TagsBody = z.object({ tagIds: z.array(z.string()) });

/** Modules, scenarios, steps, test cases, version history and the Test Explorer tree. */
export function registerTestRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db } = ctx;
  const changed = (applicationId: string) => ctx.bus.publish({ type: 'tree.changed', applicationId });

  app.get<P<'id'>>('/api/applications/:id/tree', async (req) => repo.getTree(db, req.params.id));

  // ─── Modules ─────────────────────────────────────────────────────────────
  app.post<P<'id'>>('/api/applications/:id/modules', async (req, reply) => {
    const m = repo.createModule(db, req.params.id, req.body as never);
    changed(m.applicationId);
    return reply.code(201).send(m);
  });
  app.patch<P<'id'>>('/api/modules/:id', async (req) => {
    const m = repo.updateModule(db, req.params.id, req.body as never);
    changed(m.applicationId);
    return m;
  });
  app.delete<P<'id'>>('/api/modules/:id', async (req, reply) => {
    const m = repo.getModule(db, req.params.id);
    repo.deleteModule(db, m.id);
    changed(m.applicationId);
    return reply.code(204).send();
  });

  // ─── Scenarios ───────────────────────────────────────────────────────────
  app.post<P<'id'>>('/api/modules/:id/scenarios', async (req, reply) => {
    const s = repo.createScenario(db, req.params.id, req.body as never);
    changed(s.applicationId);
    return reply.code(201).send(s);
  });
  app.get<P<'id'>>('/api/scenarios/:id', async (req) => repo.getScenario(db, req.params.id));
  app.patch<P<'id'>>('/api/scenarios/:id', async (req) => {
    const s = repo.updateScenario(db, req.params.id, req.body as never);
    changed(s.applicationId);
    return s;
  });
  app.delete<P<'id'>>('/api/scenarios/:id', async (req, reply) => {
    const appId = repo.applicationIdForScenario(db, req.params.id);
    repo.deleteScenarios(db, [req.params.id]);
    changed(appId);
    return reply.code(204).send();
  });
  app.post<P<'id'>>('/api/scenarios/:id/duplicate', async (req, reply) => {
    const s = repo.duplicateScenario(db, req.params.id);
    changed(s.applicationId);
    return reply.code(201).send(s);
  });
  app.put<P<'id'>>('/api/scenarios/:id/steps', async (req) => {
    const s = repo.saveSteps(db, req.params.id, StepsBody.parse(req.body).steps as never);
    changed(s.applicationId);
    return s;
  });
  app.put<P<'id'>>('/api/scenarios/:id/tags', async (req) => {
    const appId = repo.applicationIdForScenario(db, req.params.id);
    repo.setScenarioTags(db, appId, req.params.id, TagsBody.parse(req.body).tagIds);
    changed(appId);
    return repo.getScenario(db, req.params.id);
  });

  // ─── Versions ────────────────────────────────────────────────────────────
  app.get<P<'id'>>('/api/scenarios/:id/versions', async (req) => repo.listVersions(db, req.params.id));
  app.get<P<'id' | 'v'>>('/api/scenarios/:id/versions/:v', async (req) =>
    repo.getVersion(db, req.params.id, Number(req.params.v)),
  );
  app.post<P<'id' | 'v'>>('/api/scenarios/:id/versions/:v/restore', async (req) => {
    const s = repo.restoreVersion(db, req.params.id, Number(req.params.v));
    changed(s.applicationId);
    return s;
  });

  // ─── Test cases ──────────────────────────────────────────────────────────
  app.post<P<'id'>>('/api/scenarios/:id/test-cases', async (req, reply) => {
    const tc = repo.createTestCase(db, req.params.id, req.body as never);
    changed(repo.applicationIdForScenario(db, req.params.id));
    return reply.code(201).send(tc);
  });
  app.patch<P<'id'>>('/api/test-cases/:id', async (req) => {
    const tc = repo.updateTestCase(db, req.params.id, req.body as never);
    changed(repo.applicationIdForTestCase(db, tc.id));
    return tc;
  });
  app.delete<P<'id'>>('/api/test-cases/:id', async (req, reply) => {
    const appId = repo.applicationIdForTestCase(db, req.params.id);
    repo.deleteTestCase(db, req.params.id);
    changed(appId);
    return reply.code(204).send();
  });
}
