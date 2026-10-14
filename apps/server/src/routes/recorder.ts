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

  // Phone apps: the screen as a picture, and what the tester does on it (points are fractions of the screen, 0–1).
  app.get('/api/recorder/screen', async (_req, reply) => {
    const { png, width, height } = await recorder.native().screen();
    return reply
      .header('cache-control', 'no-store')
      .header('x-screen-size', `${width}x${height}`)
      .type('image/png')
      .send(png);
  });
  const Point = { x: z.number().min(0).max(1), y: z.number().min(0).max(1) };
  const Act = z.discriminatedUnion('action', [
    z.object({ action: z.literal('tap'), ...Point }),
    z.object({ action: z.literal('longPress'), ...Point }),
    z.object({ action: z.literal('check'), ...Point, check: z.enum(['visible', 'text']) }),
    z.object({ action: z.literal('type'), text: z.string().max(5000) }),
    z.object({ action: z.literal('swipe'), direction: z.enum(['up', 'down', 'left', 'right']) }),
    z.object({ action: z.literal('back') }),
    z.object({ action: z.literal('hideKeyboard') }),
  ]);
  app.post('/api/recorder/act', async (req, reply) => {
    const a = Act.parse(req.body);
    const s = recorder.native();
    let result: unknown;
    try {
      if (a.action === 'tap') result = await s.tap(a.x, a.y);
      else if (a.action === 'longPress') await s.longPress(a.x, a.y);
      else if (a.action === 'check') await s.check(a.x, a.y, a.check);
      else if (a.action === 'type') await s.type(a.text);
      else if (a.action === 'swipe') await s.swipe(a.direction);
      else if (a.action === 'back') await s.back();
      else await s.hideKeyboard();
    } catch (err) {
      // A step that could not be done (nothing there, no locator…): explained, the recording goes on.
      if ((err as Error).name === 'StepError')
        return reply.code(422).send({ error: 'not_recorded', message: (err as Error).message });
      throw err;
    }
    return { ok: true, ...(result as object), recording: recorder.status() };
  });
  app.post('/api/recorder/inspect', async (req) => {
    const p = z.object(Point).parse(req.body);
    const hit = await recorder.native().inspect(p.x, p.y);
    return hit ? { describe: hit.describe, locators: hit.locators } : null;
  });

  app.get<P<'id'>>('/api/applications/:id/blocks', async (req) => repo.listBlocks(db, req.params.id));
  app.post<P<'id'>>('/api/applications/:id/blocks', async (req, reply) =>
    reply.code(201).send(repo.createBlock(db, req.params.id, req.body as never)),
  );
  app.get<P<'id'>>('/api/blocks/:id', async (req) => repo.getBlock(db, req.params.id));
  /** Where a block is used — what a change to it affects. */
  app.get<P<'id'>>('/api/blocks/:id/usage', async (req) => repo.blockUsage(db, req.params.id));
  /** Turns consecutive steps of a scenario into a new block (the scenario then uses the block). */
  app.post<P<'id'>>('/api/scenarios/:id/extract-block', async (req, reply) => {
    const body = z
      .object({
        stepIds: z.array(z.string()).min(1),
        name: z.string().min(1).max(120),
        description: z.string().max(2000).optional(),
      })
      .parse(req.body);
    return reply.code(201).send(repo.extractBlock(db, req.params.id, body));
  });
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
