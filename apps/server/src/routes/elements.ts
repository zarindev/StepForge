import * as repo from '@stepforge/db/repos';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.ts';

type P<T extends string> = { Params: Record<T, string> };

/** Saved UI elements (the element repository): fix a locator once, every step that uses the element follows. */
export function registerElementRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db } = ctx;
  app.get<P<'id'>>('/api/applications/:id/elements', async (req) => repo.listElements(db, req.params.id));
  app.post<P<'id'>>('/api/applications/:id/elements', async (req, reply) =>
    reply.code(201).send(repo.createElement(db, req.params.id, req.body as never)),
  );
  app.get<P<'id'>>('/api/elements/:id', async (req) => repo.getElement(db, req.params.id));
  app.get<P<'id'>>('/api/elements/:id/usage', async (req) => repo.elementUsage(db, req.params.id));
  app.patch<P<'id'>>('/api/elements/:id', async (req) =>
    repo.updateElement(db, req.params.id, req.body as never),
  );
  app.delete<P<'id'>>('/api/elements/:id', async (req, reply) => {
    repo.deleteElement(db, req.params.id);
    return reply.code(204).send();
  });
}
