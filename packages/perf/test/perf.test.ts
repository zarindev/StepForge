import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  checkLighthouse,
  checkPageMetrics,
  collectPageMetrics,
  evaluateThresholds,
  findK6,
  k6Asset,
  LatencyHistogram,
  planStages,
  placeholderToEnv,
  runK6,
  runLighthouse,
  runLoadTest,
  toK6Script,
  validateLoadConfig,
  WEB_VITALS_INIT_SCRIPT,
} from '../src/index.ts';

let server: Server;
let base = '';
let hits = 0;
beforeAll(async () => {
  server = createServer((req, res) => {
    hits++;
    const url = req.url ?? '/';
    if (url.startsWith('/slow')) setTimeout(() => res.end('slow'), 120);
    // Every load target answers after a short delay so tests cannot saturate the CPU of a parallel test run.
    else if (url.startsWith('/flaky'))
      setTimeout(() => res.writeHead(hits % 4 === 0 ? 500 : 200).end('x'), 15);
    else if (url.startsWith('/echo')) {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () =>
        setTimeout(
          () =>
            res
              .writeHead(req.headers.authorization === 'Bearer t0k' && body.includes('"a":1') ? 201 : 401)
              .end(),
          15,
        ),
      );
    } else if (url === '/page')
      res
        .writeHead(200, { 'content-type': 'text/html' })
        .end(
          '<!doctype html><title>Perf page</title><h1 style="font-size:64px">Hello performance</h1><p>Some text content for LCP.</p>',
        );
    else setTimeout(() => res.end('ok'), 15);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => server.close());

describe('building blocks', () => {
  it('computes exact percentiles', () => {
    const h = new LatencyHistogram();
    for (let i = 1; i <= 100; i++) h.add(i);
    expect([h.percentile(50), h.percentile(95), h.percentile(99), h.max, h.mean]).toEqual([
      50, 95, 99, 100, 50.5,
    ]);
    expect(new LatencyHistogram().percentile(95)).toBe(0);
    // Sub-millisecond latencies keep 0.01 ms precision.
    const fast = new LatencyHistogram();
    [0.04, 0.05, 0.31, 0.9, 2.4].forEach((v) => fast.add(v));
    expect([fast.min, fast.percentile(50), fast.percentile(80), fast.max]).toEqual([0.04, 0.31, 0.9, 2.4]);
  });

  it('turns profiles into stages', () => {
    expect(planStages('smoke', 50, 120)).toEqual([{ vus: 1, durationS: 30 }]);
    expect(planStages('load', 20, 60, 10)).toEqual([
      { vus: 3, durationS: 2 },
      { vus: 7, durationS: 2 },
      { vus: 10, durationS: 2 },
      { vus: 13, durationS: 2 },
      { vus: 17, durationS: 2 },
      { vus: 20, durationS: 60 },
    ]);
    expect(planStages('stress', 10, 40).map((s) => s.vus)).toEqual([5, 10, 15, 20]);
    expect(planStages('spike', 50, 30)).toEqual([
      { vus: 5, durationS: 10 },
      { vus: 50, durationS: 10 },
      { vus: 5, durationS: 10 },
    ]);
  });

  it('validates limits and single-host requests', () => {
    const ok = {
      requests: [{ method: 'GET', url: `${base}/` }],
      profile: 'load' as const,
      vus: 5,
      durationS: 5,
    };
    expect(() => validateLoadConfig(ok)).not.toThrow();
    expect(() => validateLoadConfig({ ...ok, profile: 'stress', vus: 600 })).toThrow(
      /At most 1000 virtual users \(this profile peaks at 1200\)/,
    );
    expect(() =>
      validateLoadConfig({ ...ok, requests: [...ok.requests, { method: 'GET', url: 'http://other.test/' }] }),
    ).toThrow(/one host/);
  });

  it('judges thresholds with the margin', () => {
    const r = evaluateThresholds(
      {
        latency: { min: 1, avg: 50, p50: 40, p90: 80, p95: 900, p99: 1200, max: 1500 },
        errorRatePct: 2.5,
        rps: 40,
      },
      { p95Ms: 800, maxErrorRatePct: 1, minRps: 30 },
    );
    expect(r.map((x) => [x.metric, x.passed, x.message])).toEqual([
      ['p95', false, 'p95 latency 900 ms exceeded the threshold of 800 ms by 100 ms'],
      ['errorRate', false, 'Error rate 2.50 % exceeded the threshold of 1 % by 1.50 %'],
      ['rps', true, 'Throughput 40 req/s ≥ 30 req/s'],
    ]);
  });

  it('exports a k6 script with stages, thresholds and secrets as environment variables', () => {
    const script = toK6Script({
      name: 'Patients API',
      requests: [
        {
          method: 'post',
          url: '{{env.baseUrl}}/api/patients',
          headers: { authorization: 'Bearer {{secret.apiToken}}' },
          body: '{"name":"`x`"}',
        },
      ],
      profile: 'load',
      vus: 10,
      durationS: 30,
      rampS: 5,
      thresholds: { p95Ms: 800, maxErrorRatePct: 1 },
      baseUrl: 'http://127.0.0.1:8101',
    });
    expect(script).toContain("import http from 'k6/http';");
    expect(script).toContain('`${BASE_URL}/api/patients`');
    expect(script).toContain('"authorization": `Bearer ${__ENV.SECRET_API_TOKEN}`');
    expect(script).toContain('\\`x\\`'); // backticks in bodies are escaped
    expect(script).toContain('"p(95)<800"');
    expect(script).toContain('"rate<0.01"');
    expect(script).toContain('const BASE_URL = __ENV.BASE_URL || "http://127.0.0.1:8101";');
    expect(script).toContain('//   SECRET_API_TOKEN');
    expect(placeholderToEnv('vars.authToken')).toBe('VARS_AUTH_TOKEN');
    expect(k6Asset('win32', 'x64')).toBe('k6-v2.3.0-windows-amd64.zip');
  });
});

describe('built-in load engine (autocannon)', () => {
  it('produces a report with percentiles, a timeline and threshold verdicts', async () => {
    const ticks: number[] = [];
    const r = await runLoadTest(
      {
        requests: [{ method: 'GET', url: `${base}/slow` }],
        profile: 'load',
        vus: 4,
        durationS: 2,
        thresholds: { p95Ms: 100, maxErrorRatePct: 1, minRps: 5 },
      },
      { onTick: (t) => ticks.push(t.requests) },
    );
    expect(r.engine).toBe('builtin');
    expect(r.requests).toBeGreaterThan(20);
    expect(r.latency.p95).toBeGreaterThanOrEqual(120);
    expect(r.latency.p50).toBeLessThanOrEqual(r.latency.p95);
    expect(r.statusCodes['200']).toBe(r.requests);
    expect(r.timeline.length).toBeGreaterThanOrEqual(2);
    expect(ticks.length).toBe(r.timeline.length);
    expect(r.thresholds.map((t) => [t.metric, t.passed])).toEqual([
      ['p95', false],
      ['errorRate', true],
      ['rps', true],
    ]);
    expect(r.passed).toBe(false);
    expect(r.thresholds[0]!.message).toMatch(
      /^p95 latency \d+ ms exceeded the threshold of 100 ms by \d+ ms$/,
    );
  });

  it('counts HTTP errors, sends bodies and headers, and stops when cancelled', async () => {
    const flaky = await runLoadTest({
      requests: [{ method: 'GET', url: `${base}/flaky` }],
      profile: 'smoke',
      vus: 1,
      durationS: 1,
      thresholds: { maxErrorRatePct: 5 },
    });
    expect(flaky.errorRatePct).toBeGreaterThan(15);
    expect(flaky.statusCodes['500']).toBeGreaterThan(0);
    expect(flaky.passed).toBe(false);

    const echo = await runLoadTest({
      requests: [
        {
          method: 'POST',
          url: `${base}/echo`,
          headers: { authorization: 'Bearer t0k', 'content-type': 'application/json' },
          body: '{"a":1}',
        },
      ],
      profile: 'smoke',
      vus: 1,
      durationS: 1,
    });
    expect(Object.keys(echo.statusCodes)).toEqual(['201']);

    const ac = new AbortController();
    setTimeout(() => ac.abort(), 300);
    const started = Date.now();
    const cancelled = await runLoadTest(
      { requests: [{ method: 'GET', url: `${base}/` }], profile: 'soak', vus: 2, durationS: 30 },
      { signal: ac.signal },
    );
    expect(cancelled.cancelled).toBe(true);
    expect(Date.now() - started).toBeLessThan(5000);
  });
});

describe('page metrics and Lighthouse (real Chromium)', () => {
  it('collects Web Vitals without leaking a global into the page', async () => {
    const browser = await chromium.launch();
    try {
      const ctx = await browser.newContext();
      await ctx.addInitScript(WEB_VITALS_INIT_SCRIPT);
      const page = await ctx.newPage();
      await page.goto(`${base}/page`);
      const m = await collectPageMetrics(page);
      expect(m.url).toBe(`${base}/page`);
      expect(m.lcp).toBeGreaterThan(0);
      expect(m.fcp).toBeGreaterThan(0);
      expect(m.ttfb).toBeGreaterThanOrEqual(0);
      expect(m.load).toBeGreaterThan(0);
      expect(m.cls).toBe(0);
      expect(await page.evaluate("'webVitals' in window")).toBe(false);
      const { rows, failures } = checkPageMetrics(m, { lcpMs: 5000, cls: 0.1, inpMs: 200, loadMs: 1 });
      expect(rows.find((r) => r.metric === 'page.lcp')).toMatchObject({ threshold: 5000, passed: true });
      expect(failures).toEqual([
        'INP was not reported (INP needs an interaction on the page first)',
        expect.stringMatching(/^Load time \d+ ms exceeded the threshold of 1 ms by \d+ ms$/),
      ]);
    } finally {
      await browser.close();
    }
  }, 30_000);

  it('runs Lighthouse with Playwright’s Chromium and saves the HTML report', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sf-lh-'));
    const r = await runLighthouse({
      url: `${base}/page`,
      chromePath: chromium.executablePath(),
      categories: ['performance', 'seo'],
      outputDir: dir,
    });
    expect(r.scores.performance).toBeGreaterThanOrEqual(80);
    expect(r.scores.seo).toBeGreaterThan(0);
    expect(r.metrics.lcp).toBeGreaterThan(0);
    expect(existsSync(r.reportPath!)).toBe(true);
    expect(readFileSync(r.reportPath!, 'utf8')).toContain('Lighthouse');
    const { failures } = checkLighthouse(r, { performance: 50, seo: 101, accessibility: 90 });
    expect(failures).toEqual([
      'Accessibility score was not measured',
      expect.stringMatching(/^SEO score \d+ is below the minimum of 101/),
    ]);
  }, 120_000);
});

// k6 is optional: set STEPFORGE_K6_PATH, put it in data/bin, or install it from Settings → Performance.
const K6 = findK6({ binDir: resolve(import.meta.dirname, '../../../data/bin') });
describe.skipIf(!K6)('k6 bridge (real k6 binary)', () => {
  it('runs the same test with k6 and reports thresholds, keeping secrets out of the script on disk', async () => {
    const r = await runK6(K6!, {
      requests: [
        { method: 'GET', url: `${base}/slow`, headers: { authorization: 'Bearer s3cret-in-env-only' } },
      ],
      profile: 'smoke',
      vus: 1,
      durationS: 2,
      thresholds: { p95Ms: 1000, p99Ms: 50 },
    });
    expect(r.engine).toBe('k6');
    expect(r.requests).toBeGreaterThan(5);
    expect(r.latency.p95).toBeGreaterThanOrEqual(120);
    expect(r.thresholds.map((t) => [t.metric, t.passed])).toEqual([
      ['p95', true],
      ['p99', false],
    ]);
  }, 60_000);

  it('runs an exported k6 script as-is', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sf-k6-export-'));
    const file = join(dir, 'script.js');
    writeFileSync(
      file,
      toK6Script({
        requests: [{ method: 'GET', url: '{{env.baseUrl}}/' }],
        profile: 'smoke',
        vus: 1,
        durationS: 2,
        thresholds: { p95Ms: 500 },
        baseUrl: base,
      }),
    );
    const { spawnSync } = await import('node:child_process');
    const run = spawnSync(K6!, ['run', '--quiet', '--no-usage-report', file], {
      encoding: 'utf8',
      timeout: 60_000,
      // Vitest sets BASE_URL=/ (a Vite convention); a normal shell would not, so the script's default applies.
      env: { ...process.env, BASE_URL: undefined },
    });
    expect(run.status, run.stderr).toBe(0);
  }, 60_000);
});
