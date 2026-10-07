import { schema } from '@stepforge/db';
import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { mkdtempSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AppContext } from '../src/context.ts';
import { H, testServer } from './helpers.ts';

let app: FastifyInstance;
let ctx: AppContext;
let target: Server;
let base = '';
let appId = '';
let envId = '';
let moduleId = '';

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
    if (req.url?.startsWith('/api/slow')) return void setTimeout(() => res.end('{"ok":true}'), 60);
    if (req.url?.startsWith('/api/private'))
      return void setTimeout(
        () => res.writeHead(req.headers.authorization === 'Bearer load-secret-123' ? 200 : 401).end(),
        15,
      );
    if (req.url === '/page')
      return void res
        .writeHead(200, { 'content-type': 'text/html' })
        .end('<!doctype html><title>P</title><h1>Hello</h1>');
    setTimeout(() => res.end('{"ok":true}'), 15);
  });
  await new Promise<void>((r) => target.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(target.address() as { port: number }).port}`;
  appId = (await ok('POST', '/api/applications', { name: 'Shop API', slug: 'shop-api' })).id;
  envId = (await ok('POST', `/api/applications/${appId}/environments`, { name: 'Local', baseUrl: base })).id;
  await ok('PUT', `/api/environments/${envId}/secrets`, { key: 'token', value: 'load-secret-123' });
  moduleId = (await ok('POST', `/api/applications/${appId}/modules`, { name: 'Performance' })).id;
}, 30_000);
afterAll(async () => {
  await app.close();
  target.close();
});

async function runScenario(name: string, steps: unknown[], options: Record<string, unknown> = {}) {
  const s = await ok<{ id: string }>('POST', `/api/modules/${moduleId}/scenarios`, { name, steps });
  const run = await ok<{ id: string }>('POST', '/api/runs', {
    applicationId: appId,
    environmentId: envId,
    scope: { type: 'scenarios', ids: [s.id] },
    options,
  });
  await ctx.runs.idle();
  const done = await ok<{ items: { id: string; status: string; errorMessage: string | null }[] }>(
    'GET',
    `/api/runs/${run.id}`,
  );
  const item = done.items[0]!;
  const detail = await ok<{
    steps: {
      type: string;
      status: string;
      message: string | null;
      responseJson: { perf?: Record<string, unknown>; assertions?: { message: string; passed: boolean }[] };
    }[];
    artifacts: { kind: string; path: string }[];
  }>('GET', `/api/run-items/${item.id}`);
  return { ...item, ...detail };
}

const loadStep = (thresholds: Record<string, number>) => ({
  type: 'perf.loadTest',
  params: { method: 'GET', url: '/api/slow', profile: 'load', vus: 3, durationS: 2, thresholds },
});

describe('load tests', () => {
  it('refuse to run until the application is confirmed as authorized', async () => {
    const r = await runScenario('Not authorized', [loadStep({ p95Ms: 1000 })]);
    expect(r.status).toBe('broken');
    expect(r.errorMessage).toMatch(/you own or are authorized to test this system/);
    expect(
      (await call('POST', `/api/applications/${appId}/load-authorization`, { confirm: false })).statusCode,
    ).toBe(400);
    const a = await ok<{ authorization: { at: string; statement: string } }>(
      'POST',
      `/api/applications/${appId}/load-authorization`,
      { confirm: true },
    );
    expect(a.authorization.statement).toBe('I own or am authorized to load-test this system.');
    expect(Date.parse(a.authorization.at)).toBeGreaterThan(Date.now() - 60_000);
  });

  it('produces a load test report with threshold verdicts (done-when)', async () => {
    const pass = await runScenario('Slow endpoint within limits', [
      loadStep({ p95Ms: 2000, maxErrorRatePct: 1, minRps: 5 }),
    ]);
    expect(pass.errorMessage).toBeNull();
    expect(pass.status).toBe('passed');
    const report = pass.steps[0]!.responseJson.perf as {
      kind: string;
      requests: number;
      latency: { p95: number };
      timeline: unknown[];
      thresholds: { metric: string; passed: boolean }[];
      passed: boolean;
    };
    expect(report).toMatchObject({ kind: 'load', engine: 'builtin', profile: 'load', passed: true });
    expect(report.requests).toBeGreaterThan(20);
    expect(report.latency.p95).toBeGreaterThanOrEqual(60);
    expect(report.timeline.length).toBeGreaterThanOrEqual(2);
    expect(report.thresholds.map((t) => [t.metric, t.passed])).toEqual([
      ['p95', true],
      ['errorRate', true],
      ['rps', true],
    ]);
    expect(pass.artifacts.map((a) => a.kind)).toContain('load_report');

    const fail = await runScenario('Slow endpoint too slow', [loadStep({ p95Ms: 30 })]);
    expect(fail.status).toBe('failed');
    expect(fail.errorMessage).toMatch(/^p95 latency \d+ ms exceeded the threshold of 30 ms by \d+ ms$/);

    // Stored for analytics: one load_results row per load step and metric rows with thresholds.
    const rows = ctx.db.select().from(schema.loadResults).all();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ profile: 'load', vus: 3 });
    const p95 = ctx.db
      .select()
      .from(schema.perfMetrics)
      .all()
      .filter((m) => m.metric === 'load.p95');
    expect(p95.map((m) => [m.threshold, m.passed])).toEqual([
      [2000, true],
      [30, false],
    ]);
  }, 60_000);

  it('runs from the Load Designer with live ticks, resolving secrets on the server', async () => {
    const ticks: unknown[] = [];
    ctx.bus.on('event', (e: { type: string }) => e.type === 'load.tick' && ticks.push(e));
    const { id } = await ok<{ id: string }>('POST', '/api/perf/load', {
      applicationId: appId,
      environmentId: envId,
      params: {
        requests: [
          { method: 'GET', url: '/api/private', auth: { type: 'bearer', token: '{{secret.token}}' } },
        ],
        profile: 'smoke',
        vus: 1,
        durationS: 2,
        thresholds: { maxErrorRatePct: 0 },
      },
    });
    expect((await ok<{ status: string }>('GET', `/api/perf/load/${id}`)).status).toBe('running');
    await ctx.perf.idle();
    const done = await ok<{
      status: string;
      report: { statusCodes: Record<string, number>; errors: number; thresholds: { passed: boolean }[] };
    }>('GET', `/api/perf/load/${id}`);
    expect(done.status).toBe('done');
    expect(Object.keys(done.report.statusCodes)).toEqual(['200']);
    expect(done.report.errors).toBe(0);
    expect(ticks.length).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(done)).not.toContain('load-secret-123');
  });

  it('exports a k6 script that never contains the secret', async () => {
    const { script } = await ok<{ script: string }>('POST', '/api/perf/k6-export', {
      environmentId: envId,
      name: 'Private API',
      params: {
        requests: [
          {
            method: 'POST',
            url: '/api/private',
            auth: { type: 'bearer', token: '{{secret.token}}' },
            body: { a: 1 },
          },
        ],
        profile: 'stress',
        vus: 10,
        durationS: 40,
        thresholds: { p95Ms: 500 },
      },
    });
    expect(script).toContain('`${BASE_URL}/api/private`');
    expect(script).toContain('Bearer ${__ENV.SECRET_TOKEN}');
    expect(script).toContain(`const BASE_URL = __ENV.BASE_URL || "${base}";`);
    expect(script).toContain('"p(95)<500"');
    expect(script).not.toContain('load-secret-123');
  });

  it('needs the application name to load-test a production environment', async () => {
    const prod = await ok('POST', `/api/applications/${appId}/environments`, {
      name: 'Prod',
      baseUrl: base,
      isProduction: true,
    });
    const body = {
      applicationId: appId,
      environmentId: prod.id,
      params: { requests: [{ url: '/api/slow' }], profile: 'smoke', vus: 1, durationS: 1 },
    };
    const refused = await call('POST', '/api/perf/load', body);
    expect(refused.statusCode).toBe(403);
    expect(refused.json().message).toMatch(/Type the application name \("Shop API"\)/);
    expect((await call('POST', '/api/perf/load', { ...body, confirm: 'Shop API' })).statusCode).toBe(202);
    await ctx.perf.idle();
  });
});

describe('page metrics and query plans in runs', () => {
  it('records Web Vitals after navigations and checks thresholds in a step', async () => {
    const r = await runScenario(
      'Page is fast',
      [
        { type: 'ui.navigate', params: { url: '/page' } },
        // Generous limits: this checks the step, not the machine (Windows CI paints a trivial page in 4–5 s).
        { type: 'perf.pageMetrics', params: { thresholds: { lcpMs: 60_000, cls: 0.1, ttfbMs: 10_000 } } },
      ],
      { pageMetrics: true },
    );
    expect(r.errorMessage).toBeNull();
    expect(r.steps[1]!.message).toMatch(/LCP \d+ ms, CLS 0, TTFB \d+ ms/);
    const metrics = ctx.db
      .select()
      .from(schema.perfMetrics)
      .all()
      .map((m) => m.metric);
    expect(metrics).toEqual(expect.arrayContaining(['page.lcp', 'page.ttfb', 'page.load']));
    // The navigate step itself also recorded metrics because of the run option.
    expect(r.steps[0]!.responseJson.perf).toMatchObject({ kind: 'pageMetrics' });
  }, 60_000);

  it('flags slow queries and full table scans', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'sf-plan-')), 'shop.db');
    const db = new Database(file);
    db.exec(
      'CREATE TABLE orders (id INTEGER PRIMARY KEY, email TEXT, total REAL); CREATE INDEX orders_total ON orders(total);',
    );
    const ins = db.prepare('INSERT INTO orders (email, total) VALUES (?, ?)');
    db.transaction(() => {
      for (let i = 0; i < 2000; i++) ins.run(`c${i}@x.test`, i);
    })();
    db.close();
    await ok('POST', `/api/environments/${envId}/connections`, {
      name: 'shop',
      engine: 'sqlite',
      database: file,
    });
    const r = await runScenario('Order lookups use indexes', [
      {
        type: 'perf.queryPlan',
        params: {
          connection: 'shop',
          sql: 'SELECT * FROM orders WHERE total > ?',
          params: [1990],
          maxMs: 500,
          noFullScan: true,
        },
        continueOnFail: true,
      },
      {
        type: 'perf.queryPlan',
        params: {
          connection: 'shop',
          sql: "SELECT * FROM orders WHERE email = 'c5@x.test'",
          maxMs: 500,
          noFullScan: true,
        },
      },
    ]);
    expect(r.steps.map((s) => s.status)).toEqual(['passed', 'failed']);
    expect(r.steps[0]!.responseJson.perf).toMatchObject({ kind: 'queryPlan', fullScans: [] });
    expect((r.steps[0]!.responseJson.perf as { plan: string[] }).plan.join('\n')).toMatch(/orders_total/);
    expect(r.errorMessage).toBe('Full table scan on orders (no index used)');
    const write = await runScenario('Plans only read', [
      { type: 'perf.queryPlan', params: { connection: 'shop', sql: 'DELETE FROM orders' } },
    ]);
    expect(write.status).toBe('broken');
    expect(write.errorMessage).toMatch(/only measures reads/);
  });

  it('runs Lighthouse on demand and serves the report', async () => {
    const r = await ok<{ scores: Record<string, number>; reportFile: string }>(
      'POST',
      '/api/perf/lighthouse',
      {
        environmentId: envId,
        url: '/page',
        categories: ['performance', 'best-practices'],
      },
    );
    expect(r.scores.performance).toBeGreaterThan(50);
    expect(r.reportFile).toMatch(/^lighthouse\/lh-.*\.html$/);
    const file = await call('GET', `/api/artifacts/files/${r.reportFile}`);
    expect(file.statusCode).toBe(200);
    expect(file.body).toContain('Lighthouse');
  }, 120_000);
});
