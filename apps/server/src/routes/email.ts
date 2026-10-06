import { InboxInput, InboxUpdate } from '@stepforge/core';
import { getSetting, setSetting } from '@stepforge/db';
import * as repo from '@stepforge/db/repos';
import type { MailpitMailbox, Mailbox } from '@stepforge/email';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.ts';
import { emailHttpError } from '../email/service.ts';

type P<T extends string> = { Params: Record<T, string> };

const TestInput = InboxInput.extend({ inboxId: z.string().optional() });

async function withBox<T>(box: Mailbox, fn: (b: Mailbox) => Promise<T>): Promise<T> {
  try {
    return await fn(box);
  } catch (err) {
    throw emailHttpError(err);
  } finally {
    await box.close().catch(() => undefined);
  }
}

export function registerEmailRoutes(app: FastifyInstance, ctx: AppContext) {
  const svc = ctx.email;

  // ─── Local Mailpit (Settings → Email) ──────────────────────────────────
  app.get('/api/email/mailpit', async () => ({
    ...(await svc.mailpit.status()),
    autostart: getSetting(ctx.db, 'mailpitAutostart', false),
  }));
  app.post('/api/email/mailpit/install', async () => {
    try {
      await svc.install();
    } catch (err) {
      throw new repo.RepoError(502, 'install_failed', (err as Error).message);
    }
    return svc.mailpit.status();
  });
  app.post('/api/email/mailpit/start', async () => {
    try {
      return await svc.mailpit.start();
    } catch (err) {
      throw new repo.RepoError(409, 'mailpit_failed', (err as Error).message);
    }
  });
  app.post('/api/email/mailpit/stop', async () => svc.mailpit.stop());
  app.put('/api/email/mailpit/autostart', async (req) => {
    const { enabled } = z.object({ enabled: z.boolean() }).parse(req.body);
    setSetting(ctx.db, 'mailpitAutostart', enabled);
    return { autostart: enabled };
  });

  // ─── Inboxes per application ───────────────────────────────────────────
  app.get<P<'id'>>('/api/applications/:id/inboxes', async (req) => {
    repo.getApplication(ctx.db, req.params.id);
    return repo.listInboxes(ctx.db, req.params.id);
  });
  app.post<P<'id'>>('/api/applications/:id/inboxes', async (req, reply) =>
    reply.code(201).send(repo.createInbox(ctx.db, ctx.masterKey, req.params.id, InboxInput.parse(req.body))),
  );
  app.post<P<'id'>>('/api/applications/:id/inboxes/test', async (req) => {
    const { inboxId, ...input } = TestInput.parse(req.body);
    if (inboxId && repo.getInbox(ctx.db, inboxId).applicationId !== req.params.id)
      throw new repo.RepoError(400, 'invalid', 'Inbox belongs to another application');
    return svc.test(() => svc.draftMailbox(input, inboxId));
  });
  app.patch<P<'id'>>('/api/inboxes/:id', async (req) =>
    repo.updateInbox(ctx.db, ctx.masterKey, req.params.id, InboxUpdate.parse(req.body)),
  );
  app.delete<P<'id'>>('/api/inboxes/:id', async (req, reply) => {
    repo.deleteInbox(ctx.db, req.params.id);
    return reply.code(204).send();
  });
  app.post<P<'id'>>('/api/inboxes/:id/test', async (req) => svc.test(() => svc.mailbox(req.params.id)));

  // ─── Inbox viewer (":id" = an inbox id, or "local" for StepForge's Mailpit) ─────
  app.get<P<'id'> & { Querystring: { limit?: string; to?: string } }>(
    '/api/inboxes/:id/messages',
    async (req) => {
      const limit = Math.min(Math.max(Number(req.query.limit ?? 50) || 50, 1), 200);
      return withBox(svc.mailbox(req.params.id), (b) => b.list({ to: req.query.to || undefined }, limit));
    },
  );
  app.get<P<'id' | 'msg'>>('/api/inboxes/:id/messages/:msg', async (req) =>
    withBox(svc.mailbox(req.params.id), (b) => b.get(req.params.msg)),
  );
  app.delete<P<'id'>>('/api/inboxes/:id/messages', async (req, reply) => {
    const box = svc.mailbox(req.params.id);
    if (box.kind !== 'mailpit')
      throw new repo.RepoError(400, 'unsupported', 'Only Mailpit inboxes can be cleared from StepForge');
    await withBox(box, async () => (box as MailpitMailbox).clear());
    return reply.code(204).send();
  });
}
