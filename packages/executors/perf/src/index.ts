import {
  StepError,
  type ArtifactRef,
  type AssertionResult,
  type Executor,
  type ExecutorSession,
  type RunnableStep,
  type StepContext,
  type StepOutcome,
} from '@stepforge/core';
import {
  checkPolicy,
  explainQuery,
  ManagedConnection,
  type ConnectionResolver,
  type QueryPlan,
} from '@stepforge/executor-db';
import {
  checkLighthouse,
  checkPageMetrics,
  collectPageMetrics,
  LOAD_PROFILES,
  runK6,
  runLighthouse,
  runLoadTest,
  type LighthouseCategory,
  type LighthouseThresholds,
  type LoadConfig,
  type LoadProfile,
  type LoadReport,
  type LoadRequest,
  type LoadThresholds,
  type LoadTick,
  type PageThresholds,
} from '@stepforge/perf';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** What the host provides. */
export type PerfHost = {
  /** Throws (with a message for the user) when load tests are not allowed for this application. */
  authorizeLoad?: () => void | Promise<void>;
  /** Set when the run's environment is a production environment. */
  production?: { applicationName: string };
  resolveConnection?: ConnectionResolver;
  /** Chrome/Chromium for Lighthouse (Playwright's Chromium). */
  chromePath?: () => string;
  k6Path?: () => string | null;
  onLoadTick?: (tick: LoadTick & { stepId: string }) => void;
};

type SharedPage = Parameters<typeof collectPageMetrics>[0] & {
  goto(url: string, opts: { timeout: number; waitUntil: 'load' }): Promise<unknown>;
};

const num = (v: unknown) => (v === undefined || v === null || v === '' ? undefined : Number(v));

function thresholdAssertions(failures: string[], passedSummary: string): AssertionResult[] {
  return failures.length
    ? failures.map((message) => ({ target: 'threshold', operator: 'lte', passed: false, message }))
    : [{ target: 'thresholds', operator: 'lte', passed: true, message: passedSummary }];
}

/** Turns step params into load-test requests (one request, or a list from an API step group). */
export function loadRequests(p: Record<string, unknown>, baseUrl?: string): LoadRequest[] {
  const raw =
    Array.isArray(p.requests) && p.requests.length ? (p.requests as Record<string, unknown>[]) : [p];
  return raw.map((r, i) => {
    if (!r.url) throw new StepError('invalid_params', `Load request ${i + 1} needs a "url"`);
    let url: string;
    try {
      url = new URL(String(r.url), baseUrl).toString();
    } catch {
      throw new StepError('invalid_params', `Load request ${i + 1}: "${String(r.url)}" is not a valid URL`);
    }
    const headers: Record<string, string> = { ...((r.headers as Record<string, string>) ?? {}) };
    const auth = r.auth as
      | {
          type?: string;
          token?: string;
          username?: string;
          password?: string;
          in?: string;
          name?: string;
          value?: string;
        }
      | undefined;
    if (auth?.type === 'bearer') headers.authorization = `Bearer ${auth.token ?? ''}`;
    else if (auth?.type === 'basic')
      headers.authorization = `Basic ${Buffer.from(`${auth.username ?? ''}:${auth.password ?? ''}`).toString('base64')}`;
    else if (auth?.type === 'apiKey' && (auth.in ?? 'header') === 'header')
      headers[auth.name ?? 'x-api-key'] = auth.value ?? '';
    else if (auth?.type && auth.type !== 'none')
      throw new StepError(
        'invalid_params',
        `Load tests support bearer, basic and apiKey (header) auth, not "${auth.type}"`,
      );
    let body: string | undefined;
    if (r.body !== undefined && r.body !== null && r.body !== '') {
      body = typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
      if (typeof r.body !== 'string' && !Object.keys(headers).some((h) => h.toLowerCase() === 'content-type'))
        headers['content-type'] = 'application/json';
    }
    return {
      method: String(r.method ?? 'GET').toUpperCase(),
      url,
      headers,
      ...(body !== undefined && { body }),
    };
  });
}

export function loadConfigFromParams(p: Record<string, unknown>, baseUrl?: string): LoadConfig {
  const profile = String(p.profile ?? 'load') as LoadProfile;
  if (!LOAD_PROFILES.includes(profile))
    throw new StepError('invalid_params', `Unknown load profile "${profile}" (${LOAD_PROFILES.join(', ')})`);
  return {
    requests: loadRequests(p, baseUrl),
    profile,
    vus: Number(p.vus ?? 10),
    durationS: Number(p.durationS ?? 30),
    rampS: num(p.rampS),
    thresholds: (p.thresholds as LoadThresholds) ?? {},
    timeoutS: num(p.requestTimeoutS),
  };
}

class PerfSession implements ExecutorSession {
  private artifacts: ArtifactRef[] = [];
  constructor(private readonly host: PerfHost) {}

  async execute(step: RunnableStep, ctx: StepContext): Promise<StepOutcome> {
    const p = step.params as Record<string, unknown>;
    try {
      switch (step.type) {
        case 'perf.pageMetrics':
          return await this.pageMetrics(p, ctx);
        case 'perf.lighthouse':
          return await this.lighthouse(p, step, ctx);
        case 'perf.loadTest':
          return await this.loadTest(p, step, ctx);
        case 'perf.queryPlan':
          return await this.queryPlan(p);
        default:
          throw new StepError('unsupported', `Unknown performance step "${step.type}"`);
      }
    } catch (err) {
      if (err instanceof StepError) throw err;
      const e = err as Error & { code?: string };
      if (e.name === 'DbError')
        throw new StepError(
          e.code === 'connection' ? 'network' : e.code === 'query' ? 'assertion' : 'invalid_params',
          e.message,
        );
      throw new StepError('unknown', e.message);
    }
  }

  private async pageMetrics(p: Record<string, unknown>, ctx: StepContext): Promise<StepOutcome> {
    const page = ctx.shared.get('ui.page') as SharedPage | undefined;
    if (!page)
      throw new StepError(
        'invalid_params',
        'perf.pageMetrics measures the browser page: add a ui.navigate step before it',
      );
    if (p.url)
      await page.goto(new URL(String(p.url), ctx.options.baseUrl).toString(), {
        timeout: ctx.timeoutMs,
        waitUntil: 'load',
      });
    const m = await collectPageMetrics(page, { settleMs: num(p.settleMs), timeoutMs: ctx.timeoutMs });
    const { rows, failures } = checkPageMetrics(m, (p.thresholds as PageThresholds) ?? {});
    const parts = [
      m.lcp !== undefined && `LCP ${m.lcp} ms`,
      m.cls !== undefined && `CLS ${m.cls}`,
      m.ttfb !== undefined && `TTFB ${m.ttfb} ms`,
      m.load !== undefined && `load ${m.load} ms`,
    ].filter(Boolean);
    return {
      message: `${m.url}: ${parts.join(', ') || 'no metrics reported'}`,
      output: m,
      perf: { kind: 'pageMetrics', metrics: m, thresholds: p.thresholds ?? {} },
      metrics: rows,
      assertions: Object.keys((p.thresholds as object) ?? {}).length
        ? thresholdAssertions(failures, 'All page metrics within their thresholds')
        : [],
      getTarget: (t) => (m as Record<string, unknown>)[t],
    };
  }

  private async lighthouse(
    p: Record<string, unknown>,
    step: RunnableStep,
    ctx: StepContext,
  ): Promise<StepOutcome> {
    if (!this.host.chromePath) throw new StepError('unsupported', 'Lighthouse is not available in this host');
    const url = new URL(String(p.url ?? '/'), ctx.options.baseUrl).toString();
    const r = await runLighthouse({
      url,
      chromePath: this.host.chromePath(),
      categories: Array.isArray(p.categories) ? (p.categories as LighthouseCategory[]) : undefined,
      formFactor: p.formFactor === 'mobile' ? 'mobile' : 'desktop',
      outputDir: join(ctx.artifactsDir, 'lighthouse'),
      reportName: `lighthouse-${String(step.position + 1).padStart(2, '0')}`,
    });
    if (r.reportPath) this.artifacts.push({ kind: 'lighthouse', path: r.reportPath, stepId: step.id });
    const { rows, failures } = checkLighthouse(r, (p.thresholds as LighthouseThresholds) ?? {});
    return {
      message: `Lighthouse ${Object.entries(r.scores)
        .map(([k, v]) => `${k} ${v}`)
        .join(' · ')}`,
      output: r.scores,
      perf: { kind: 'lighthouse', ...r, reportPath: undefined },
      metrics: rows,
      assertions: Object.keys((p.thresholds as object) ?? {}).length
        ? thresholdAssertions(failures, 'All Lighthouse scores meet their minimums')
        : [],
      getTarget: (t) => r.scores[t as LighthouseCategory] ?? (r.metrics as Record<string, unknown>)[t],
    };
  }

  private async loadTest(
    p: Record<string, unknown>,
    step: RunnableStep,
    ctx: StepContext,
  ): Promise<StepOutcome> {
    if (this.host.authorizeLoad) {
      try {
        await this.host.authorizeLoad();
      } catch (err) {
        throw new StepError('invalid_params', (err as Error).message);
      }
    }
    if (
      this.host.production &&
      String(p.confirmProduction ?? '').trim() !== this.host.production.applicationName
    )
      throw new StepError(
        'invalid_params',
        `Blocked: this run targets a production environment. Set "confirmProduction" to the application name ("${this.host.production.applicationName}") to load-test it.`,
      );
    const config = loadConfigFromParams(p, ctx.options.baseUrl);
    let report: LoadReport;
    try {
      if (p.engine === 'k6') {
        const k6 = this.host.k6Path?.();
        if (!k6)
          throw new StepError(
            'invalid_params',
            'k6 is not installed (Settings → Performance), or use the built-in engine',
          );
        report = await runK6(k6, config, { signal: ctx.signal });
      } else {
        report = await runLoadTest(config, {
          signal: ctx.signal,
          onTick: (t) => this.host.onLoadTick?.({ ...t, stepId: step.id }),
        });
      }
    } catch (err) {
      if (err instanceof StepError) throw err;
      throw new StepError('invalid_params', (err as Error).message);
    }
    if (report.cancelled) throw new StepError('aborted', 'Load test cancelled');
    const dir = join(ctx.artifactsDir, 'load');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `load-${String(step.position + 1).padStart(2, '0')}.json`);
    writeFileSync(path, JSON.stringify(report, null, 2));
    this.artifacts.push({ kind: 'load_report', path, stepId: step.id });
    const metric = (name: string, value: number, unit: string, key: string) => {
      const t = report.thresholds.find((x) => x.metric === key);
      return { metric: name, value, unit, ...(t && { threshold: t.threshold, passed: t.passed }) };
    };
    return {
      message: `${report.requests} requests, ${report.rps} req/s, p95 ${report.latency.p95} ms, ${report.errorRatePct}% errors (${report.engine}, ${report.profile})`,
      output: {
        rps: report.rps,
        p95: report.latency.p95,
        p99: report.latency.p99,
        errorRatePct: report.errorRatePct,
        passed: report.passed,
      },
      perf: { kind: 'load', ...report },
      metrics: [
        metric('load.p95', report.latency.p95, 'ms', 'p95'),
        metric('load.p99', report.latency.p99, 'ms', 'p99'),
        metric('load.avg', report.latency.avg, 'ms', 'avg'),
        metric('load.rps', report.rps, 'req/s', 'rps'),
        metric('load.error_rate', report.errorRatePct, '%', 'errorRate'),
      ],
      assertions: report.thresholds.map((t) => ({
        target: t.metric,
        operator: t.metric === 'rps' ? 'gte' : 'lt',
        expected: t.threshold,
        actual: t.actual,
        passed: t.passed,
        message: t.message,
      })),
      getTarget: (t) =>
        ({
          rps: report.rps,
          p50: report.latency.p50,
          p90: report.latency.p90,
          p95: report.latency.p95,
          p99: report.latency.p99,
          avg: report.latency.avg,
          max: report.latency.max,
          errorRate: report.errorRatePct,
          requests: report.requests,
        })[t],
    };
  }

  private async queryPlan(p: Record<string, unknown>): Promise<StepOutcome> {
    if (!this.host.resolveConnection)
      throw new StepError('unsupported', 'Query plans need database connections');
    const sql = String(p.sql ?? '').trim();
    if (!sql) throw new StepError('invalid_params', 'perf.queryPlan needs a SELECT query');
    let cfg;
    try {
      cfg = await this.host.resolveConnection(String(p.connection ?? ''));
    } catch (err) {
      throw new StepError('invalid_params', (err as Error).message);
    }
    await checkPolicy({ ...cfg, readOnly: true }, sql).catch((err: Error) => {
      throw new StepError(
        'invalid_params',
        `perf.queryPlan only measures reads: ${err.message.replace(/^Blocked: /, '')}`,
      );
    });
    const conn = await ManagedConnection.open({ ...cfg, readOnly: true });
    try {
      const params = Array.isArray(p.params) ? p.params : [];
      let plan: QueryPlan | undefined;
      let planNote: string | undefined;
      try {
        plan = await explainQuery(conn.client, sql, params);
      } catch (err) {
        if ((err as Error & { code?: string }).code !== 'unsupported') throw err;
        planNote = (err as Error).message;
      }
      const repeat = Math.min(Math.max(Number(p.repeat ?? 3), 1), 20);
      const times: number[] = [];
      let rowCount = 0;
      for (let i = 0; i < repeat; i++) {
        const t0 = performance.now();
        const r = await conn.client.query(sql, params, { maxRows: 1 });
        times.push(performance.now() - t0);
        rowCount = r.rowCount;
      }
      const median = Math.round([...times].sort((a, b) => a - b)[Math.floor(times.length / 2)]! * 10) / 10;
      const maxMs = num(p.maxMs);
      const assertions: AssertionResult[] = [];
      if (maxMs !== undefined)
        assertions.push({
          target: 'durationMs',
          operator: 'lt',
          expected: maxMs,
          actual: median,
          passed: median < maxMs,
          message:
            median < maxMs
              ? `Query took ${median} ms (< ${maxMs} ms)`
              : `Query took ${median} ms, over the ${maxMs} ms limit by ${Math.round((median - maxMs) * 10) / 10} ms`,
        });
      if (p.noFullScan === true && plan)
        assertions.push({
          target: 'fullScans',
          operator: 'isEmpty',
          actual: plan.fullScans,
          passed: plan.fullScans.length === 0,
          message: plan.fullScans.length
            ? `Full table scan on ${plan.fullScans.join(', ')} (no index used)`
            : 'No full table scans',
        });
      return {
        message: `${cfg.name}: ${median} ms (median of ${repeat})${plan?.fullScans.length ? `, full scan on ${plan.fullScans.join(', ')}` : ''}`,
        output: { durationMs: median, fullScans: plan?.fullScans ?? [], plan: plan?.lines ?? [] },
        perf: {
          kind: 'queryPlan',
          connection: cfg.name,
          engine: cfg.engine,
          sql,
          durationMs: median,
          runs: times.map((t) => Math.round(t * 10) / 10),
          rowCount,
          plan: plan?.lines ?? [],
          fullScans: plan?.fullScans ?? [],
          note: planNote,
        },
        metrics: [
          {
            metric: 'db.query_ms',
            value: median,
            unit: 'ms',
            ...(maxMs !== undefined && { threshold: maxMs, passed: median < maxMs }),
          },
        ],
        assertions,
        getTarget: (t) =>
          t === 'durationMs'
            ? median
            : t === 'fullScans'
              ? (plan?.fullScans ?? [])
              : t === 'rowCount'
                ? rowCount
                : undefined,
      };
    } finally {
      await conn.close();
    }
  }

  async close(): Promise<ArtifactRef[]> {
    return this.artifacts;
  }
}

export function createPerfExecutor(host: PerfHost = {}): Executor {
  return {
    group: 'perf',
    async createSession() {
      return new PerfSession(host);
    },
  };
}
