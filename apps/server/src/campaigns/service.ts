import { RunOptionsInput } from '@stepforge/core';
import { schema, type StepForgeDb } from '@stepforge/db';
import * as repo from '@stepforge/db/repos';
import type { RunSummary } from '@stepforge/notify';
import { eq, inArray } from 'drizzle-orm';
import type { EventBus } from '../context.ts';
import { runDefaults } from '../routes/system.ts';
import type { RunManager } from '../runner/manager.ts';
import { expandScope } from '../runner/scope.ts';
import type { SchedulerService } from '../scheduler/service.ts';

const RANK: Record<string, number> = {
  failed: 5,
  broken: 4,
  flaky: 3,
  passed: 2,
  skipped: 1,
  queued: 0,
  running: 0,
};
const TRIGGER = { manual: 'manual', schedule: 'schedule', cli: 'cli', rerun: 'retry' } as const;

/**
 * Campaigns: one click (or a schedule, or the CLI) runs a saved test selection in every environment × browser ×
 * screen size, as one campaign run with a combined report, "rerun failed" and one summary notification at the end.
 */
export class CampaignService {
  private finishing = new Set<string>();

  constructor(
    private readonly db: StepForgeDb,
    private readonly runs: RunManager,
    private readonly scheduler: SchedulerService,
    private readonly bus: EventBus,
    private readonly dashboardUrl: () => string,
  ) {
    this.bus.on('event', (e: { type: string; run?: typeof schema.runs.$inferSelect }) => {
      if (e.type !== 'run.updated' || !e.run?.campaignRunId) return;
      if (['queued', 'running'].includes(e.run.status)) return;
      void this.checkFinished(e.run.campaignRunId);
    });
  }

  /** Starts a campaign: one queued run per combination of its matrix. */
  launch(
    campaignId: string,
    extra: { trigger?: repo.CampaignRun['trigger']; scheduleId?: string } = {},
  ): repo.CampaignRunSummary {
    const c = repo.getCampaign(this.db, campaignId);
    const scope = repo.campaignScope(this.db, c);
    const matrix = repo.campaignMatrix(c);
    if (!matrix.length)
      throw new repo.RepoError(400, 'invalid', 'This campaign has no environments; edit it and choose one');
    return this.start(
      c,
      matrix.map((cell) => ({ ...cell, scope })),
      {
        trigger: extra.trigger ?? 'manual',
        scheduleId: extra.scheduleId,
      },
    );
  }

  /** Runs again only the failed tests, only in the combinations where they failed. */
  rerunFailed(campaignRunId: string): repo.CampaignRunSummary {
    const parent = repo.getCampaignRunRow(this.db, campaignRunId);
    const c = repo.getCampaign(this.db, parent.campaignId);
    const cells = repo.campaignRunChildren(this.db, campaignRunId).flatMap((r) => {
      const failed = this.db
        .select({ scenarioId: schema.runItems.scenarioId, status: schema.runItems.status })
        .from(schema.runItems)
        .where(eq(schema.runItems.runId, r.id))
        .all()
        .filter((i) => (i.status === 'failed' || i.status === 'broken') && i.scenarioId);
      const ids = [...new Set(failed.map((i) => i.scenarioId!))];
      return ids.length && r.environmentId
        ? [
            {
              environmentId: r.environmentId,
              browser: r.browser,
              viewport: r.viewport,
              scope: { type: 'scenarios' as const, ids },
            },
          ]
        : [];
    });
    if (!cells.length) throw new repo.RepoError(400, 'invalid', 'Nothing failed in this campaign run');
    return this.start(c, cells, { trigger: 'rerun', parentId: parent.id, scheduleId: undefined });
  }

  private start(
    c: repo.Campaign,
    cells: { environmentId: string; browser: string; viewport: string; scope: unknown }[],
    extra: { trigger: repo.CampaignRun['trigger']; parentId?: string; scheduleId?: string },
  ): repo.CampaignRunSummary {
    // Everything is checked before the campaign run exists, so a refused launch leaves nothing behind.
    // A rerun skips combinations whose environment was deleted or whose tests are now all manual.
    const rerun = extra.trigger === 'rerun';
    const runnable = cells.filter((cell) => {
      try {
        const env = repo.getEnvironment(this.db, cell.environmentId);
        if (env.applicationId !== c.applicationId)
          throw new repo.RepoError(400, 'invalid', 'Environment belongs to another application');
      } catch (err) {
        if (rerun) return false;
        throw err;
      }
      return expandScope(this.db, c.applicationId, cell.scope as never).length > 0;
    });
    if (!runnable.length)
      throw new repo.RepoError(
        400,
        'empty_scope',
        rerun
          ? 'Nothing to rerun: the failed tests are now manual, or their environments were deleted'
          : 'This campaign has no automated tests to run (manual tests run in a manual run)',
      );
    const cr = repo.createCampaignRun(this.db, c, extra);
    const options = RunOptionsInput.parse({ ...runDefaults(this.db), ...c.optionsJson });
    const created: string[] = [];
    try {
      for (const cell of runnable)
        created.push(
          this.runs.create(
            {
              applicationId: c.applicationId,
              environmentId: cell.environmentId,
              scope: cell.scope as never,
              options: { ...options, browser: cell.browser as never, viewport: cell.viewport as never },
              trigger: TRIGGER[extra.trigger],
            },
            { campaignRunId: cr.id, scheduleId: extra.scheduleId },
          ).id,
        );
    } catch (err) {
      // Not expected after the checks above; undo rather than leave a half-launched campaign run.
      for (const id of created) this.runs.cancel(id);
      if (!created.length) repo.deleteCampaignRun(this.db, cr.id);
      throw err;
    }
    this.bus.publish({ type: 'campaign.updated', campaignId: c.id, campaignRunId: cr.id });
    return repo.summarizeCampaignRun(this.db, cr);
  }

  /** Cancels the campaign run's queued and running runs. */
  cancel(campaignRunId: string): repo.CampaignRunSummary {
    for (const r of repo.campaignRunChildren(this.db, campaignRunId))
      if (r.status === 'queued' || r.status === 'running') this.runs.cancel(r.id);
    return repo.summarizeCampaignRun(this.db, repo.getCampaignRunRow(this.db, campaignRunId));
  }

  /** The combined report: one cell per combination, and each test's result in every combination. */
  detail(campaignRunId: string) {
    const cr = repo.getCampaignRunRow(this.db, campaignRunId);
    const summary = repo.summarizeCampaignRun(this.db, cr);
    const children = repo.campaignRunChildren(this.db, campaignRunId);
    const envIds = [...new Set(children.map((r) => r.environmentId).filter(Boolean) as string[])];
    const envs = new Map(
      (envIds.length
        ? this.db.select().from(schema.environments).where(inArray(schema.environments.id, envIds)).all()
        : []
      ).map((e) => [e.id, e.name]),
    );
    const cells = children.map((r) => ({
      runId: r.id,
      environmentId: r.environmentId,
      environment: (r.environmentId && envs.get(r.environmentId)) || 'deleted environment',
      browser: r.browser,
      viewport: r.viewport,
      status: r.status,
      totals: r.totalsJson,
      durationMs: r.durationMs,
    }));
    const items = children.length
      ? this.db
          .select()
          .from(schema.runItems)
          .where(
            inArray(
              schema.runItems.runId,
              children.map((r) => r.id),
            ),
          )
          .all()
      : [];
    const tests = new Map<
      string,
      { scenarioId: string | null; name: string; results: Record<string, { status: string; itemId: string }> }
    >();
    for (const it of items) {
      const key = it.scenarioId ?? `label:${it.labelJson?.scenario}`;
      const t = tests.get(key) ?? {
        scenarioId: it.scenarioId,
        name: it.labelJson?.scenario ?? 'Deleted scenario',
        results: {},
      };
      // Several test cases of one scenario: the worst result counts.
      const prev = t.results[it.runId];
      if (!prev || (RANK[it.status] ?? 0) > (RANK[prev.status] ?? 0))
        t.results[it.runId] = { status: it.status, itemId: it.id };
      tests.set(key, t);
    }
    const grid = [...tests.values()].sort((a, b) => {
      const bad = (t: typeof a) =>
        Object.values(t.results).filter((r) => r.status === 'failed' || r.status === 'broken').length;
      return bad(b) - bad(a) || a.name.localeCompare(b.name);
    });
    const parent = cr.parentId
      ? repo.summarizeCampaignRun(this.db, repo.getCampaignRunRow(this.db, cr.parentId))
      : null;
    return { ...summary, cells, grid, parent };
  }

  /** When every run of a campaign run has finished: mark it and send one summary to the channels. */
  async checkFinished(campaignRunId: string): Promise<void> {
    if (this.finishing.has(campaignRunId)) return;
    const cr = repo.getCampaignRunRow(this.db, campaignRunId);
    if (cr.finishedAt) return;
    const summary = repo.summarizeCampaignRun(this.db, cr);
    if (summary.status === 'queued' || summary.status === 'running') return;
    this.finishing.add(campaignRunId);
    try {
      // Send the summary first, so "finished" means the notification went out too.
      const c = repo.getCampaign(this.db, cr.campaignId);
      const schedule = cr.scheduleId ? repo.getSchedule(this.db, cr.scheduleId) : undefined;
      const ids = [...new Set([...c.notifyChannelIdsJson, ...(schedule?.notifyChannelIdsJson ?? [])])];
      if (ids.length)
        await this.scheduler.deliver(this.summary(campaignRunId), ids, campaignRunId).catch(() => []);
    } finally {
      repo.markCampaignRunFinished(this.db, campaignRunId);
      this.finishing.delete(campaignRunId);
      this.bus.publish({ type: 'campaign.updated', campaignId: cr.campaignId, campaignRunId });
    }
  }

  /** A campaign run as a notification summary (all combinations together). */
  summary(campaignRunId: string): RunSummary {
    const d = this.detail(campaignRunId);
    const app = repo.getApplication(this.db, d.applicationId);
    const schedule = d.scheduleId ? repo.getSchedule(this.db, d.scheduleId) : undefined;
    const label = (runId: string) => {
      const cell = d.cells.find((x) => x.runId === runId)!;
      return `${cell.environment} · ${cell.browser} · ${cell.viewport}`;
    };
    const failed = d.grid.flatMap((t) =>
      Object.entries(t.results)
        .filter(([, r]) => r.status === 'failed' || r.status === 'broken')
        .map(([runId, r]) => {
          const item = this.db.select().from(schema.runItems).where(eq(schema.runItems.id, r.itemId)).get();
          return {
            name: `${t.name} — ${label(runId)}`,
            diagnosis: (item?.diagnosisJson as { title?: string } | null)?.title ?? null,
            error: item?.errorMessage ?? null,
          };
        }),
    );
    const counted = d.totals.total - d.totals.skipped;
    return {
      application: app.name,
      environment: `${d.cells.length} combination${d.cells.length === 1 ? '' : 's'}`,
      status: d.status === 'passed' ? 'passed' : 'failed',
      trigger: d.trigger,
      campaignName: d.campaignName,
      scheduleName: schedule?.name,
      totals: d.totals,
      passRate: counted > 0 ? Math.round(((d.totals.passed + d.totals.flaky) / counted) * 1000) / 10 : null,
      durationMs: d.durationMs,
      failed,
      gate: null,
      url: `${this.dashboardUrl()}/campaign-runs/${campaignRunId}`,
    };
  }
}
