import { schema, type StepForgeDb } from '@stepforge/db';
import { and, eq, gte, inArray, lt } from 'drizzle-orm';
import { COMPLETED_RUN, isFail, metricValues, percentile } from './data.ts';

/**
 * Recomputes the pre-aggregated row of one application and UTC day (`analytics_daily`) from the runs that finished
 * that day. Called after every run; charts over long ranges read only these rows.
 */
export function refreshDaily(db: StepForgeDb, applicationId: string, date: string): void {
  const start = `${date}T00:00:00.000Z`;
  const next = new Date(start);
  next.setUTCDate(next.getUTCDate() + 1);
  const runs = db
    .select()
    .from(schema.runs)
    .where(
      and(
        eq(schema.runs.applicationId, applicationId),
        inArray(schema.runs.status, [...COMPLETED_RUN]),
        gte(schema.runs.finishedAt, start),
        lt(schema.runs.finishedAt, next.toISOString()),
      ),
    )
    .all();
  db.delete(schema.analyticsDaily)
    .where(and(eq(schema.analyticsDaily.applicationId, applicationId), eq(schema.analyticsDaily.date, date)))
    .run();
  if (!runs.length) return;
  const items = db
    .select({ id: schema.runItems.id, status: schema.runItems.status })
    .from(schema.runItems)
    .where(
      inArray(
        schema.runItems.runId,
        runs.map((r) => r.id),
      ),
    )
    .all()
    .filter((i) => i.status !== 'queued' && i.status !== 'running');
  const api = metricValues(
    db,
    items.map((i) => i.id),
    'api.response_time',
  ).map((m) => m.value);
  db.insert(schema.analyticsDaily)
    .values({
      applicationId,
      date,
      runs: runs.length,
      tests: items.length,
      passed: items.filter((i) => i.status === 'passed').length,
      failed: items.filter((i) => isFail(i.status)).length,
      flaky: items.filter((i) => i.status === 'flaky').length,
      avgDurationMs: Math.round(runs.reduce((s, r) => s + (r.durationMs ?? 0), 0) / runs.length),
      p95ApiMs: percentile(api, 95),
    })
    .run();
}

/** Rebuilds every day that has runs (used once when the table is empty, e.g. after upgrading). */
export function rebuildDaily(db: StepForgeDb): number {
  const days = new Set<string>();
  for (const r of db
    .select({ app: schema.runs.applicationId, finishedAt: schema.runs.finishedAt })
    .from(schema.runs)
    .where(inArray(schema.runs.status, [...COMPLETED_RUN]))
    .all())
    if (r.finishedAt) days.add(`${r.app}|${r.finishedAt.slice(0, 10)}`);
  for (const key of days) {
    const [app, date] = key.split('|') as [string, string];
    refreshDaily(db, app, date);
  }
  return days.size;
}
