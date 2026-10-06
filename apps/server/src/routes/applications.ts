import { BulkScenarioAction } from '@stepforge/core';
import * as repo from '@stepforge/db/repos';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.ts';

type P<T extends string> = { Params: Record<T, string> };
const Confirm = z.object({ confirm: z.string().optional() }).default({});

/** Applications, environments, secrets and tags. */
export function registerApplicationRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db } = ctx;
  const changed = (applicationId: string) => ctx.bus.publish({ type: 'tree.changed', applicationId });

  // ─── Applications ────────────────────────────────────────────────────────
  app.get<{ Querystring: { archived?: string } }>('/api/applications', async (req) =>
    repo.listApplications(db, { includeArchived: req.query.archived === '1' }),
  );
  app.post('/api/applications', async (req, reply) => {
    const created = repo.createApplication(db, req.body as never);
    return reply.code(201).send(created);
  });
  app.get<P<'id'>>('/api/applications/:id', async (req) => repo.getApplication(db, req.params.id));
  app.patch<P<'id'>>('/api/applications/:id', async (req) =>
    repo.updateApplication(db, req.params.id, req.body as never),
  );
  app.delete<P<'id'>>('/api/applications/:id', async (req, reply) => {
    const target = repo.getApplication(db, req.params.id);
    // Safety (Section 12): deleting an application requires typing its name.
    if (Confirm.parse(req.body ?? {}).confirm !== target.name) {
      return reply
        .code(400)
        .send({ error: 'confirmation_required', message: `Type "${target.name}" to confirm deletion` });
    }
    repo.deleteApplication(db, target.id);
    return reply.code(204).send();
  });

  // ─── Environments ────────────────────────────────────────────────────────
  app.get<P<'id'>>('/api/applications/:id/environments', async (req) =>
    repo.listEnvironments(db, req.params.id),
  );
  app.post<P<'id'>>('/api/applications/:id/environments', async (req, reply) =>
    reply.code(201).send(repo.createEnvironment(db, req.params.id, req.body as never)),
  );
  app.patch<P<'id'>>('/api/environments/:id', async (req) =>
    repo.updateEnvironment(db, req.params.id, req.body as never),
  );
  app.delete<P<'id'>>('/api/environments/:id', async (req, reply) => {
    const env = repo.getEnvironment(db, req.params.id);
    if (env.isProduction) {
      const appName = repo.getApplication(db, env.applicationId).name;
      if (Confirm.parse(req.body ?? {}).confirm !== appName) {
        return reply
          .code(400)
          .send({
            error: 'confirmation_required',
            message: `Production environment: type "${appName}" to confirm`,
          });
      }
    }
    repo.deleteEnvironment(db, env.id);
    return reply.code(204).send();
  });

  // ─── Secrets (write-only from the UI's point of view) ───────────────────
  app.get<P<'id'>>('/api/environments/:id/secrets', async (req) => repo.listSecrets(db, req.params.id));
  app.put<P<'id'>>('/api/environments/:id/secrets', async (req) =>
    repo.setSecret(db, ctx.masterKey, req.params.id, req.body as never),
  );
  app.delete<P<'id'>>('/api/secrets/:id', async (req, reply) => {
    repo.deleteSecret(db, req.params.id);
    return reply.code(204).send();
  });

  // ─── Tags ────────────────────────────────────────────────────────────────
  app.get<P<'id'>>('/api/applications/:id/tags', async (req) => repo.listTags(db, req.params.id));
  app.post<P<'id'>>('/api/applications/:id/tags', async (req, reply) => {
    const tag = repo.createTag(db, req.params.id, req.body as never);
    changed(req.params.id);
    return reply.code(201).send(tag);
  });
  app.patch<P<'id'>>('/api/tags/:id', async (req) => {
    const tag = repo.updateTag(db, req.params.id, req.body as never);
    changed(tag.applicationId);
    return tag;
  });
  app.delete<P<'id'>>('/api/tags/:id', async (req, reply) => {
    const tag = repo.getTag(db, req.params.id);
    repo.deleteTag(db, tag.id);
    changed(tag.applicationId);
    return reply.code(204).send();
  });

  // ─── Search (command palette) ───────────────────────────────────────────
  app.get<{ Querystring: { q?: string } }>('/api/search', async (req) => {
    const q = (req.query.q ?? '').trim();
    return q.length < 2 ? [] : repo.search(db, q);
  });

  // ─── Bulk scenario actions (Test Explorer multi-select) ─────────────────
  app.post<P<'id'>>('/api/applications/:id/scenarios/bulk', async (req) => {
    const appId = req.params.id;
    const action = BulkScenarioAction.parse(req.body);
    for (const id of action.ids) {
      if (repo.applicationIdForScenario(db, id) !== appId) {
        throw new repo.RepoError(400, 'invalid', 'All scenarios must belong to this application');
      }
    }
    let affected = action.ids.length;
    db.transaction(() => {
      switch (action.action) {
        case 'delete':
          repo.deleteScenarios(db, action.ids);
          break;
        case 'duplicate':
          for (const id of action.ids) repo.duplicateScenario(db, id);
          break;
        case 'move':
          repo.moveScenarios(db, action.ids, action.moduleId);
          break;
        case 'setStatus':
          for (const id of action.ids) repo.updateScenario(db, id, { status: action.status });
          break;
        case 'addTag':
        case 'removeTag': {
          affected = 0;
          for (const id of action.ids) {
            const current = repo.getScenario(db, id).tagIds;
            const next =
              action.action === 'addTag'
                ? [...new Set([...current, action.tagId])]
                : current.filter((t) => t !== action.tagId);
            if (next.length !== current.length) affected++;
            repo.setScenarioTags(db, appId, id, next);
          }
          break;
        }
      }
    });
    changed(appId);
    return { action: action.action, affected };
  });
}
