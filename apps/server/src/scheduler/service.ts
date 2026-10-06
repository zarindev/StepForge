import { passRate } from '@stepforge/analytics';
import { RunOptionsInput, RunScope } from '@stepforge/core';
import { schema, type StepForgeDb } from '@stepforge/db';
import * as repo from '@stepforge/db/repos';
import { ChannelInput, notify, TEST_SUMMARY, type RunSummary } from '@stepforge/notify';
import { Cron } from 'croner';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { EventBus } from '../context.ts';
import type { RunManager } from '../runner/manager.ts';

export const ScheduleInput = z.object({
  name: z.string().trim().min(1).max(120),
  environmentId: z.string().min(1),
  cron: z.string().trim().min(1).max(120),
  scope: RunScope.default({ type: 'application' }),
  options: RunOptionsInput.partial().default({}),
  enabled: z.boolean().default(true),
  channelIds: z.array(z.string()).max(20).default([]),
});

/** Validates a cron expression (5 fields, or 6 with seconds) and returns its next run times. */
export function nextRuns(cron: string, count = 5, from?: Date): Date[] {
  let job: Cron;
  try {
    job = new Cron(cron, { paused: true });
  } catch (err) {
    throw new repo.RepoError(400, 'invalid_cron', `Invalid schedule "${cron}": ${(err as Error).message}`);
  }
  const out = job.nextRuns(count, from);
  job.stop();
  return out;
}

type NotificationResult = {
  channelId: string;
  channel: string;
  ok: boolean;
  skipped?: boolean;
  error?: string;
  at: string;
};

/**
 * Runs schedules in-process (while StepForge is running) and sends run summaries to their notification channels.
 * Missed times while StepForge was stopped are not caught up; use the CLI with the OS scheduler for that.
 */
export class SchedulerService {
  private jobs = new Map<string, Cron>();
  private notified = new Set<string>();
  /** Recent notification results per run (shown in the schedule history). */
  readonly notifications = new Map<string, NotificationResult[]>();

  constructor(
    private readonly db: StepForgeDb,
    private readonly masterKey: Buffer,
    private readonly bus: EventBus,
    private readonly runs: RunManager,
    private readonly dashboardUrl: () => string,
  ) {
    this.bus.on('event', (e: { type: string; run?: typeof schema.runs.$inferSelect }) => {
      if (e.type !== 'run.updated' || !e.run?.scheduleId) return;
      if (!['passed', 'failed'].includes(e.run.status) || this.notified.has(e.run.id)) return;
      this.notified.add(e.run.id);
      void this.notifyRun(e.run.id);
    });
  }

  /** (Re)creates the cron jobs from the database. */
  start(): void {
    for (const s of repo.listSchedules(this.db)) this.arm(s);
  }

  stop(): void {
    for (const j of this.jobs.values()) j.stop();
    this.jobs.clear();
  }

  private arm(s: repo.Schedule): void {
    this.jobs.get(s.id)?.stop();
    this.jobs.delete(s.id);
    if (!s.enabled) {
      repo.setScheduleState(this.db, s.id, { nextRunAt: null });
      return;
    }
    try {
      const job = new Cron(s.cron, () => {
        if (this.stillRunning(s.id)) {
          repo.setScheduleState(this.db, s.id, { nextRunAt: job.nextRun()?.toISOString() ?? null });
          this.bus.publish({
            type: 'schedule.skipped',
            scheduleId: s.id,
            reason: 'previous run still going',
          });
          return;
        }
        void this.trigger(s.id).catch(() => undefined);
      });
      this.jobs.set(s.id, job);
      repo.setScheduleState(this.db, s.id, { nextRunAt: job.nextRun()?.toISOString() ?? null });
    } catch {
      repo.setScheduleState(this.db, s.id, { nextRunAt: null });
    }
  }

  /** A cron tick is skipped while the schedule's previous run is queued or running. */
  private stillRunning(id: string): boolean {
    const last = repo.getSchedule(this.db, id).lastRunId;
    if (!last) return false;
    const run = this.db
      .select({ status: schema.runs.status })
      .from(schema.runs)
      .where(eq(schema.runs.id, last))
      .get();
    return run?.status === 'queued' || run?.status === 'running';
  }

  save(applicationId: string, input: unknown, id?: string): repo.Schedule {
    const d = ScheduleInput.parse(input);
    nextRuns(d.cron, 1);
    const env = repo.getEnvironment(this.db, d.environmentId);
    if (env.applicationId !== applicationId)
      throw new repo.RepoError(400, 'invalid', 'Environment belongs to another application');
    for (const c of d.channelIds) repo.getChannel(this.db, c);
    const s = repo.saveSchedule(
      this.db,
      applicationId,
      { ...d, scope: d.scope as Record<string, unknown>, options: d.options },
      id,
    );
    this.arm(s);
    return repo.getSchedule(this.db, s.id);
  }

  delete(id: string): void {
    this.jobs.get(id)?.stop();
    this.jobs.delete(id);
    repo.deleteSchedule(this.db, id);
  }

  /** Starts a run for the schedule now (cron tick or "Run now"). */
  async trigger(id: string) {
    const s = repo.getSchedule(this.db, id);
    if (!s.environmentId) throw new repo.RepoError(400, 'invalid', 'The schedule’s environment was deleted');
    const run = this.runs.create(
      {
        applicationId: s.applicationId,
        environmentId: s.environmentId,
        scope: s.scopeJson as never,
        options: RunOptionsInput.parse(s.optionsJson ?? {}),
        trigger: 'schedule',
      },
      { scheduleId: s.id },
    );
    repo.setScheduleState(this.db, s.id, {
      lastRunId: run.id,
      nextRunAt: this.jobs.get(s.id)?.nextRun()?.toISOString() ?? null,
    });
    this.bus.publish({ type: 'schedule.triggered', scheduleId: s.id, runId: run.id });
    return run;
  }

  /** Builds the summary of a finished run for notifications. */
  summary(runId: string): RunSummary {
    const run = this.db.select().from(schema.runs).where(eq(schema.runs.id, runId)).get();
    if (!run) throw repo.notFound('Run', runId);
    const app = repo.getApplication(this.db, run.applicationId);
    const env = run.environmentId
      ? this.db.select().from(schema.environments).where(eq(schema.environments.id, run.environmentId)).get()
      : undefined;
    const items = this.db
      .select()
      .from(schema.runItems)
      .where(eq(schema.runItems.runId, runId))
      .orderBy(schema.runItems.position)
      .all();
    const gate = run.qualityGateJson as {
      status: string;
      gates: { rules: { label: string; passed: boolean | null }[] }[];
    } | null;
    const schedule = run.scheduleId
      ? this.db.select().from(schema.schedules).where(eq(schema.schedules.id, run.scheduleId)).get()
      : undefined;
    return {
      application: app.name,
      environment: env?.name ?? '—',
      status: run.status,
      trigger: run.trigger,
      scheduleName: schedule?.name,
      totals: run.totalsJson as RunSummary['totals'],
      passRate: passRate(items.filter((i) => i.status !== 'queued' && i.status !== 'running')),
      durationMs: run.durationMs,
      failed: items
        .filter((i) => i.status === 'failed' || i.status === 'broken')
        .map((i) => ({
          name: [i.labelJson?.scenario, i.labelJson?.testCaseCode].filter(Boolean).join(' — ') || i.id,
          diagnosis: (i.diagnosisJson as { title?: string } | null)?.title ?? null,
          error: i.errorMessage,
        })),
      gate: gate
        ? {
            status: gate.status,
            failing: gate.gates.flatMap((g) => g.rules.filter((r) => r.passed === false).map((r) => r.label)),
          }
        : null,
      url: `${this.dashboardUrl()}/runs/${run.id}`,
    };
  }

  /** Sends the run summary to the schedule's channels. */
  async notifyRun(runId: string, channelIds?: string[]): Promise<NotificationResult[]> {
    const run = this.db.select().from(schema.runs).where(eq(schema.runs.id, runId)).get();
    if (!run) return [];
    const ids =
      channelIds ??
      (run.scheduleId
        ? ((this.db.select().from(schema.schedules).where(eq(schema.schedules.id, run.scheduleId)).get()
            ?.notifyChannelIdsJson as string[]) ?? [])
        : []);
    const summary = this.summary(runId);
    const results: NotificationResult[] = [];
    for (const id of ids) {
      let name = id;
      try {
        const ch = repo.resolveChannel(this.db, this.masterKey, id);
        name = ch.name;
        const sent = await notify(
          { kind: ch.kind, config: ch.config, on: ch.on, secret: ch.secret },
          summary,
        );
        results.push({
          channelId: id,
          channel: name,
          ok: true,
          ...(!sent && { skipped: true }),
          at: new Date().toISOString(),
        });
      } catch (err) {
        results.push({
          channelId: id,
          channel: name,
          ok: false,
          error: (err as Error).message,
          at: new Date().toISOString(),
        });
        this.bus.publish({
          type: 'run.log',
          runId,
          level: 'warn',
          message: `Notification to ${name} failed: ${(err as Error).message}`,
        });
      }
    }
    this.notifications.set(runId, results);
    this.bus.publish({ type: 'notifications.sent', runId, results });
    return results;
  }

  saveChannel(input: unknown, id?: string) {
    const d = ChannelInput.parse(input);
    return repo.saveChannel(
      this.db,
      this.masterKey,
      {
        name: d.name,
        kind: d.kind,
        config: d.config,
        on: d.on,
        ...(d.secret !== undefined && { secret: d.secret || null }),
      },
      id,
    );
  }

  /** "Send test": a sample summary to one channel. */
  async testChannel(id: string): Promise<{ ok: boolean; message: string }> {
    try {
      const ch = repo.resolveChannel(this.db, this.masterKey, id);
      await notify(
        { kind: ch.kind, config: ch.config, on: ch.on, secret: ch.secret },
        { ...TEST_SUMMARY, url: this.dashboardUrl() },
        { force: true },
      );
      return { ok: true, message: `Test message sent to ${ch.name}` };
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
  }

  upcoming(limit = 5) {
    const apps = new Map(
      this.db
        .select({ id: schema.applications.id, name: schema.applications.name })
        .from(schema.applications)
        .all()
        .map((a) => [a.id, a.name]),
    );
    return repo
      .listSchedules(this.db)
      .filter((s) => s.enabled && s.nextRunAt)
      .sort((a, b) => a.nextRunAt!.localeCompare(b.nextRunAt!))
      .slice(0, limit)
      .map((s) => ({
        id: s.id,
        name: s.name,
        application: apps.get(s.applicationId) ?? '—',
        applicationId: s.applicationId,
        nextRunAt: s.nextRunAt!,
      }));
  }
}
