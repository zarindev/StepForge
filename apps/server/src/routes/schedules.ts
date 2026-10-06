import * as repo from '@stepforge/db/repos';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.ts';
import { nextRuns } from '../scheduler/service.ts';

type P<T extends string> = { Params: Record<T, string> };

export function registerScheduleRoutes(app: FastifyInstance, ctx: AppContext) {
  const { db, scheduler } = ctx;
  const view = (s: repo.Schedule) => ({
    ...s,
    lastRun: s.lastRunId ? (repo.scheduleRuns(db, s.id, 1)[0] ?? null) : null,
  });

  app.get<{ Querystring: { applicationId?: string } }>('/api/schedules', async (req) =>
    repo.listSchedules(db, req.query.applicationId || undefined).map(view),
  );
  app.get('/api/schedules/upcoming', async () => scheduler.upcoming(5));
  app.get<{ Querystring: { cron?: string; count?: string } }>('/api/schedules/preview', async (req) => {
    const cron = z.string().min(1).parse(req.query.cron);
    return {
      next: nextRuns(cron, Math.min(Number(req.query.count ?? 5) || 5, 20)).map((d) => d.toISOString()),
    };
  });
  app.post<P<'id'>>('/api/applications/:id/schedules', async (req, reply) => {
    repo.getApplication(db, req.params.id);
    return reply.code(201).send(view(scheduler.save(req.params.id, req.body)));
  });
  app.put<P<'id'>>('/api/schedules/:id', async (req) => {
    const s = repo.getSchedule(db, req.params.id);
    return view(scheduler.save(s.applicationId, req.body, s.id));
  });
  app.delete<P<'id'>>('/api/schedules/:id', async (req, reply) => {
    scheduler.delete(req.params.id);
    return reply.code(204).send();
  });
  app.post<P<'id'>>('/api/schedules/:id/run', async (req, reply) =>
    reply.code(202).send(await scheduler.trigger(req.params.id)),
  );
  app.get<P<'id'>>('/api/schedules/:id/runs', async (req) => {
    repo.getSchedule(db, req.params.id);
    return repo
      .scheduleRuns(db, req.params.id)
      .map((r) => ({ ...r, notifications: scheduler.notifications.get(r.id) ?? null }));
  });

  // ─── Notification channels (Settings) ──────────────────────────────────
  app.get('/api/notify-channels', async () => repo.listChannels(db));
  app.post('/api/notify-channels', async (req, reply) =>
    reply.code(201).send(scheduler.saveChannel(req.body)),
  );
  app.put<P<'id'>>('/api/notify-channels/:id', async (req) => {
    repo.getChannel(db, req.params.id);
    return scheduler.saveChannel(req.body, req.params.id);
  });
  app.delete<P<'id'>>('/api/notify-channels/:id', async (req, reply) => {
    repo.deleteChannel(db, req.params.id);
    return reply.code(204).send();
  });
  app.post<P<'id'>>('/api/notify-channels/:id/test', async (req) => scheduler.testChannel(req.params.id));
  /** Re-send a finished run's summary (e.g. after fixing a channel). */
  app.post<P<'id'>>('/api/runs/:id/notify', async (req) => {
    const { channelIds } = z.object({ channelIds: z.array(z.string()).min(1) }).parse(req.body);
    return scheduler.notifyRun(req.params.id, channelIds);
  });
}
