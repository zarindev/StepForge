import { BrowserName, RunOptionsInput } from '@stepforge/core';
import { newId } from '@stepforge/core';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import type { StepForgeDb } from '../index.ts';
import { campaignRuns, campaigns, environments, runs, schedules } from '../schema.ts';
import { invalid, notFound, now } from './errors.ts';
import { descendantIds } from './modules.ts';
import { getScenario, getTree } from './scenarios.ts';

/**
 * Campaigns: a saved selection of tests run across environments × browsers × screen sizes in one go (one run per
 * combination), with a combined report and "rerun failed".
 */
export type Campaign = typeof campaigns.$inferSelect;
export type CampaignRun = typeof campaignRuns.$inferSelect;

export const Viewport = z.enum(['desktop', 'tablet', 'mobile']);
export const CampaignSelection = z.union([
  z.object({ all: z.literal(true) }),
  z
    .object({
      modules: z.array(z.string()).default([]),
      tags: z.array(z.string()).default([]),
      scenarios: z.array(z.string()).default([]),
    })
    .refine(
      (s) => s.modules.length + s.tags.length + s.scenarios.length > 0,
      'Choose at least one module, tag or scenario',
    ),
]);
export const CampaignInput = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().max(2000).default(''),
  selection: CampaignSelection.default({ all: true }),
  environmentIds: z.array(z.string()).min(1, 'Choose at least one environment').max(10),
  browsers: z.array(BrowserName).min(1).max(3).default(['chromium']),
  viewports: z.array(Viewport).min(1).max(3).default(['desktop']),
  /** Run options for every run (workers, retries, evidence…); browser and viewport come from the matrix. */
  options: RunOptionsInput.omit({ browser: true, viewport: true }).partial().default({}),
  channelIds: z.array(z.string()).max(20).default([]),
});

function campaignRow(db: StepForgeDb, id: string): Campaign {
  const c = db.select().from(campaigns).where(eq(campaigns.id, id)).get();
  if (!c) throw notFound('Campaign', id);
  return c;
}
export const getCampaign = campaignRow;

export function listCampaigns(
  db: StepForgeDb,
  applicationId: string,
): (Campaign & { lastRun: CampaignRunSummary | null })[] {
  return db
    .select()
    .from(campaigns)
    .where(eq(campaigns.applicationId, applicationId))
    .orderBy(campaigns.name)
    .all()
    .map((c) => {
      const last = db
        .select()
        .from(campaignRuns)
        .where(eq(campaignRuns.campaignId, c.id))
        .orderBy(desc(campaignRuns.createdAt))
        .limit(1)
        .get();
      return { ...c, lastRun: last ? summarizeCampaignRun(db, last) : null };
    });
}

export function saveCampaign(db: StepForgeDb, applicationId: string, input: unknown, id?: string): Campaign {
  const d = CampaignInput.parse(input);
  const envs = db.select().from(environments).where(inArray(environments.id, d.environmentIds)).all();
  if (envs.length !== new Set(d.environmentIds).size || envs.some((e) => e.applicationId !== applicationId))
    throw invalid('Choose environments of this application');
  const clash = db
    .select({ id: campaigns.id })
    .from(campaigns)
    .where(and(eq(campaigns.applicationId, applicationId), eq(campaigns.name, d.name)))
    .get();
  if (clash && clash.id !== id) throw invalid(`A campaign named "${d.name}" already exists`);
  const values = {
    name: d.name,
    description: d.description,
    selectionJson: d.selection as Record<string, unknown>,
    environmentIdsJson: [...new Set(d.environmentIds)],
    browsersJson: [...new Set(d.browsers)],
    viewportsJson: [...new Set(d.viewports)],
    optionsJson: d.options as Record<string, unknown>,
    notifyChannelIdsJson: d.channelIds,
    updatedAt: now(),
  };
  if (id) {
    if (campaignRow(db, id).applicationId !== applicationId)
      throw invalid('The campaign belongs to another application');
    db.update(campaigns).set(values).where(eq(campaigns.id, id)).run();
    return campaignRow(db, id);
  }
  const newCampaign = newId();
  db.insert(campaigns)
    .values({ id: newCampaign, applicationId, ...values })
    .run();
  return campaignRow(db, newCampaign);
}

export function deleteCampaign(db: StepForgeDb, id: string): void {
  campaignRow(db, id);
  db.transaction(() => {
    // Schedules that run this campaign go with it (SQLite cannot add a cascading key to an existing table).
    db.delete(schedules).where(eq(schedules.campaignId, id)).run();
    const runIds = db
      .select({ id: campaignRuns.id })
      .from(campaignRuns)
      .where(eq(campaignRuns.campaignId, id))
      .all();
    if (runIds.length)
      db.update(runs)
        .set({ campaignRunId: null })
        .where(
          inArray(
            runs.campaignRunId,
            runIds.map((r) => r.id),
          ),
        )
        .run();
    db.delete(campaigns).where(eq(campaigns.id, id)).run();
  });
}

/**
 * The campaign's matrix: every environment × browser × screen size. Desktop and phone apps bring their own window
 * or device (one environment per emulator, simulator or phone), so they run once per environment.
 */
export function campaignMatrix(
  c: Campaign,
  platform = 'web',
): { environmentId: string; browser: string; viewport: string }[] {
  if (platform !== 'web')
    return c.environmentIdsJson.map((environmentId) => ({
      environmentId,
      browser: c.browsersJson[0] ?? 'chromium',
      viewport: c.viewportsJson[0] ?? 'desktop',
    }));
  return c.environmentIdsJson.flatMap((environmentId) =>
    c.browsersJson.flatMap((browser) =>
      c.viewportsJson.map((viewport) => ({ environmentId, browser, viewport })),
    ),
  );
}

/** The run scope for a campaign's selection: the whole application, or the scenarios its modules/tags/picks cover. */
export function campaignScope(
  db: StepForgeDb,
  c: Campaign,
): { type: 'application' } | { type: 'scenarios'; ids: string[] } {
  const sel = c.selectionJson as { all?: boolean; modules?: string[]; tags?: string[]; scenarios?: string[] };
  if (sel.all) return { type: 'application' };
  const tree = getTree(db, c.applicationId);
  const mods = new Set((sel.modules ?? []).flatMap((m) => [m, ...descendantIds(db, m)]));
  const tags = new Set(sel.tags ?? []);
  const picked = new Set(sel.scenarios ?? []);
  const ids = tree.scenarios
    .filter(
      (s) => mods.has(s.moduleId) || picked.has(s.id) || (tags.size > 0 && s.tagIds.some((t) => tags.has(t))),
    )
    .map((s) => s.id);
  if (!ids.length) throw invalid('The campaign selects no scenarios (they may have been deleted)');
  return { type: 'scenarios', ids };
}

export function createCampaignRun(
  db: StepForgeDb,
  c: Campaign,
  extra: { trigger: CampaignRun['trigger']; parentId?: string; scheduleId?: string },
): CampaignRun {
  const id = newId();
  db.insert(campaignRuns)
    .values({
      id,
      campaignId: c.id,
      applicationId: c.applicationId,
      trigger: extra.trigger,
      parentId: extra.parentId ?? null,
      scheduleId: extra.scheduleId ?? null,
    })
    .run();
  return getCampaignRunRow(db, id);
}

/** Removes a campaign run that never got any runs (a launch that failed half way). */
export function deleteCampaignRun(db: StepForgeDb, id: string): void {
  db.update(runs).set({ campaignRunId: null }).where(eq(runs.campaignRunId, id)).run();
  db.delete(campaignRuns).where(eq(campaignRuns.id, id)).run();
}

export function getCampaignRunRow(db: StepForgeDb, id: string): CampaignRun {
  const r = db.select().from(campaignRuns).where(eq(campaignRuns.id, id)).get();
  if (!r) throw notFound('Campaign run', id);
  return r;
}

export function markCampaignRunFinished(db: StepForgeDb, id: string): void {
  db.update(campaignRuns).set({ finishedAt: now(), updatedAt: now() }).where(eq(campaignRuns.id, id)).run();
}

type Totals = {
  total: number;
  passed: number;
  failed: number;
  broken: number;
  skipped: number;
  flaky: number;
};
export type CampaignRunSummary = CampaignRun & {
  campaignName: string;
  status: 'queued' | 'running' | 'passed' | 'failed' | 'cancelled';
  totals: Totals;
  runs: number;
  durationMs: number | null;
};

/** A campaign run's status and totals come from its runs. */
export function summarizeCampaignRun(db: StepForgeDb, r: CampaignRun): CampaignRunSummary {
  const children = db.select().from(runs).where(eq(runs.campaignRunId, r.id)).all();
  const totals: Totals = { total: 0, passed: 0, failed: 0, broken: 0, skipped: 0, flaky: 0 };
  for (const c of children)
    for (const k of Object.keys(totals) as (keyof Totals)[])
      totals[k] += Number((c.totalsJson as Totals)[k] ?? 0);
  const st = children.map((c) => c.status);
  const status: CampaignRunSummary['status'] = st.some((s) => s === 'running')
    ? 'running'
    : st.some((s) => s === 'queued')
      ? st.every((s) => s === 'queued')
        ? 'queued'
        : 'running'
      : // A campaign run without runs ran nothing: never report that as passed.
        !st.length || st.every((s) => s === 'cancelled')
        ? 'cancelled'
        : st.some((s) => s === 'failed' || s === 'interrupted' || s === 'cancelled')
          ? 'failed'
          : 'passed';
  const starts = children.map((c) => c.startedAt).filter(Boolean) as string[];
  const ends = children.map((c) => c.finishedAt).filter(Boolean) as string[];
  const durationMs =
    status === 'passed' || status === 'failed'
      ? starts.length && ends.length
        ? Date.parse(ends.sort().at(-1)!) - Date.parse(starts.sort()[0]!)
        : null
      : null;
  return {
    ...r,
    campaignName: campaignRow(db, r.campaignId).name,
    status,
    totals,
    runs: children.length,
    durationMs,
  };
}

export function listCampaignRuns(db: StepForgeDb, campaignId: string, limit = 20): CampaignRunSummary[] {
  return db
    .select()
    .from(campaignRuns)
    .where(eq(campaignRuns.campaignId, campaignId))
    .orderBy(desc(campaignRuns.createdAt))
    .limit(limit)
    .all()
    .map((r) => summarizeCampaignRun(db, r));
}

/** The campaign run's runs, one per combination, in matrix order. */
export function campaignRunChildren(db: StepForgeDb, id: string) {
  return db.select().from(runs).where(eq(runs.campaignRunId, id)).orderBy(runs.createdAt).all();
}

/** Scenario names for the per-test grid (deleted scenarios keep their run label). */
export function scenarioName(db: StepForgeDb, id: string): string | null {
  try {
    return getScenario(db, id).name;
  } catch {
    return null;
  }
}
