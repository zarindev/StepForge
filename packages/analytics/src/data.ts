import { schema, type StepForgeDb } from '@stepforge/db';
import { and, eq, gte, inArray, isNotNull, lte } from 'drizzle-orm';

export type ItemFact = {
  itemId: string;
  runId: string;
  scenarioId: string | null;
  testCaseId: string | null;
  scenario: string;
  testCase: string | null;
  modulePath: string[];
  scenarioVersion: number;
  status: string;
  durationMs: number | null;
  errorMessage: string | null;
  category: string | null;
  diagnosisTitle: string | null;
  at: string;
  environmentId: string | null;
  environment: string;
};

const FINAL = ['passed', 'failed', 'broken', 'skipped', 'flaky'];
export const COMPLETED_RUN = ['passed', 'failed'] as const;

/** UTC calendar day of an ISO timestamp. */
export const dayOf = (iso: string) => iso.slice(0, 10);
export const daysAgo = (n: number, from = new Date()) => {
  const d = new Date(from);
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString();
};

/** Finished test results of completed runs in a time window, with names and diagnosis category. */
export function itemFacts(
  db: StepForgeDb,
  opts: { applicationId?: string; since?: string; until?: string; runIds?: string[] },
): ItemFact[] {
  const rows = db
    .select({
      item: schema.runItems,
      runId: schema.runs.id,
      finishedAt: schema.runs.finishedAt,
      environmentId: schema.runs.environmentId,
      envName: schema.environments.name,
    })
    .from(schema.runItems)
    .innerJoin(schema.runs, eq(schema.runs.id, schema.runItems.runId))
    .leftJoin(schema.environments, eq(schema.environments.id, schema.runs.environmentId))
    .where(
      and(
        opts.applicationId ? eq(schema.runs.applicationId, opts.applicationId) : undefined,
        inArray(schema.runs.status, [...COMPLETED_RUN]),
        isNotNull(schema.runs.finishedAt),
        opts.since ? gte(schema.runs.finishedAt, opts.since) : undefined,
        opts.until ? lte(schema.runs.finishedAt, opts.until) : undefined,
        opts.runIds ? inArray(schema.runs.id, opts.runIds) : undefined,
        inArray(schema.runItems.status, FINAL as never[]),
      ),
    )
    .all();
  return rows.map(({ item, runId, finishedAt, environmentId, envName }) => {
    const d = item.diagnosisJson as { category?: string; title?: string } | null;
    const label = item.labelJson;
    return {
      itemId: item.id,
      runId,
      scenarioId: item.scenarioId,
      testCaseId: item.testCaseId,
      scenario: label?.scenario ?? 'Deleted scenario',
      testCase: label?.testCaseCode ? `${label.testCaseCode} ${label.testCaseTitle ?? ''}`.trim() : null,
      modulePath: label?.modulePath ?? [],
      scenarioVersion: item.scenarioVersion,
      status: item.status,
      durationMs: item.durationMs,
      errorMessage: item.errorMessage,
      category: d?.category ?? null,
      diagnosisTitle: d?.title ?? null,
      at: finishedAt!,
      environmentId,
      environment: envName ?? 'Deleted environment',
    };
  });
}

/** Identifies "the same test" across runs. */
export const testKey = (f: Pick<ItemFact, 'scenarioId' | 'testCaseId' | 'scenario' | 'testCase'>) =>
  `${f.scenarioId ?? f.scenario}|${f.testCaseId ?? f.testCase ?? ''}`;

export const isPass = (s: string) => s === 'passed' || s === 'flaky';
export const isFail = (s: string) => s === 'failed' || s === 'broken';

/** Pass rate in % over executed tests (skipped tests are not counted); null when nothing ran. */
export function passRate(items: { status: string }[]): number | null {
  const ran = items.filter((i) => i.status !== 'skipped');
  return ran.length
    ? Math.round((ran.filter((i) => isPass(i.status)).length / ran.length) * 1000) / 10
    : null;
}

export function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.max(0, Math.ceil((p / 100) * s.length) - 1)]!;
}

/** Performance metric values recorded by the steps of the given run items. */
export function metricValues(db: StepForgeDb, itemIds: string[], metric: string) {
  if (!itemIds.length) return [];
  const out: { itemId: string; value: number; at: string }[] = [];
  for (let i = 0; i < itemIds.length; i += 500) {
    const chunk = itemIds.slice(i, i + 500);
    for (const r of db
      .select({
        itemId: schema.perfMetrics.runItemId,
        value: schema.perfMetrics.value,
        at: schema.perfMetrics.createdAt,
      })
      .from(schema.perfMetrics)
      .where(and(inArray(schema.perfMetrics.runItemId, chunk), eq(schema.perfMetrics.metric, metric)))
      .all())
      out.push(r);
  }
  return out;
}
