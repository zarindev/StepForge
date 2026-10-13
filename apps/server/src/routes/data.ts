import * as repo from '@stepforge/db/repos';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.ts';

type P<T extends string> = { Params: Record<T, string> };

/** The test data library: data sources that `util.useData` steps read rows from. */
export function registerDataRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db, data } = ctx;
  app.get<P<'id'>>('/api/applications/:id/data-sources', async (req) =>
    repo.listDataSources(db, req.params.id),
  );
  app.post<P<'id'>>('/api/applications/:id/data-sources', async (req, reply) =>
    reply.code(201).send(repo.createDataSource(db, req.params.id, req.body)),
  );
  app.get<P<'id'>>('/api/data-sources/:id', async (req) => repo.getDataSource(db, req.params.id));
  app.put<P<'id'>>('/api/data-sources/:id', async (req) =>
    repo.updateDataSource(db, req.params.id, req.body),
  );
  app.delete<P<'id'>>('/api/data-sources/:id', async (req, reply) => {
    repo.deleteDataSource(db, req.params.id);
    return reply.code(204).send();
  });
  /** The first rows of a source in one environment (CSV, SQL and API sources are read live). */
  app.post<P<'id'>>('/api/data-sources/:id/preview', async (req) => {
    const { environmentId } = z.object({ environmentId: z.string().min(1) }).parse(req.body);
    return data.preview(req.params.id, environmentId);
  });
}
