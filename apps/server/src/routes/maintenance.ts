import * as repo from '@stepforge/db/repos';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.ts';

/** Demo workspace, retention, key rotation and the danger zone (Settings and onboarding). */
export function registerMaintenanceRoutes(app: FastifyInstance, ctx: AppContext) {
  const { demo, maintenance } = ctx;
  app.get('/api/demo', async () => demo.status());
  app.post('/api/demo/load', async () => demo.load());
  app.post('/api/demo/start', async () => ({ url: await demo.startClinic() }));

  app.post('/api/maintenance/prune', async () => maintenance.prune());
  app.post('/api/maintenance/rotate-key', async () => maintenance.rotateKey());

  // Typed confirmation is enforced here too, not only in the UI.
  const confirm = (body: unknown, word: string) => {
    const { confirm: typed } = z.object({ confirm: z.string() }).parse(body ?? {});
    if (typed !== word) throw new repo.RepoError(400, 'confirmation_required', `Type "${word}" to confirm`);
  };
  app.post('/api/maintenance/delete-history', async (req) => {
    confirm(req.body, 'DELETE');
    return maintenance.deleteRunHistory();
  });
  app.post('/api/maintenance/delete-everything', async (req) => {
    confirm(req.body, 'DELETE EVERYTHING');
    demo.stop();
    return maintenance.deleteEverything();
  });
}
