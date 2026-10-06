import { newId } from '@stepforge/core';
import { schema, type StepForgeDb } from '@stepforge/db';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { COMPLETED_RUN, daysAgo, isPass, itemFacts, metricValues, passRate, percentile } from './data.ts';

const Level = z.enum(['block', 'warn']).default('block');
export const GateRule = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('passRate'),
    min: z.number().min(0).max(100),
    priority: z.enum(['P1', 'P2', 'P3', 'P4']).optional(),
    tag: z.string().optional(),
    level: Level,
  }),
  z.object({
    kind: z.literal('openBugs'),
    severity: z.enum(['critical', 'major', 'minor', 'trivial']).default('critical'),
    max: z.number().int().min(0),
    level: Level,
  }),
  z.object({ kind: z.literal('flakyRate'), max: z.number().min(0).max(100), level: Level }),
  z.object({ kind: z.literal('apiP95'), maxMs: z.number().positive(), level: Level }),
  z.object({ kind: z.literal('loadP95'), maxMs: z.number().positive(), level: Level }),
  z.object({ kind: z.literal('pageLcp'), maxMs: z.number().positive(), level: Level }),
  z.object({ kind: z.literal('maxDuration'), maxMinutes: z.number().positive(), level: Level }),
]);
export type GateRule = z.infer<typeof GateRule>;
export const GateInput = z.object({
  name: z.string().trim().min(1).max(100),
  rules: z.array(GateRule).min(1).max(30),
});

export type RuleResult = {
  rule: GateRule;
  label: string;
  passed: boolean | null;
  actual: string;
  message: string;
};
export type GateStatus = 'green' | 'amber' | 'red' | 'unknown';
export type GateResult = {
  gateId: string;
  name: string;
  status: GateStatus;
  /** The run the gate was evaluated on (its latest completed run). */
  runId: string | null;
  evaluatedAt: string;
  rules: RuleResult[];
};

const SEVERITY_ORDER = ['trivial', 'minor', 'major', 'critical'];

export function describeRule(r: GateRule): string {
  switch (r.kind) {
    case 'passRate':
      return `Pass rate${r.priority || r.tag ? ` of ${r.priority ? `${r.priority} ` : ''}tests${r.tag ? ` tagged "${r.tag}"` : ''}` : ''} ≥ ${r.min}%`;
    case 'openBugs':
      return `Open ${r.severity === 'critical' ? 'critical' : `${r.severity} or worse`} bugs ≤ ${r.max}`;
    case 'flakyRate':
      return `Flaky rate (7 days) ≤ ${r.max}%`;
    case 'apiP95':
      return `API p95 < ${r.maxMs} ms`;
    case 'loadP95':
      return `Load test p95 < ${r.maxMs} ms`;
    case 'pageLcp':
      return `Page LCP (p75) < ${r.maxMs} ms`;
    case 'maxDuration':
      return `Run duration ≤ ${r.maxMinutes} min`;
  }
}

// ─── CRUD ─────────────────────────────────────────────────────────────────
export function listGates(db: StepForgeDb, applicationId: string) {
  return db
    .select()
    .from(schema.qualityGates)
    .where(eq(schema.qualityGates.applicationId, applicationId))
    .orderBy(schema.qualityGates.createdAt)
    .all()
    .map((g) => ({ ...g, rules: g.rulesJson as GateRule[] }));
}

export function saveGate(
  db: StepForgeDb,
  applicationId: string,
  input: z.input<typeof GateInput>,
  id?: string,
) {
  const d = GateInput.parse(input);
  if (id) {
    const existing = db.select().from(schema.qualityGates).where(eq(schema.qualityGates.id, id)).get();
    if (!existing || existing.applicationId !== applicationId) throw new Error('Quality gate not found');
    db.update(schema.qualityGates)
      .set({ name: d.name, rulesJson: d.rules, updatedAt: new Date().toISOString() })
      .where(eq(schema.qualityGates.id, id))
      .run();
    return id;
  }
  const newGate = newId();
  db.insert(schema.qualityGates)
    .values({ id: newGate, applicationId, name: d.name, rulesJson: d.rules })
    .run();
  return newGate;
}

export function deleteGate(db: StepForgeDb, id: string) {
  db.delete(schema.qualityGates).where(eq(schema.qualityGates.id, id)).run();
}

// ─── Evaluation ───────────────────────────────────────────────────────────
function tagsOf(db: StepForgeDb, scenarioIds: string[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  if (!scenarioIds.length) return out;
  for (const r of db
    .select({ scenarioId: schema.scenarioTags.scenarioId, name: schema.tags.name })
    .from(schema.scenarioTags)
    .innerJoin(schema.tags, eq(schema.tags.id, schema.scenarioTags.tagId))
    .where(inArray(schema.scenarioTags.scenarioId, scenarioIds))
    .all()) {
    if (!out.has(r.scenarioId)) out.set(r.scenarioId, new Set());
    out.get(r.scenarioId)!.add(r.name.toLowerCase());
  }
  return out;
}

/**
 * Evaluates a gate against the application's latest completed run (pass rates, performance, duration), its open
 * bugs and the last 7 days (flakiness). A rule without data is "unknown" and makes the gate amber.
 */
export function evaluateGate(
  db: StepForgeDb,
  gate: { id: string; name: string; applicationId: string; rules: GateRule[] },
  runId?: string,
): GateResult {
  const run =
    (runId ? db.select().from(schema.runs).where(eq(schema.runs.id, runId)).get() : undefined) ??
    db
      .select()
      .from(schema.runs)
      .where(
        and(
          eq(schema.runs.applicationId, gate.applicationId),
          inArray(schema.runs.status, [...COMPLETED_RUN]),
        ),
      )
      .orderBy(desc(schema.runs.finishedAt))
      .get();
  const items = run ? itemFacts(db, { runIds: [run.id] }) : [];
  const scenarioIds = [...new Set(items.map((i) => i.scenarioId).filter(Boolean) as string[])];
  const priorities = new Map(
    scenarioIds.length
      ? db
          .select({ id: schema.scenarios.id, priority: schema.scenarios.priority })
          .from(schema.scenarios)
          .where(inArray(schema.scenarios.id, scenarioIds))
          .all()
          .map((s) => [s.id, s.priority])
      : [],
  );
  const tags = tagsOf(db, scenarioIds);

  const results: RuleResult[] = gate.rules.map((rule) => {
    const label = describeRule(rule);
    const none = (why: string): RuleResult => ({ rule, label, passed: null, actual: '—', message: why });
    switch (rule.kind) {
      case 'passRate': {
        if (!run) return none('No completed run yet');
        const scoped = items.filter(
          (i) =>
            (!rule.priority || (i.scenarioId && priorities.get(i.scenarioId) === rule.priority)) &&
            (!rule.tag || (i.scenarioId && tags.get(i.scenarioId)?.has(rule.tag.toLowerCase()))),
        );
        const rate = passRate(scoped);
        if (rate === null) return none('No matching tests in the latest run');
        const failing = scoped.filter((i) => !isPass(i.status) && i.status !== 'skipped').length;
        return {
          rule,
          label,
          passed: rate >= rule.min,
          actual: `${rate}%`,
          message: `${rate}% of ${scoped.filter((i) => i.status !== 'skipped').length} tests passed${failing ? ` (${failing} failing)` : ''}`,
        };
      }
      case 'openBugs': {
        const min = SEVERITY_ORDER.indexOf(rule.severity);
        const open = db
          .select({ severity: schema.bugs.severity, code: schema.bugs.code })
          .from(schema.bugs)
          .where(
            and(
              eq(schema.bugs.applicationId, gate.applicationId),
              inArray(schema.bugs.status, ['open', 'in_progress']),
            ),
          )
          .all()
          .filter((b) => SEVERITY_ORDER.indexOf(b.severity) >= min);
        return {
          rule,
          label,
          passed: open.length <= rule.max,
          actual: String(open.length),
          message: open.length
            ? `${open.length} open: ${open
                .slice(0, 5)
                .map((b) => b.code)
                .join(', ')}`
            : 'None open',
        };
      }
      case 'flakyRate': {
        const week = itemFacts(db, { applicationId: gate.applicationId, since: daysAgo(7) });
        if (!week.length) return none('No runs in the last 7 days');
        const rate = Math.round((week.filter((i) => i.status === 'flaky').length / week.length) * 1000) / 10;
        return {
          rule,
          label,
          passed: rate <= rule.max,
          actual: `${rate}%`,
          message: `${rate}% of ${week.length} results were flaky`,
        };
      }
      case 'apiP95':
      case 'pageLcp': {
        if (!run) return none('No completed run yet');
        const metric = rule.kind === 'apiP95' ? 'api.response_time' : 'page.lcp';
        const values = metricValues(
          db,
          items.map((i) => i.itemId),
          metric,
        ).map((m) => m.value);
        const p = percentile(values, rule.kind === 'apiP95' ? 95 : 75);
        if (p === null)
          return none(
            rule.kind === 'apiP95'
              ? 'The latest run made no API requests'
              : 'The latest run recorded no page metrics',
          );
        const v = Math.round(p * 10) / 10;
        return {
          rule,
          label,
          passed: v < rule.maxMs,
          actual: `${v} ms`,
          message: `${v} ms over ${values.length} measurements`,
        };
      }
      case 'loadP95': {
        if (!run) return none('No completed run yet');
        const loads = items.length
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
        if (!loads.length) return none('The latest run had no load test');
        const worst = Math.max(...loads.map((l) => l.p95 ?? 0));
        return {
          rule,
          label,
          passed: worst < rule.maxMs,
          actual: `${worst} ms`,
          message: `Worst p95 of ${loads.length} load test(s): ${worst} ms`,
        };
      }
      case 'maxDuration': {
        if (!run?.durationMs) return none('No completed run yet');
        const min = Math.round((run.durationMs / 60_000) * 10) / 10;
        return {
          rule,
          label,
          passed: min <= rule.maxMinutes,
          actual: `${min} min`,
          message: `The latest run took ${min} min`,
        };
      }
    }
  });
  const failedBlock = results.some((r) => r.passed === false && r.rule.level === 'block');
  const failedWarn = results.some((r) => r.passed === false && r.rule.level === 'warn');
  const unknown = results.some((r) => r.passed === null);
  // Without a completed run there is nothing to judge yet — unless a blocking rule (e.g. open bugs) already fails.
  const status: GateStatus = failedBlock
    ? 'red'
    : !run
      ? 'unknown'
      : failedWarn || unknown
        ? 'amber'
        : 'green';
  return {
    gateId: gate.id,
    name: gate.name,
    status,
    runId: run?.id ?? null,
    evaluatedAt: new Date().toISOString(),
    rules: results,
  };
}

const RANK: Record<GateStatus, number> = { unknown: 0, green: 1, amber: 2, red: 3 };

/** All gates of an application and the overall (worst) status. */
export function applicationGates(db: StepForgeDb, applicationId: string, runId?: string) {
  const gates = listGates(db, applicationId).map((g) => evaluateGate(db, g, runId));
  const status = gates.reduce<GateStatus>(
    (worst, g) => (RANK[g.status] > RANK[worst] ? g.status : worst),
    gates.length ? 'green' : 'unknown',
  );
  return { status: gates.length ? status : ('unknown' as GateStatus), gates };
}

/** A sensible starting gate for a new application. */
export const DEFAULT_GATE: z.input<typeof GateInput> = {
  name: 'Release readiness',
  rules: [
    { kind: 'passRate', priority: 'P1', min: 100 },
    { kind: 'passRate', min: 95, level: 'warn' },
    { kind: 'openBugs', severity: 'critical', max: 0 },
    { kind: 'apiP95', maxMs: 800, level: 'warn' },
  ],
};
