import autocannon from 'autocannon';
import { LatencyHistogram } from './histogram.ts';

export const LOAD_PROFILES = ['smoke', 'load', 'stress', 'spike', 'soak'] as const;
export type LoadProfile = (typeof LOAD_PROFILES)[number];

export const PROFILE_HELP: Record<LoadProfile, string> = {
  smoke: '1 virtual user for a short time: does it work at all under a load test?',
  load: 'Ramp up to the target users and hold: normal expected traffic.',
  stress: 'Step up to twice the target users: where does it start to break?',
  spike: 'Quiet, then a sudden burst to the target users, then quiet again.',
  soak: 'Hold the target users for a long time: leaks and slow degradation.',
};

/** Hard limits: StepForge runs on your own machine, which is the bottleneck long before these. */
export const LOAD_LIMITS = { maxVus: 1000, maxDurationS: 3600 };

export type LoadRequest = {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: string;
};

export type LoadThresholds = {
  /** 95th percentile latency must be below this (ms). */
  p95Ms?: number;
  p99Ms?: number;
  avgMs?: number;
  /** Failed requests (HTTP ≥ 400, timeouts, connection errors) must stay below this percentage. */
  maxErrorRatePct?: number;
  /** Throughput must reach at least this many requests per second. */
  minRps?: number;
};

export type LoadConfig = {
  requests: LoadRequest[];
  profile: LoadProfile;
  /** Target number of virtual users (concurrent connections). */
  vus: number;
  durationS: number;
  /** Ramp-up time for the `load` profile. */
  rampS?: number;
  thresholds?: LoadThresholds;
  /** Per-request timeout. */
  timeoutS?: number;
};

export type Stage = { vus: number; durationS: number };
export type TimelinePoint = {
  t: number;
  vus: number;
  requests: number;
  errors: number;
  p95: number;
  avg: number;
};
export type ThresholdResult = {
  metric: 'p95' | 'p99' | 'avg' | 'errorRate' | 'rps';
  label: string;
  threshold: number;
  actual: number;
  unit: string;
  passed: boolean;
  message: string;
};

export type LoadReport = {
  engine: 'builtin' | 'k6';
  profile: LoadProfile;
  vus: number;
  durationS: number;
  stages: Stage[];
  target: string;
  startedAt: string;
  finishedAt: string;
  requests: number;
  errors: number;
  /** 0–100. */
  errorRatePct: number;
  rps: number;
  latency: { min: number; avg: number; p50: number; p90: number; p95: number; p99: number; max: number };
  statusCodes: Record<string, number>;
  /** One point per second. */
  timeline: TimelinePoint[];
  thresholds: ThresholdResult[];
  passed: boolean;
  /** Set when the run was stopped early. */
  cancelled?: boolean;
};

export type LoadTick = {
  t: number;
  vus: number;
  requests: number;
  errors: number;
  p95: number;
  avg: number;
  totalRequests: number;
};

/** How a profile becomes stages of constant concurrency. Durations add up to `durationS` (plus ramp for `load`). */
export function planStages(profile: LoadProfile, vus: number, durationS: number, rampS = 0): Stage[] {
  const v = Math.max(1, Math.round(vus));
  const d = Math.max(1, Math.round(durationS));
  const part = (n: number) => Math.max(1, Math.round(d / n));
  switch (profile) {
    case 'smoke':
      return [{ vus: 1, durationS: Math.min(d, 30) }];
    case 'load': {
      const ramp = Math.max(0, Math.round(rampS));
      const steps = ramp > 0 ? Math.min(ramp, 5) : 0;
      const rampStages = Array.from({ length: steps }, (_, i) => ({
        vus: Math.max(1, Math.round((v * (i + 1)) / (steps + 1))),
        durationS: Math.max(1, Math.round(ramp / steps)),
      }));
      return [...rampStages, { vus: v, durationS: d }];
    }
    case 'stress':
      return [0.5, 1, 1.5, 2].map((f) => ({ vus: Math.max(1, Math.round(v * f)), durationS: part(4) }));
    case 'spike': {
      const low = Math.max(1, Math.round(v / 10));
      return [
        { vus: low, durationS: part(3) },
        { vus: v, durationS: part(3) },
        { vus: low, durationS: part(3) },
      ];
    }
    case 'soak':
      return [{ vus: v, durationS: d }];
  }
}

export function validateLoadConfig(c: LoadConfig): void {
  if (!c.requests.length) throw new Error('A load test needs at least one request');
  const origins = new Set(c.requests.map((r) => new URL(r.url).origin));
  if (origins.size > 1)
    throw new Error(`All requests of a load test must go to one host (found ${[...origins].join(', ')})`);
  const peak = Math.max(...planStages(c.profile, c.vus, c.durationS, c.rampS).map((s) => s.vus));
  if (peak > LOAD_LIMITS.maxVus)
    throw new Error(`At most ${LOAD_LIMITS.maxVus} virtual users (this profile peaks at ${peak})`);
  if (c.durationS > LOAD_LIMITS.maxDurationS)
    throw new Error(`At most ${LOAD_LIMITS.maxDurationS / 60} minutes per load test`);
}

const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2));

export function evaluateThresholds(
  r: Pick<LoadReport, 'latency' | 'errorRatePct' | 'rps'>,
  t: LoadThresholds = {},
): ThresholdResult[] {
  const out: ThresholdResult[] = [];
  const below = (
    metric: ThresholdResult['metric'],
    label: string,
    actual: number,
    max: number,
    unit: string,
  ) =>
    out.push({
      metric,
      label,
      threshold: max,
      actual,
      unit,
      passed: actual < max,
      message:
        actual < max
          ? `${label} ${fmt(actual)} ${unit} < ${fmt(max)} ${unit}`
          : `${label} ${fmt(actual)} ${unit} exceeded the threshold of ${fmt(max)} ${unit} by ${fmt(actual - max)} ${unit}`,
    });
  if (t.p95Ms !== undefined) below('p95', 'p95 latency', r.latency.p95, t.p95Ms, 'ms');
  if (t.p99Ms !== undefined) below('p99', 'p99 latency', r.latency.p99, t.p99Ms, 'ms');
  if (t.avgMs !== undefined) below('avg', 'Average latency', Math.round(r.latency.avg), t.avgMs, 'ms');
  if (t.maxErrorRatePct !== undefined)
    below('errorRate', 'Error rate', r.errorRatePct, t.maxErrorRatePct, '%');
  if (t.minRps !== undefined) {
    const passed = r.rps >= t.minRps;
    out.push({
      metric: 'rps',
      label: 'Throughput',
      threshold: t.minRps,
      actual: r.rps,
      unit: 'req/s',
      passed,
      message: passed
        ? `Throughput ${fmt(r.rps)} req/s ≥ ${fmt(t.minRps)} req/s`
        : `Throughput ${fmt(r.rps)} req/s is below the required ${fmt(t.minRps)} req/s`,
    });
  }
  return out;
}

export const describeTarget = (requests: LoadRequest[]) =>
  requests.length === 1
    ? `${requests[0]!.method} ${requests[0]!.url}`
    : `${requests.length} requests to ${new URL(requests[0]!.url).origin}`;

/**
 * Runs a load test with autocannon: one autocannon run per stage (constant concurrency each), every response
 * timed into a histogram, and a per-second timeline for live charts.
 */
export async function runLoadTest(
  config: LoadConfig,
  opts: { onTick?: (t: LoadTick) => void; signal?: AbortSignal } = {},
): Promise<LoadReport> {
  validateLoadConfig(config);
  const stages = planStages(config.profile, config.vus, config.durationS, config.rampS);
  const origin = new URL(config.requests[0]!.url).origin;
  const hist = new LatencyHistogram();
  const statusCodes: Record<string, number> = {};
  const timeline: TimelinePoint[] = [];
  let errors = 0;
  let cancelled = false;
  let currentVus = stages[0]!.vus;
  let second = { requests: 0, errors: 0, hist: new LatencyHistogram() };
  const startedAt = new Date();
  const t0 = Date.now();

  let lastFlush = Date.now();
  const flush = () => {
    // The last bucket covers only part of a second: report per-second rates so the chart does not dip.
    const now = Date.now();
    const span = Math.min(1, Math.max(0.05, (now - lastFlush) / 1000));
    lastFlush = now;
    const point = {
      t: timeline.length + 1,
      vus: currentVus,
      requests: Math.round(second.requests / span),
      errors: Math.round(second.errors / span),
      p95: second.hist.percentile(95),
      avg: Math.round(second.hist.mean * 100) / 100,
    };
    timeline.push(point);
    opts.onTick?.({ ...point, totalRequests: hist.count });
    second = { requests: 0, errors: 0, hist: new LatencyHistogram() };
  };
  const clock = setInterval(flush, 1000);

  try {
    for (const stage of stages) {
      if (opts.signal?.aborted) {
        cancelled = true;
        break;
      }
      currentVus = stage.vus;
      await new Promise<void>((resolve, reject) => {
        const instance = autocannon(
          {
            url: origin,
            connections: stage.vus,
            duration: stage.durationS,
            timeout: config.timeoutS ?? 10,
            pipelining: 1,
            requests: config.requests.map((r) => {
              const u = new URL(r.url);
              return {
                method: r.method.toUpperCase() as 'GET',
                path: `${u.pathname}${u.search}`,
                headers: r.headers,
                body: r.body,
              };
            }),
          },
          (err) => (err ? reject(err) : resolve()),
        );
        instance.on(
          'response',
          (_client: unknown, statusCode: number, _bytes: number, responseTime: number) => {
            hist.add(responseTime);
            second.hist.add(responseTime);
            second.requests++;
            statusCodes[String(statusCode)] = (statusCodes[String(statusCode)] ?? 0) + 1;
            if (statusCode >= 400) {
              errors++;
              second.errors++;
            }
          },
        );
        instance.on('reqError', () => {
          errors++;
          second.errors++;
          second.requests++;
          statusCodes.error = (statusCodes.error ?? 0) + 1;
        });
        const stop = () => instance.stop();
        opts.signal?.addEventListener('abort', stop, { once: true });
      });
    }
    if (opts.signal?.aborted) cancelled = true;
  } finally {
    clearInterval(clock);
    if (second.requests > 0) flush();
  }

  const elapsedS = Math.max(0.001, (Date.now() - t0) / 1000);
  const total = hist.count + (statusCodes.error ?? 0);
  const partial = {
    latency: {
      min: hist.min,
      avg: Math.round(hist.mean * 100) / 100,
      p50: hist.percentile(50),
      p90: hist.percentile(90),
      p95: hist.percentile(95),
      p99: hist.percentile(99),
      max: hist.max,
    },
    errorRatePct: total ? Math.round((errors / total) * 10_000) / 100 : 0,
    rps: Math.round((total / elapsedS) * 100) / 100,
  };
  const thresholds = evaluateThresholds(partial, config.thresholds);
  return {
    engine: 'builtin',
    profile: config.profile,
    vus: config.vus,
    durationS: stages.reduce((s, x) => s + x.durationS, 0),
    stages,
    target: describeTarget(config.requests),
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    requests: total,
    errors,
    ...partial,
    statusCodes,
    timeline,
    thresholds,
    passed: !cancelled && thresholds.every((t) => t.passed),
    ...(cancelled && { cancelled: true }),
  };
}
