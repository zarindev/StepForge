import * as repo from '@stepforge/db/repos';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.ts';

type P<T extends string> = { Params: Record<T, string> };
const StepsBody = z.object({ steps: z.array(z.record(z.string(), z.unknown())) });

/** Recorder sessions and reusable blocks. */
export function registerRecorderRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { recorder, db } = ctx;
  app.get('/api/recorder', async () => recorder.status());
  app.post('/api/recorder/start', async (req, reply) =>
    reply.code(201).send(await recorder.start(req.body as never)),
  );
  app.post('/api/recorder/stop', async () => recorder.stop());
  app.post('/api/recorder/undo', async () => recorder.undo());
  app.post('/api/recorder/discard', async (_req, reply) => {
    recorder.discard();
    return reply.code(204).send();
  });
  app.post('/api/recorder/save', async (req, reply) =>
    reply.code(201).send(recorder.save(req.body as never)),
  );

  app.get<P<'id'>>('/api/applications/:id/blocks', async (req) => repo.listBlocks(db, req.params.id));
  app.post<P<'id'>>('/api/applications/:id/blocks', async (req, reply) =>
    reply.code(201).send(repo.createBlock(db, req.params.id, req.body as never)),
  );
  app.get<P<'id'>>('/api/blocks/:id', async (req) => repo.getBlock(db, req.params.id));
  app.patch<P<'id'>>('/api/blocks/:id', async (req) =>
    repo.updateBlock(db, req.params.id, req.body as never),
  );
  app.put<P<'id'>>('/api/blocks/:id/steps', async (req) =>
    repo.saveBlockSteps(db, req.params.id, StepsBody.parse(req.body).steps as never),
  );
  app.delete<P<'id'>>('/api/blocks/:id', async (req, reply) => {
    repo.deleteBlock(db, req.params.id);
    return reply.code(204).send();
  });
}
