import { newId } from '@stepforge/core';
import { openDatabase, schema, type StepForgeDb } from '@stepforge/db';
import * as repo from '@stepforge/db/repos';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  appAnalytics,
  applicationGates,
  compareRuns,
  daysAgo,
  evaluateGate,
  flakyTests,
  homeSummary,
  itemFacts,
  rebuildDaily,
  refreshDaily,
  saveGate,
} from '../src/index.ts';

let db: StepForgeDb;
let appId = '';
let envId = '';
let login = '';
let checkout = '';
let flaky = '';

/** Inserts a finished run `day` days ago with the given results per scenario. */
function run(day: number, results: [string, string, number?][], extra: { durationMs?: number } = {}) {
  const runId = newId();
  const at = new Date(Date.parse(daysAgo(day)) + 10 * 3600_000).toISOString();
  db.insert(schema.runs)
    .values({
      id: runId,
      applicationId: appId,
      environmentId: envId,
      status: results.some(([, s]) => s === 'failed') ? 'failed' : 'passed',
      startedAt: at,
      finishedAt: at,
      durationMs: extra.durationMs ?? 60_000,
      totalsJson: {},
      createdAt: at,
    })
    .run();
  const ids: string[] = [];
  for (const [scenarioId, status, apiMs] of results) {
    const s = repo.getScenario(db, scenarioId);
    const itemId = newId();
    ids.push(itemId);
    db.insert(schema.runItems)
      .values({
        id: itemId,
        runId,
        scenarioId,
        labelJson: { scenario: s.name, modulePath: ['Shop'], testCaseCode: null, testCaseTitle: null },
        status: status as 'passed',
        durationMs: scenarioId === checkout ? 9000 : 1200,
        errorMessage: status === 'failed' ? 'Expected status equals 200, but got 500' : null,
        diagnosisJson:
          status === 'failed'
            ? { category: 'server_error', title: 'The server crashed handling POST /api/orders (500)' }
            : null,
        createdAt: at,
      })
      .run();
    if (apiMs !== undefined)
      db.insert(schema.perfMetrics)
        .values({ id: newId(), runItemId: itemId, metric: 'api.response_time', value: apiMs, unit: 'ms' })
        .run();
  }
  refreshDaily(db, appId, at.slice(0, 10));
  return { runId, itemIds: ids };
}

beforeEach(() => {
  ({ db } = openDatabase({ file: ':memory:' }));
  appId = repo.createApplication(db, { name: 'Shop', slug: 'shop' }).id;
  envId = repo.createEnvironment(db, appId, { name: 'Staging', baseUrl: 'http://staging.test' }).id;
  const mod = repo.createModule(db, appId, { name: 'Shop' });
  const tag = repo.createTag(db, appId, { name: 'smoke' });
  login = repo.createScenario(db, mod.id, {
    name: 'Login',
    priority: 'P1',
    steps: [{ type: 'api.request', params: { url: '/login' } }],
  }).id;
  checkout = repo.createScenario(db, mod.id, {
    name: 'Checkout',
    priority: 'P1',
    steps: [{ type: 'ui.navigate', params: { url: '/' } }],
  }).id;
  flaky = repo.createScenario(db, mod.id, {
    name: 'Search',
    priority: 'P3',
    steps: [{ type: 'ui.navigate', params: { url: '/' } }],
  }).id;
  repo.setScenarioTags(db, appId, login, [tag.id]);
});

describe('daily aggregates and home', () => {
  it('aggregates per day and builds a 30-day trend', () => {
    run(3, [
      [login, 'passed', 120],
      [checkout, 'failed', 800],
      [flaky, 'passed'],
    ]);
    run(3, [
      [login, 'passed', 100],
      [checkout, 'passed', 400],
      [flaky, 'failed'],
    ]);
    run(1, [
      [login, 'passed', 90],
      [checkout, 'passed', 300],
      [flaky, 'flaky'],
    ]);
    const daily = db
      .select()
      .from(schema.analyticsDaily)
      .all()
      .sort((a, b) => a.date.localeCompare(b.date));
    expect(daily.map((d) => [d.runs, d.tests, d.passed, d.failed, d.flaky])).toEqual([
      [2, 6, 4, 2, 0],
      [1, 3, 2, 0, 1],
    ]);
    expect(daily[0]!.p95ApiMs).toBe(800);
    // Rebuilding from scratch gives the same rows.
    db.delete(schema.analyticsDaily).run();
    expect(rebuildDaily(db)).toBe(2);
    expect(db.select().from(schema.analyticsDaily).all()).toHaveLength(2);

    const home = homeSummary(db);
    expect(home.kpis).toMatchObject({
      applications: 1,
      scenarios: 3,
      runsThisWeek: 3,
      passRate: 77.8,
      flakyRate: 11.1,
      openBugs: 0,
    });
    expect(home.trend).toHaveLength(30);
    expect(home.trend.at(-4)).toMatchObject({ runs: 2, passed: 4, failed: 2 });
    expect(home.trend.at(-2)).toMatchObject({ runs: 1, passed: 2, flaky: 1 });
    expect(home.gates).toEqual([
      expect.objectContaining({ application: 'Shop', status: 'unknown', gates: [] }),
    ]);
  });
});

describe('application analytics', () => {
  it('breaks results down and lists top failing, slowest and flaky tests', () => {
    for (let d = 6; d >= 1; d--)
      run(d, [
        [login, 'passed', 100 + d],
        [checkout, d % 2 ? 'failed' : 'passed'],
        [flaky, d === 2 ? 'flaky' : 'passed'],
      ]);
    const a = appAnalytics(db, appId, { days: 30 });
    expect(a.totals).toMatchObject({ tests: 18, runs: 6, failed: 3, flaky: 1 });
    expect(a.byModule).toEqual([expect.objectContaining({ key: 'Shop', total: 18, failed: 3 })]);
    expect(a.byLayer.map((g) => [g.key, g.failed])).toEqual([
      ['ui', 3],
      ['api', 0],
    ]);
    expect(a.byTag).toEqual([expect.objectContaining({ key: 'smoke', total: 6, passRate: 100 })]);
    expect(a.byEnvironment.map((g) => g.key)).toEqual(['Staging']);
    expect(a.failureCategories).toEqual([{ category: 'server_error', count: 3 }]);
    expect(a.topFailing[0]).toMatchObject({
      scenario: 'Checkout',
      failures: 3,
      runs: 6,
      lastError: 'The server crashed handling POST /api/orders (500)',
    });
    expect(a.slowest[0]).toMatchObject({ scenario: 'Checkout', avgMs: 9000 });
    // Checkout flips on every run (same version), Search passed only on retry once (1 of 6 runs).
    expect(a.flaky.map((f) => [f.scenario, f.score])).toEqual([
      ['Checkout', 1],
      ['Search', 0.17],
    ]);
    expect(a.perf.apiResponseTime).toHaveLength(6);
    expect(a.heatmap).toHaveLength(6);
  });

  it('does not call a test flaky when it changed between runs', () => {
    run(3, [[checkout, 'failed']]);
    db.update(schema.runItems).set({ scenarioVersion: 2 }).run();
    run(2, [[checkout, 'passed']]);
    run(1, [[checkout, 'failed']]);
    expect(flakyTests(itemFacts(db, { applicationId: appId }))).toEqual([]);
  });
});

describe('quality gates', () => {
  it('turns green, amber or red from real results', () => {
    const gateId = saveGate(db, appId, {
      name: 'Release',
      rules: [
        { kind: 'passRate', priority: 'P1', min: 100 },
        { kind: 'passRate', tag: 'smoke', min: 100 },
        { kind: 'openBugs', severity: 'critical', max: 0 },
        { kind: 'apiP95', maxMs: 500, level: 'warn' },
        { kind: 'loadP95', maxMs: 800, level: 'warn' },
      ],
    });
    const gate = () => ({
      id: gateId,
      name: 'Release',
      applicationId: appId,
      rules: db.select().from(schema.qualityGates).get()!.rulesJson as never[],
    });
    expect(evaluateGate(db, gate()).status).toBe('unknown');

    run(2, [
      [login, 'passed', 120],
      [checkout, 'passed', 300],
      [flaky, 'failed'],
    ]);
    let r = evaluateGate(db, gate());
    // P3 failure does not matter for the P1 rule; no load test → amber (unknown rule).
    expect(r.rules.map((x) => [x.label, x.passed, x.actual])).toEqual([
      ['Pass rate of P1 tests ≥ 100%', true, '100%'],
      ['Pass rate of tests tagged "smoke" ≥ 100%', true, '100%'],
      ['Open critical bugs ≤ 0', true, '0'],
      ['API p95 < 500 ms', true, '300 ms'],
      ['Load test p95 < 800 ms', null, '—'],
    ]);
    expect(r.status).toBe('amber');

    const { itemIds } = run(1, [
      [login, 'passed', 120],
      [checkout, 'failed', 900],
      [flaky, 'passed'],
    ]);
    db.insert(schema.loadResults)
      .values({
        id: newId(),
        runItemId: itemIds[0]!,
        profile: 'load',
        vus: 10,
        durationS: 30,
        rps: 50,
        p95: 450,
        errorRate: 0,
      })
      .run();
    r = evaluateGate(db, gate());
    expect(r.status).toBe('red');
    expect(r.rules[0]).toMatchObject({
      passed: false,
      actual: '50%',
      message: '50% of 2 tests passed (1 failing)',
    });
    expect(r.rules[3]).toMatchObject({ passed: false, actual: '900 ms' });
    expect(r.rules[4]).toMatchObject({ passed: true, actual: '450 ms' });

    repo.recordFailure(db, {
      applicationId: appId,
      runItemId: itemIds[1]!,
      scenarioId: checkout,
      testCaseId: null,
      failedStepId: 's1',
      category: 'server_error',
      title: 'Checkout crashes',
      summary: '',
      severity: 'critical',
      priority: 'P1',
      environment: {},
      preconditions: '',
      stepsToReproduce: [],
      expected: '',
      actual: '',
      diagnosis: null,
      owner: 'app',
    });
    expect(evaluateGate(db, gate()).rules[2]).toMatchObject({
      passed: false,
      actual: '1',
      message: '1 open: BUG-001',
    });
    expect(applicationGates(db, appId).status).toBe('red');
  });
});

describe('run comparison', () => {
  it('lists fixed, new and still failing tests and performance deltas', () => {
    const a = run(2, [
      [login, 'failed', 100],
      [checkout, 'failed', 400],
      [flaky, 'passed', 50],
    ]);
    const b = run(1, [
      [login, 'passed', 150],
      [checkout, 'failed', 200],
      [flaky, 'failed', 50],
    ]);
    const c = compareRuns(db, a.runId, b.runId);
    expect(c.fixed.map((x) => x.name)).toEqual(['Login']);
    expect(c.newFailures.map((x) => [x.name, x.before, x.after])).toEqual([['Search', 'passed', 'failed']]);
    expect(c.stillFailing.map((x) => x.name)).toEqual(['Checkout']);
    expect(c.perfDeltas).toEqual([
      { test: 'Checkout', metric: 'api.response_time', unit: 'ms', before: 400, after: 200, deltaPct: -50 },
      { test: 'Login', metric: 'api.response_time', unit: 'ms', before: 100, after: 150, deltaPct: 50 },
    ]);
    expect(c.base.passRate).toBe(33.3);
    expect(c.head.passRate).toBe(33.3);
  });
});
