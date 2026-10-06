import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const LIGHTHOUSE_CATEGORIES = ['performance', 'accessibility', 'best-practices', 'seo'] as const;
export type LighthouseCategory = (typeof LIGHTHOUSE_CATEGORIES)[number];

export type LighthouseResult = {
  url: string;
  formFactor: 'desktop' | 'mobile';
  /** 0–100 per category. */
  scores: Partial<Record<LighthouseCategory, number>>;
  /** Key lab metrics in ms (CLS unitless). */
  metrics: { lcp?: number; fcp?: number; cls?: number; tbt?: number; speedIndex?: number };
  reportPath?: string;
  durationMs: number;
  warnings: string[];
};

/**
 * Runs Lighthouse (12.x, Node 18+) in a separate headless Chrome — Playwright's Chromium by default — and saves
 * the HTML report. The page is loaded fresh, without the test's cookies.
 */
export async function runLighthouse(opts: {
  url: string;
  chromePath: string;
  categories?: LighthouseCategory[];
  formFactor?: 'desktop' | 'mobile';
  outputDir?: string;
  reportName?: string;
}): Promise<LighthouseResult> {
  const started = Date.now();
  const [{ default: lighthouse, desktopConfig }, chromeLauncher] = await Promise.all([
    import('lighthouse'),
    import('chrome-launcher'),
  ]);
  const chrome = await chromeLauncher.launch({
    chromePath: opts.chromePath,
    chromeFlags: ['--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run'],
    logLevel: 'silent',
  });
  try {
    const formFactor = opts.formFactor ?? 'desktop';
    const result = await lighthouse(
      opts.url,
      {
        port: chrome.port,
        output: 'html',
        logLevel: 'error',
        onlyCategories: [...(opts.categories?.length ? opts.categories : LIGHTHOUSE_CATEGORIES)],
      },
      formFactor === 'desktop' ? (desktopConfig as never) : undefined,
    );
    if (!result) throw new Error('Lighthouse returned no result');
    const lhr = result.lhr;
    if (lhr.runtimeError)
      throw new Error(`Lighthouse could not load ${opts.url}: ${lhr.runtimeError.message}`);
    const scores: LighthouseResult['scores'] = {};
    for (const [id, cat] of Object.entries(lhr.categories))
      if (cat.score !== null) scores[id as LighthouseCategory] = Math.round(cat.score * 100);
    const num = (id: string) => {
      const v = lhr.audits[id]?.numericValue;
      return v === undefined
        ? undefined
        : Math.round(v * (id === 'cumulative-layout-shift' ? 1000 : 1)) /
            (id === 'cumulative-layout-shift' ? 1000 : 1);
    };
    let reportPath: string | undefined;
    if (opts.outputDir) {
      mkdirSync(opts.outputDir, { recursive: true });
      reportPath = join(opts.outputDir, `${opts.reportName ?? 'lighthouse'}.html`);
      writeFileSync(reportPath, Array.isArray(result.report) ? result.report[0]! : result.report);
    }
    return {
      url: lhr.finalDisplayedUrl ?? opts.url,
      formFactor,
      scores,
      metrics: {
        lcp: num('largest-contentful-paint'),
        fcp: num('first-contentful-paint'),
        cls: num('cumulative-layout-shift'),
        tbt: num('total-blocking-time'),
        speedIndex: num('speed-index'),
      },
      reportPath,
      durationMs: Date.now() - started,
      warnings: lhr.runWarnings ?? [],
    };
  } finally {
    await chrome.kill();
  }
}

export type LighthouseThresholds = Partial<
  Record<'performance' | 'accessibility' | 'bestPractices' | 'seo', number>
>;

/** Minimum scores (0–100); a category that was not measured fails its threshold. */
export function checkLighthouse(r: LighthouseResult, t: LighthouseThresholds = {}) {
  const map: [keyof LighthouseThresholds, LighthouseCategory, string][] = [
    ['performance', 'performance', 'Performance'],
    ['accessibility', 'accessibility', 'Accessibility'],
    ['bestPractices', 'best-practices', 'Best practices'],
    ['seo', 'seo', 'SEO'],
  ];
  const rows: { metric: string; value: number; unit: string; threshold?: number; passed?: boolean }[] = [];
  const failures: string[] = [];
  for (const [key, cat, label] of map) {
    const score = r.scores[cat];
    const min = t[key];
    if (score === undefined) {
      if (min !== undefined) failures.push(`${label} score was not measured`);
      continue;
    }
    const passed = min === undefined ? undefined : score >= min;
    rows.push({
      metric: `lighthouse.${cat}`,
      value: score,
      unit: 'score',
      ...(min !== undefined && { threshold: min, passed }),
    });
    if (passed === false)
      failures.push(`${label} score ${score} is below the minimum of ${min} (by ${min! - score})`);
  }
  return { rows, failures };
}
