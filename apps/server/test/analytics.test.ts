import type { FastifyInstance } from 'fastify';
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AppContext } from '../src/context.ts';
import { H, testServer } from './helpers.ts';

let app: FastifyInstance;
let ctx: AppContext;
let target: Server;
let appId = '';
let envId = '';
let alternate = 0;
let broken = true;

async function call(method: string, url: string, payload?: unknown) {
  return app.inject({
    method: method as 'GET',
    url,
    headers: H,
    ...(payload !== undefined && { payload: payload as object }),
  });
}
async function ok<T = Record<string, unknown> & { id: string }>(
  method: string,
  url: string,
  payload?: unknown,
): Promise<T> {
  const res = await call(method, url, payload);
  if (res.statusCode >= 300) throw new Error(`${method} ${url} → ${res.statusCode}: ${res.body}`);
  return (res.body ? res.json() : undefined) as T;
}

beforeAll(async () => {
  ({ app, ctx } = await testServer());
  target = createServer((req, res) => {
    if (req.url === '/api/stable')
      return void res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
    if (req.url === '/api/alternate') return void res.writeHead(alternate++ % 2 ? 500 : 200).end('{}');
    if (req.url === '/api/orders')
      return void res
        .writeHead(broken ? 500 : 201, { 'content-type': 'application/json' })
        .end('{"message":"boom"}');
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => target.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(target.address() as { port: number }).port}`;
  appId = (await ok('POST', '/api/applications', { name: 'Shop', slug: 'shop' })).id;
  envId = (await ok('POST', `/api/applications/${appId}/environments`, { name: 'Staging', baseUrl: base }))
    .id;
  const mod = await ok('POST', `/api/applications/${appId}/modules`, { name: 'Checkout' });
  const tag = await ok('POST', `/api/applications/${appId}/tags`, { name: 'smoke' });
  const scenario = async (name: string, priority: string, url: string, status = 200, tags: string[] = []) => {
    const s = await ok('POST', `/api/modules/${mod.id}/scenarios`, {
      name,
      priority,
      steps: [
        {
          type: 'api.request',
          params: { method: url.includes('orders') ? 'POST' : 'GET', url },
          assertions: [{ target: 'status', operator: 'equals', expected: status }],
        },
      ],
    });
    if (tags.length) await ok('PUT', `/api/scenarios/${s.id}/tags`, { tagIds: tags });
    return s;
  };
  await scenario('Catalogue loads', 'P1', '/api/stable', 200, [tag.id]);
  await scenario('Search results', 'P3', '/api/alternate');
  await scenario('Place an order', 'P1', '/api/orders', 201);
}, 30_000);
afterAll(async () => {
  await app.close();
  target.close();
});

async function runAll() {
  const r = await ok<{ id: string }>('POST', '/api/runs', {
    applicationId: appId,
    environmentId: envId,
    scope: { type: 'application' },
  });
  await ctx.runs.idle();
  return ok<{ id: string; status: string; qualityGateJson: { status: string } | null }>(
    'GET',
    `/api/runs/${r.id}`,
  );
}

describe('analytics from real runs (done-when)', () => {
  let first = '';
  let last = '';

  it('fills the home dashboard, gates and application analytics', async () => {
    expect(
      (await ok<{ kpis: { runsThisWeek: number } }>('GET', '/api/analytics/home')).kpis.runsThisWeek,
    ).toBe(0);
    await ok('POST', `/api/applications/${appId}/quality-gates`, { preset: 'default' });

    first = (await runAll()).id;
    await runAll();
    broken = false; // the order bug gets fixed
    const fixedRun = await runAll();
    last = (await runAll()).id;
    expect(fixedRun.qualityGateJson?.status).toBeDefined();

    const home = await ok<{
      kpis: {
        applications: number;
        scenarios: number;
        runsThisWeek: number;
        passRate: number;
        flakyRate: number;
        openBugs: number;
        avgDurationMs: number;
      };
      trend: { date: string; runs: number; passed: number; failed: number }[];
      gates: {
        application: string;
        status: string;
        gates: { name: string; rules: { label: string; passed: boolean | null }[] }[];
      }[];
      recentRuns: { id: string }[];
    }>('GET', '/api/analytics/home');
    expect(home.kpis).toMatchObject({ applications: 1, scenarios: 3, runsThisWeek: 4, openBugs: 2 });
    // 12 results: Catalogue 4×pass, Search 2×pass 2×fail, Order 2×fail 2×pass → 8/12.
    expect(home.kpis.passRate).toBe(66.7);
    expect(home.kpis.avgDurationMs).toBeGreaterThan(0);
    const today = home.trend.at(-1)!;
    expect(today).toMatchObject({ runs: 4, passed: 8, failed: 4 });
    expect(home.recentRuns[0]!.id).toBe(last);
    // Release readiness: P1 tests all pass in the latest run, but critical bugs are open → red.
    const gate = home.gates[0]!;
    expect(gate.application).toBe('Shop');
    expect(gate.gates[0]!.name).toBe('Release readiness');
    expect(gate.gates[0]!.rules.find((r) => r.label === 'Pass rate of P1 tests ≥ 100%')!.passed).toBe(true);

    const a = await ok<{
      totals: { tests: number; runs: number; failed: number };
      byLayer: { key: string }[];
      byTag: { key: string; passRate: number }[];
      failureCategories: { category: string; count: number }[];
      topFailing: {
        scenario: string;
        failures: number;
        lastItemId: string;
        lastRunId: string;
        lastError: string;
      }[];
      flaky: { scenario: string; score: number; history: string[] }[];
      perf: { apiResponseTime: unknown[] };
      heatmap: { runs: number }[];
    }>('GET', `/api/applications/${appId}/analytics?days=30`);
    expect(a.totals).toMatchObject({ tests: 12, runs: 4, failed: 4 });
    expect(a.byLayer.map((g) => g.key)).toEqual(['api']);
    expect(a.byTag).toEqual([expect.objectContaining({ key: 'smoke', passRate: 100 })]);
    // Every failure was a 500 from the server.
    expect(a.failureCategories).toEqual([{ category: 'server_error', count: 4 }]);
    expect(a.topFailing.map((t) => [t.scenario, t.failures]).sort()).toEqual([
      ['Place an order', 2],
      ['Search results', 2],
    ]);
    // Drill-down: the failing item and its run are linked.
    const item = await ok<{ diagnosisJson: { title: string } }>(
      'GET',
      `/api/run-items/${a.topFailing[0]!.lastItemId}`,
    );
    expect(item.diagnosisJson.title).toBeTruthy();
    // Search flips on every run without being edited → flaky. Place an order failed then passed for good → not flaky.
    expect(a.flaky.map((f) => f.scenario)).toEqual(['Search results']);
    expect(a.flaky[0]!.history).toEqual(['passed', 'failed', 'passed', 'failed']);
    expect(a.perf.apiResponseTime).toHaveLength(1);
    expect(a.heatmap).toEqual([expect.objectContaining({ runs: 4 })]);
  }, 60_000);

  it('compares two runs', async () => {
    const c = await ok<{
      fixed: { name: string }[];
      newFailures: { name: string }[];
      stillFailing: { name: string }[];
      stillPassing: number;
    }>('GET', `/api/runs/compare?base=${first}&head=${last}`);
    expect(c.fixed.map((x) => x.name)).toEqual(['Place an order']);
    expect(c.newFailures.map((x) => x.name)).toEqual(['Search results']);
    expect(c.stillFailing).toEqual([]);
    expect(c.stillPassing).toBe(1);
    expect((await call('GET', '/api/runs/compare?base=nope&head=nope2')).statusCode).toBe(404);
  });

  it('manages gates', async () => {
    const g = await ok<{ definitions: { id: string; name: string }[] }>(
      'GET',
      `/api/applications/${appId}/quality-gates`,
    );
    const id = g.definitions[0]!.id;
    await ok('PUT', `/api/quality-gates/${id}`, {
      name: 'Smoke only',
      rules: [{ kind: 'passRate', tag: 'smoke', min: 100 }],
    });
    const after = await ok<{ status: string; gates: { name: string; rules: { message: string }[] }[] }>(
      'GET',
      `/api/applications/${appId}/quality-gates`,
    );
    expect(after.status).toBe('green');
    expect(after.gates[0]!.rules[0]!.message).toBe('100% of 1 tests passed');
    expect(
      (
        await call('POST', `/api/applications/${appId}/quality-gates`, {
          name: 'x',
          rules: [{ kind: 'nope' }],
        })
      ).statusCode,
    ).toBe(400);
    expect((await call('DELETE', `/api/quality-gates/${id}`)).statusCode).toBe(204);
  });
});
