import { DbConnectionInput, DbConnectionUpdate } from '@stepforge/core';
import * as repo from '@stepforge/db/repos';
import { AUDIT_CHECKS } from '@stepforge/executor-db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.ts';

type P<T extends string> = { Params: Record<T, string> };

const TestInput = DbConnectionInput.extend({ connectionId: z.string().optional() });
const QueryInput = z.object({
  sql: z.string().min(1).max(1_000_000),
  params: z.array(z.unknown()).max(1000).optional(),
  maxRows: z.number().int().min(1).max(10_000).optional(),
  /** The application name, typed to confirm a write on a production environment. */
  confirm: z.string().max(200).optional(),
});
const AuditInput = z.object({
  tables: z.array(z.string()).optional(),
  checks: z.array(z.enum(AUDIT_CHECKS)).optional(),
  duplicateColumns: z.record(z.string(), z.array(z.array(z.string()).min(1))).optional(),
  requiredColumns: z.record(z.string(), z.array(z.string())).optional(),
  inferRelationships: z.boolean().optional(),
});

export function registerDatabaseRoutes(app: FastifyInstance, ctx: AppContext) {
  const svc = ctx.database;

  app.get<P<'id'>>('/api/applications/:id/connections', async (req) => {
    repo.getApplication(ctx.db, req.params.id);
    return repo.listConnections(ctx.db, req.params.id);
  });

  app.post<P<'id'>>('/api/environments/:id/connections', async (req, reply) =>
    reply.code(201).send(svc.create(req.params.id, DbConnectionInput.parse(req.body))),
  );

  app.post<P<'id'>>('/api/environments/:id/connections/test', async (req) => {
    const { connectionId, ...input } = TestInput.parse(req.body);
    if (connectionId && repo.getConnection(ctx.db, connectionId).environmentId !== req.params.id)
      throw new repo.RepoError(400, 'invalid', 'Connection belongs to another environment');
    return svc.test(svc.draftConfig(req.params.id, input, connectionId));
  });

  app.get<P<'id'>>('/api/connections/:id', async (req) => repo.getConnection(ctx.db, req.params.id));

  app.patch<P<'id'>>('/api/connections/:id', async (req) =>
    svc.update(req.params.id, DbConnectionUpdate.parse(req.body)),
  );

  app.delete<P<'id'>>('/api/connections/:id', async (req, reply) => {
    svc.delete(req.params.id);
    return reply.code(204).send();
  });

  app.post<P<'id'>>('/api/connections/:id/test', async (req) =>
    svc.test({ ...svc.config(req.params.id), readOnly: true }),
  );

  app.get<P<'id'> & { Querystring: { refresh?: string } }>('/api/connections/:id/schema', async (req) =>
    svc.schema(req.params.id, req.query.refresh === '1' || req.query.refresh === 'true'),
  );

  app.post<P<'id'>>('/api/connections/:id/query', async (req) =>
    svc.query(req.params.id, QueryInput.parse(req.body)),
  );

  app.post<P<'id'>>('/api/connections/:id/audit', async (req) =>
    svc.audit(req.params.id, AuditInput.parse(req.body ?? {})),
  );
}
