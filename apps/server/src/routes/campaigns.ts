import * as repo from '@stepforge/db/repos';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.ts';

type P<T extends string> = { Params: Record<T, string> };

/** Campaigns: saved test selections run across environments × browsers × screen sizes. */
export function registerCampaignRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db, campaigns } = ctx;
  app.get<P<'id'>>('/api/applications/:id/campaigns', async (req) => repo.listCampaigns(db, req.params.id));
  app.post<P<'id'>>('/api/applications/:id/campaigns', async (req, reply) =>
    reply.code(201).send(repo.saveCampaign(db, req.params.id, req.body)),
  );
  app.get<P<'id'>>('/api/campaigns/:id', async (req) => ({
    ...repo.getCampaign(db, req.params.id),
    matrix: ((c) => repo.campaignMatrix(c, repo.getApplication(db, c.applicationId).platform))(
      repo.getCampaign(db, req.params.id),
    ),
    runs: repo.listCampaignRuns(db, req.params.id),
  }));
  app.put<P<'id'>>('/api/campaigns/:id', async (req) => {
    const c = repo.getCampaign(db, req.params.id);
    return repo.saveCampaign(db, c.applicationId, req.body, c.id);
  });
  app.delete<P<'id'>>('/api/campaigns/:id', async (req, reply) => {
    repo.deleteCampaign(db, req.params.id);
    return reply.code(204).send();
  });
  /** Starts the campaign: one run per environment × browser × screen size. */
  app.post<P<'id'>>('/api/campaigns/:id/run', async (req, reply) =>
    reply.code(202).send(campaigns.launch(req.params.id)),
  );
  app.get<P<'id'>>('/api/campaign-runs/:id', async (req) => campaigns.detail(req.params.id));
  app.post<P<'id'>>('/api/campaign-runs/:id/rerun-failed', async (req, reply) =>
    reply.code(202).send(campaigns.rerunFailed(req.params.id)),
  );
  app.post<P<'id'>>('/api/campaign-runs/:id/cancel', async (req) => campaigns.cancel(req.params.id));
}
