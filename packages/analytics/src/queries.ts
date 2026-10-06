import { schema, type StepForgeDb } from '@stepforge/db';
import { and, count, desc, eq, gte, inArray } from 'drizzle-orm';
import {
  daysAgo,
  dayOf,
  isFail,
  isPass,
  itemFacts,
  metricValues,
  passRate,
  percentile,
  testKey,
  type ItemFact,
} from './data.ts';
import { applicationGates } from './gates.ts';

// ─── Flaky tests ──────────────────────────────────────────────────────────
export type FlakyTest = {
  key: string;
  scenarioId: string | null;
  scenario: string;
  testCase: string | null;
  /** 0–1: how often the result flipped between consecutive runs of the same scenario version. */
  score: number;
  runs: number;
  flakyRuns: number;
  /** Oldest first. */
  history: string[];
  lastItemId: string;
  lastRunId: string;
};

/**
 * A test is flaky when it passed only on retry, or when its result flips between pass and fail across runs of
 * the same scenario version (the test did not change, so the flip is not explained by an edit).
 */
export function flakyTests(items: ItemFact[], minRuns = 3): FlakyTest[] {
  const byTest = new Map<string, ItemFact[]>();
  for (const i of items) {
    if (i.status === 'skipped') continue;
    const k = testKey(i);
    if (!byTest.has(k)) byTest.set(k, []);
    byTest.get(k)!.push(i);
  }
  const out: FlakyTest[] = [];
  for (const [key, list] of byTest) {
    list.sort((a, b) => a.at.localeCompare(b.at));
    const flakyRuns = list.filter((i) => i.status === 'flaky').length;
    let flips = 0;
    let pairs = 0;
    for (let n = 1; n < list.length; n++) {
      if (list[n]!.scenarioVersion !== list[n - 1]!.scenarioVersion) continue;
      pairs++;
      if (isPass(list[n]!.status) !== isPass(list[n - 1]!.status)) flips++;
    }
    const flippy = list.length >= minRuns && flips >= 2;
    if (!flakyRuns && !flippy) continue;
    const last = list[list.length - 1]!;
    out.push({
      key,
      scenarioId: last.scenarioId,
      scenario: last.scenario,
      testCase: last.testCase,
      score: Math.round(Math.max(pairs ? flips / pairs : 0, flakyRuns / list.length) * 100) / 100,
      runs: list.length,
      flakyRuns,
      history: list.slice(-20).map((i) => i.status),
      lastItemId: last.itemId,
      lastRunId: last.runId,
    });
  }
  return out.sort((a, b) => b.score - a.score || b.runs - a.runs);
}

// ─── Home ─────────────────────────────────────────────────────────────────
export function homeSummary(db: StepForgeDb) {
  const weekAgo = daysAgo(7);
  const week = itemFacts(db, { since: weekAgo });
  const apps = db.select().from(schema.applications).where(eq(schema.applications.archived, false)).all();
  const runsThisWeek = db.select().from(schema.runs).where(gte(schema.runs.createdAt, weekAgo)).all();
  const finished = runsThisWeek.filter((r) => r.durationMs);
  const openBugs =
    db
      .select({ n: count() })
      .from(schema.bugs)
      .where(inArray(schema.bugs.status, ['open', 'in_progress']))
      .get()?.n ?? 0;
  const counts = (t: typeof schema.scenarios | typeof schema.testCases) =>
    db.select({ n: count() }).from(t).get()?.n ?? 0;

  // 30-day trend from the daily aggregates (all applications).
  const since = dayOf(daysAgo(29));
  const daily = db.select().from(schema.analyticsDaily).where(gte(schema.analyticsDaily.date, since)).all();
  const trend = Array.from({ length: 30 }, (_, i) => {
    const date = dayOf(daysAgo(29 - i));
    const rows = daily.filter((d) => d.date === date);
    const sum = (k: 'passed' | 'failed' | 'flaky' | 'tests' | 'runs') => rows.reduce((s, r) => s + r[k], 0);
    return {
      date,
      runs: sum('runs'),
      passed: sum('passed'),
      failed: sum('failed'),
      flaky: sum('flaky'),
      other: sum('tests') - sum('passed') - sum('failed') - sum('flaky'),
    };
  });

  const recent = db.select().from(schema.runs).orderBy(desc(schema.runs.createdAt)).limit(8).all();
  const appNames = new Map(
    db
      .select({
        id: schema.applications.id,
        name: schema.applications.name,
        color: schema.applications.color,
      })
      .from(schema.applications)
      .all()
      .map((a) => [a.id, a]),
  );
  return {
    kpis: {
      applications: apps.length,
      scenarios: counts(schema.scenarios),
      testCases: counts(schema.testCases),
      runsThisWeek: runsThisWeek.length,
      passRate: passRate(week),
      flakyRate: week.length
        ? Math.round((week.filter((i) => i.status === 'flaky').length / week.length) * 1000) / 10
        : null,
      openBugs,
      avgDurationMs: finished.length
        ? Math.round(finished.reduce((s, r) => s + (r.durationMs ?? 0), 0) / finished.length)
        : null,
    },
    gates: apps.map((a) => ({
      applicationId: a.id,
      application: a.name,
      color: a.color,
      ...applicationGates(db, a.id),
    })),
    trend,
    recentRuns: recent.map((r) => ({
      id: r.id,
      application: appNames.get(r.applicationId)?.name ?? '—',
      color: appNames.get(r.applicationId)?.color,
      status: r.status,
      totals: r.totalsJson,
      createdAt: r.createdAt,
      durationMs: r.durationMs,
    })),
  };
}

// ─── Application analytics ────────────────────────────────────────────────
type Group = {
  key: string;
  label: string;
  total: number;
  passed: number;
  failed: number;
  flaky: number;
  skipped: number;
  passRate: number | null;
};
function group(
  items: ItemFact[],
  keyOf: (i: ItemFact) => string | string[] | null,
  labelOf: (k: string) => string = (k) => k,
): Group[] {
  const m = new Map<string, ItemFact[]>();
  for (const i of items) {
    const ks = keyOf(i);
    for (const k of Array.isArray(ks) ? ks : ks ? [ks] : []) {
      if (!m.has(k)) m.set(k, []);
      m.get(k)!.push(i);
    }
  }
  return [...m]
    .map(([key, list]) => ({
      key,
      label: labelOf(key),
      total: list.length,
      passed: list.filter((i) => i.status === 'passed').length,
      failed: list.filter((i) => isFail(i.status)).length,
      flaky: list.filter((i) => i.status === 'flaky').length,
      skipped: list.filter((i) => i.status === 'skipped').length,
      passRate: passRate(list),
    }))
    .sort((a, b) => b.failed - a.failed || b.total - a.total);
}

/** Per-day series of a performance metric (average and p95 per day). */
function metricTrend(db: StepForgeDb, items: ItemFact[], metric: string) {
  const at = new Map(items.map((i) => [i.itemId, dayOf(i.at)]));
  const byDay = new Map<string, number[]>();
  for (const v of metricValues(
    db,
    items.map((i) => i.itemId),
    metric,
  )) {
    const d = at.get(v.itemId)!;
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d)!.push(v.value);
  }
  return [...byDay]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, vals]) => ({
      date,
      avg: Math.round((vals.reduce((s, v) => s + v, 0) / vals.length) * 10) / 10,
      p95: percentile(vals, 95)!,
      count: vals.length,
    }));
}

export function appAnalytics(
  db: StepForgeDb,
  applicationId: string,
  opts: { days?: number; environmentId?: string } = {},
) {
  const days = Math.min(Math.max(opts.days ?? 30, 1), 365);
  const all = itemFacts(db, { applicationId, since: daysAgo(days - 1) });
  const items = opts.environmentId ? all.filter((i) => i.environmentId === opts.environmentId) : all;
  const scenarioIds = [...new Set(items.map((i) => i.scenarioId).filter(Boolean) as string[])];
  const scenarios = scenarioIds.length
    ? db
        .select({ id: schema.scenarios.id, kind: schema.scenarios.kind, priority: schema.scenarios.priority })
        .from(schema.scenarios)
        .where(inArray(schema.scenarios.id, scenarioIds))
        .all()
    : [];
  const kind = new Map(scenarios.map((s) => [s.id, s.kind]));
  const tagRows = scenarioIds.length
    ? db
        .select({ scenarioId: schema.scenarioTags.scenarioId, name: schema.tags.name })
        .from(schema.scenarioTags)
        .innerJoin(schema.tags, eq(schema.tags.id, schema.scenarioTags.tagId))
        .where(inArray(schema.scenarioTags.scenarioId, scenarioIds))
        .all()
    : [];
  const tagsOf = new Map<string, string[]>();
  for (const t of tagRows) tagsOf.set(t.scenarioId, [...(tagsOf.get(t.scenarioId) ?? []), t.name]);

  // Failures: the latest failing result per test, with its diagnosis, for drill-down to the failing step.
  const failures = items.filter((i) => isFail(i.status));
  const topFailing = [...group(failures, testKey)].slice(0, 10).map((g) => {
    const last = failures.filter((i) => testKey(i) === g.key).sort((a, b) => b.at.localeCompare(a.at))[0]!;
    const runsOfTest = items.filter((i) => testKey(i) === g.key && i.status !== 'skipped').length;
    return {
      key: g.key,
      scenarioId: last.scenarioId,
      scenario: last.scenario,
      testCase: last.testCase,
      failures: g.total,
      runs: runsOfTest,
      lastError: last.diagnosisTitle ?? last.errorMessage,
      category: last.category,
      lastItemId: last.itemId,
      lastRunId: last.runId,
    };
  });
  const durations = new Map<string, { item: ItemFact; values: number[] }>();
  for (const i of items)
    if (i.durationMs !== null && i.status !== 'skipped') {
      const k = testKey(i);
      if (!durations.has(k)) durations.set(k, { item: i, values: [] });
      durations.get(k)!.values.push(i.durationMs);
    }
  const slowest = [...durations.values()]
    .map(({ item, values }) => ({
      scenarioId: item.scenarioId,
      scenario: item.scenario,
      testCase: item.testCase,
      avgMs: Math.round(values.reduce((s, v) => s + v, 0) / values.length),
      maxMs: Math.max(...values),
      runs: values.length,
    }))
    .sort((a, b) => b.avgMs - a.avgMs)
    .slice(0, 10);

  const heatSince = dayOf(daysAgo(364));
  const heat = db
    .select()
    .from(schema.analyticsDaily)
    .where(
      and(eq(schema.analyticsDaily.applicationId, applicationId), gte(schema.analyticsDaily.date, heatSince)),
    )
    .all()
    .map((d) => ({
      date: d.date,
      runs: d.runs,
      tests: d.tests,
      passRate: d.tests ? Math.round(((d.passed + d.flaky) / d.tests) * 1000) / 10 : null,
    }));

  const loadRows = items.length
    ? db
        .select()
        .from(schema.loadResults)
        .where(
          inArray(
            schema.loadResults.runItemId,
            items.map((i) => i.itemId),
          ),
        )
        .all()
    : [];
  const itemById = new Map(items.map((i) => [i.itemId, i]));

  return {
    days,
    totals: {
      tests: items.length,
      runs: new Set(items.map((i) => i.runId)).size,
      passRate: passRate(items),
      failed: failures.length,
      flaky: items.filter((i) => i.status === 'flaky').length,
    },
    byModule: group(items, (i) => i.modulePath[0] ?? '(root)'),
    byLayer: group(items, (i) => (i.scenarioId ? (kind.get(i.scenarioId) ?? null) : null)),
    byTag: group(items, (i) => (i.scenarioId ? (tagsOf.get(i.scenarioId) ?? []) : [])),
    byEnvironment: group(items, (i) => i.environment),
    failureCategories: group(failures, (i) => i.category ?? 'not diagnosed').map((g) => ({
      category: g.key,
      count: g.total,
    })),
    topFailing,
    slowest,
    flaky: flakyTests(items).slice(0, 15),
    perf: {
      apiResponseTime: metricTrend(db, items, 'api.response_time'),
      pageLcp: metricTrend(db, items, 'page.lcp'),
      load: loadRows
        .map((l) => ({
          at: itemById.get(l.runItemId)?.at ?? l.createdAt,
          scenario: itemById.get(l.runItemId)?.scenario ?? '',
          profile: l.profile,
          vus: l.vus,
          rps: l.rps,
          p95: l.p95,
          errorRate: l.errorRate,
          runId: itemById.get(l.runItemId)?.runId,
        }))
        .sort((a, b) => a.at.localeCompare(b.at)),
    },
    heatmap: heat,
    gates: applicationGates(db, applicationId),
  };
}

// ─── Run comparison ───────────────────────────────────────────────────────
export function compareRuns(db: StepForgeDb, baseRunId: string, headRunId: string) {
  const runOf = (id: string) => {
    const r = db.select().from(schema.runs).where(eq(schema.runs.id, id)).get();
    if (!r) throw new Error(`Run ${id} not found`);
    return r;
  };
  const base = runOf(baseRunId);
  const head = runOf(headRunId);
  const all = (runId: string) =>
    db
      .select()
      .from(schema.runItems)
      .where(eq(schema.runItems.runId, runId))
      .all()
      .filter((i) => i.status !== 'queued' && i.status !== 'running')
      .map((i) => ({
        itemId: i.id,
        key: `${i.scenarioId ?? i.labelJson?.scenario}|${i.testCaseId ?? i.labelJson?.testCaseCode ?? ''}`,
        name: [i.labelJson?.scenario, i.labelJson?.testCaseCode].filter(Boolean).join(' — ') || i.id,
        status: i.status,
        durationMs: i.durationMs,
        error: (i.diagnosisJson as { title?: string } | null)?.title ?? i.errorMessage,
      }));
  const a = all(base.id);
  const b = all(head.id);
  const am = new Map(a.map((x) => [x.key, x]));
  const bm = new Map(b.map((x) => [x.key, x]));
  const row = (k: string) => ({
    key: k,
    name: (bm.get(k) ?? am.get(k))!.name,
    before: am.get(k)?.status ?? null,
    after: bm.get(k)?.status ?? null,
    error: bm.get(k)?.error ?? am.get(k)?.error ?? null,
    itemId: bm.get(k)?.itemId ?? am.get(k)!.itemId,
  });
  const keys = [...new Set([...am.keys(), ...bm.keys()])];
  const fixed = keys
    .filter((k) => am.has(k) && bm.has(k) && isFail(am.get(k)!.status) && isPass(bm.get(k)!.status))
    .map(row);
  const newFailures = keys
    .filter((k) => bm.has(k) && isFail(bm.get(k)!.status) && (!am.has(k) || !isFail(am.get(k)!.status)))
    .map(row);
  const stillFailing = keys
    .filter((k) => am.has(k) && bm.has(k) && isFail(am.get(k)!.status) && isFail(bm.get(k)!.status))
    .map(row);
  const stillPassing = keys.filter(
    (k) => am.has(k) && bm.has(k) && isPass(am.get(k)!.status) && isPass(bm.get(k)!.status),
  ).length;

  // Performance: the same metric of the same test in both runs.
  const metrics = (items: typeof a) => {
    const byItem = new Map(items.map((x) => [x.itemId, x.key]));
    const out = new Map<string, number[]>();
    if (!items.length) return out;
    for (const m of db
      .select()
      .from(schema.perfMetrics)
      .where(
        inArray(
          schema.perfMetrics.runItemId,
          items.map((x) => x.itemId),
        ),
      )
      .all()) {
      const k = `${byItem.get(m.runItemId)}#${m.metric}#${m.unit}`;
      if (!out.has(k)) out.set(k, []);
      out.get(k)!.push(m.value);
    }
    return out;
  };
  const pa = metrics(a);
  const pb = metrics(b);
  const avg = (v: number[]) => v.reduce((s, x) => s + x, 0) / v.length;
  const perfDeltas = [...pb.keys()]
    .filter((k) => pa.has(k))
    .map((k) => {
      const [test, metric, unit] = k.split('#') as [string, string, string];
      const before = Math.round(avg(pa.get(k)!) * 100) / 100;
      const after = Math.round(avg(pb.get(k)!) * 100) / 100;
      return {
        test: (bm.get(test) ?? am.get(test))!.name,
        metric,
        unit,
        before,
        after,
        deltaPct: before ? Math.round(((after - before) / before) * 1000) / 10 : null,
      };
    })
    .filter((d) => d.before !== d.after)
    .sort((x, y) => Math.abs(y.deltaPct ?? 0) - Math.abs(x.deltaPct ?? 0) || x.test.localeCompare(y.test))
    .slice(0, 30);

  const summary = (r: typeof base, items: typeof a) => ({
    id: r.id,
    status: r.status,
    createdAt: r.createdAt,
    durationMs: r.durationMs,
    totals: r.totalsJson,
    passRate: passRate(items),
  });
  return {
    base: summary(base, a),
    head: summary(head, b),
    fixed,
    newFailures,
    stillFailing,
    stillPassing,
    added: keys.filter((k) => !am.has(k)).length,
    removed: keys.filter((k) => !bm.has(k)).length,
    perfDeltas,
  };
}
