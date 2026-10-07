import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);

/**
 * Init script that loads Google's web-vitals library into every page, scoped inside a closure (the page's own
 * globals are untouched), recording the latest values in `window.__stepforgeVitals`.
 */
export const WEB_VITALS_INIT_SCRIPT = (() => {
  // The IIFE build is not in web-vitals' "exports"; it sits next to the main entry in dist/.
  const lib = readFileSync(join(dirname(require.resolve('web-vitals')), 'web-vitals.iife.js'), 'utf8');
  return `(function () {
  if (window.__stepforgeVitals) return;
  var store = {};
  Object.defineProperty(window, '__stepforgeVitals', { value: store, enumerable: false });
  var webVitals;
  ${lib}
  var set = function (m) { store[m.name] = m.value; };
  try {
    webVitals.onLCP(set, { reportAllChanges: true });
    webVitals.onCLS(set, { reportAllChanges: true });
    webVitals.onINP(set, { reportAllChanges: true });
    webVitals.onFCP(set);
    webVitals.onTTFB(set);
  } catch (e) {}
})();`;
})();

export type PageMetrics = {
  url: string;
  /** Largest Contentful Paint (ms). */
  lcp?: number;
  /** Cumulative Layout Shift (unitless). */
  cls?: number;
  /** Interaction to Next Paint (ms); only after the user (or test) interacted. */
  inp?: number;
  fcp?: number;
  ttfb?: number;
  /** Navigation start → load event end (ms). */
  load?: number;
  domContentLoaded?: number;
  /** Bytes transferred for the document and its resources, when the browser reports them. */
  transferBytes?: number;
  requests?: number;
};

export type PageThresholds = {
  lcpMs?: number;
  cls?: number;
  inpMs?: number;
  fcpMs?: number;
  ttfbMs?: number;
  loadMs?: number;
};

/** Google's "good" limits, shown as guidance in the UI. */
export const GOOD_VITALS: Required<Pick<PageThresholds, 'lcpMs' | 'cls' | 'inpMs' | 'fcpMs' | 'ttfbMs'>> = {
  lcpMs: 2500,
  cls: 0.1,
  inpMs: 200,
  fcpMs: 1800,
  ttfbMs: 800,
};

type MinimalPage = {
  url(): string;
  waitForLoadState(state: 'load', opts?: { timeout: number }): Promise<void>;
  waitForTimeout(ms: number): Promise<void>;
  evaluate(expression: string): Promise<unknown>;
};

/** Reads the current page's metrics; waits for `load` and a short settle time so LCP/CLS are reported. */
export async function collectPageMetrics(
  page: MinimalPage,
  opts: { settleMs?: number; timeoutMs?: number } = {},
): Promise<PageMetrics> {
  await page.waitForLoadState('load', { timeout: opts.timeoutMs ?? 15_000 }).catch(() => undefined);
  await page.waitForTimeout(opts.settleMs ?? 400);
  // Paint metrics arrive asynchronously after load; on a slow machine 400 ms is not always enough. Wait for
  // FCP and LCP (when the Web Vitals script is on the page) for up to 3 s more.
  for (const deadline = Date.now() + 3000; Date.now() < deadline;) {
    const ready = await page
      .evaluate(
        `(() => { const v = window.__stepforgeVitals; return !v || (v.FCP !== undefined && v.LCP !== undefined); })()`,
      )
      .catch(() => true);
    if (ready) break;
    await page.waitForTimeout(100);
  }
  // Runs in the page; a string so this Node package needs no DOM types.
  const raw = (await page.evaluate(`(() => {
    const nav = performance.getEntriesByType('navigation')[0];
    const resources = performance.getEntriesByType('resource');
    return {
      vitals: { ...(window.__stepforgeVitals || {}) },
      load: nav && nav.loadEventEnd > 0 ? nav.loadEventEnd - nav.startTime : undefined,
      dcl: nav && nav.domContentLoadedEventEnd > 0 ? nav.domContentLoadedEventEnd - nav.startTime : undefined,
      ttfb: nav ? nav.responseStart - nav.startTime : undefined,
      bytes: (nav ? nav.transferSize || 0 : 0) + resources.reduce((s, r) => s + (r.transferSize || 0), 0),
      requests: resources.length + 1,
    };
  })()`)) as {
    vitals: Record<string, number>;
    load?: number;
    dcl?: number;
    ttfb?: number;
    bytes: number;
    requests: number;
  };
  const round = (n: number | undefined, digits = 0) =>
    n === undefined || !Number.isFinite(n) ? undefined : Math.round(n * 10 ** digits) / 10 ** digits;
  return {
    url: page.url(),
    lcp: round(raw.vitals.LCP),
    cls: round(raw.vitals.CLS, 3),
    inp: round(raw.vitals.INP),
    fcp: round(raw.vitals.FCP),
    ttfb: round(raw.vitals.TTFB ?? raw.ttfb),
    load: round(raw.load),
    domContentLoaded: round(raw.dcl),
    transferBytes: raw.bytes || undefined,
    requests: raw.requests,
  };
}

export type MetricCheck = {
  metric: string;
  value: number;
  unit: string;
  threshold?: number;
  passed?: boolean;
};

const LABEL: Record<string, string> = {
  lcp: 'LCP',
  cls: 'CLS',
  inp: 'INP',
  fcp: 'FCP',
  ttfb: 'TTFB',
  load: 'Load time',
};

/** Metric rows (for results and analytics) with threshold verdicts; a missing metric with a threshold fails. */
export function checkPageMetrics(
  m: PageMetrics,
  t: PageThresholds = {},
): { rows: MetricCheck[]; failures: string[] } {
  const spec: [keyof PageMetrics, keyof PageThresholds | undefined, string][] = [
    ['lcp', 'lcpMs', 'ms'],
    ['cls', 'cls', ''],
    ['inp', 'inpMs', 'ms'],
    ['fcp', 'fcpMs', 'ms'],
    ['ttfb', 'ttfbMs', 'ms'],
    ['load', 'loadMs', 'ms'],
  ];
  const rows: MetricCheck[] = [];
  const failures: string[] = [];
  for (const [key, tKey, unit] of spec) {
    const value = m[key] as number | undefined;
    const threshold = tKey ? t[tKey] : undefined;
    if (value === undefined) {
      if (threshold !== undefined)
        failures.push(
          `${LABEL[key]} was not reported${key === 'inp' ? ' (INP needs an interaction on the page first)' : ''}`,
        );
      continue;
    }
    const passed = threshold === undefined ? undefined : value <= threshold;
    rows.push({ metric: `page.${key}`, value, unit, ...(threshold !== undefined && { threshold, passed }) });
    if (passed === false)
      failures.push(
        `${LABEL[key]} ${value}${unit ? ` ${unit}` : ''} exceeded the threshold of ${threshold}${unit ? ` ${unit}` : ''} by ${Math.round((value - threshold!) * 1000) / 1000}${unit ? ` ${unit}` : ''}`,
      );
  }
  return { rows, failures };
}
