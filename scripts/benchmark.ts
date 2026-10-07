/**
 * StepForge benchmark (StepForge by Md Zarin Tasnim). Runs the bundled demo workspaces against the two demo apps
 * and records real numbers in docs/benchmarks.json — the only numbers the README, case study and Upwork assets use.
 *
 *   npx tsx scripts/benchmark.ts            (needs Mailpit: npm run mailpit:install)
 *
 * How it scores: StepForge runs every demo scenario (desktop), plus the phone scenarios (tag "mobile") at the mobile
 * viewport, exactly as a user would. Only after the runs does this script read demo/manifests/planted_bugs.json —
 * StepForge itself never reads it — and compare: a planted bug is *detected* when the scenario named in the manifest
 * failed, and *diagnosed correctly* when StepForge's diagnosis category is one the manifest lists as acceptable
 * (written before the first run). A *false alarm* is a failed test that no planted bug explains.
 */
import { STEPFORGE_VERSION } from '@stepforge/core';
import { schema } from '@stepforge/db';
import * as repo from '@stepforge/db/repos';
import { buildApp } from '@stepforge/server';
import { eq } from 'drizzle-orm';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { arch, cpus, platform, release, tmpdir, totalmem } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const freePort = () =>
  new Promise<number>((r) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => r(port));
    });
  });

type Item = {
  scenario: string;
  status: string;
  category: string | null;
  title: string | null;
  owner: string | null;
  durationMs: number;
};
type Bug = {
  id: string;
  app: string;
  layer: string;
  category: string;
  title: string;
  detectedBy: string;
  run: 'desktop' | 'mobile';
  acceptableDiagnoses: string[];
};

async function main() {
  const started = Date.now();
  const dataDir = mkdtempSync(join(tmpdir(), 'stepforge-benchmark-'));
  const { app, ctx } = await buildApp({
    embedded: true,
    config: {
      dataDir,
      port: 0,
      binDir: process.env.STEPFORGE_BIN_DIR
        ? resolve(ROOT, process.env.STEPFORGE_BIN_DIR)
        : join(ROOT, 'data/bin'),
      mailpit: { httpPort: await freePort(), smtpPort: await freePort() },
    },
  });
  const results: Record<
    string,
    { desktop: Item[]; mobile: Item[]; desktopMs: number; mobileMs: number; scenarios: number }
  > = {};
  try {
    const loaded = await ctx.demo.load();
    if (!loaded.mailpit)
      throw new Error(`Mailpit is needed for the email scenarios: ${loaded.warnings.join(' ')}`);
    const runOnce = async (
      applicationId: string,
      environmentId: string,
      scope: object,
      options: object = {},
    ) => {
      const run = ctx.runs.create({
        applicationId,
        environmentId,
        scope: scope as never,
        options: options as never,
        trigger: 'cli',
      });
      await ctx.runs.idle();
      const r = ctx.db.select().from(schema.runs).where(eq(schema.runs.id, run.id)).get()!;
      const items = ctx.db.select().from(schema.runItems).where(eq(schema.runItems.runId, run.id)).all();
      return {
        ms: r.durationMs ?? 0,
        items: items.map((i) => {
          const d = i.diagnosisJson as { category?: string; title?: string; owner?: string } | null;
          return {
            scenario: i.labelJson?.scenario ?? '',
            status: i.status,
            category: d?.category ?? null,
            title: d?.title ?? null,
            owner: d?.owner ?? null,
            durationMs: i.durationMs ?? 0,
          };
        }),
      };
    };
    for (const demo of loaded.applications) {
      const env = repo.listEnvironments(ctx.db, demo.applicationId)[0]!;
      const mobileTag = repo.listTags(ctx.db, demo.applicationId).find((t) => t.name === 'mobile')!;
      console.log(`▶ ${demo.name}: desktop run…`);
      const desktop = await runOnce(
        demo.applicationId,
        env.id,
        { type: 'application' },
        { viewport: 'desktop', workers: 1 },
      );
      console.log(`▶ ${demo.name}: mobile run…`);
      const mobile = await runOnce(
        demo.applicationId,
        env.id,
        { type: 'tag', id: mobileTag.id },
        { viewport: 'mobile', workers: 1 },
      );
      results[demo.key] = {
        desktop: desktop.items,
        mobile: mobile.items,
        desktopMs: desktop.ms,
        mobileMs: mobile.ms,
        scenarios: repo.getTree(ctx.db, demo.applicationId).scenarios.length,
      };
    }
  } finally {
    await app.close();
  }

  // ─── Scoring (the manifest is read only now) ─────────────────────────────
  const manifest = JSON.parse(readFileSync(join(ROOT, 'demo/manifests/planted_bugs.json'), 'utf8')) as {
    bugs: Bug[];
  };
  const appKey: Record<string, string> = { careclinic: 'clinic', shopdesk: 'shop' };
  const failed = (i: Item) => i.status === 'failed' || i.status === 'broken';
  const bugs = manifest.bugs.map((b) => {
    const items = results[appKey[b.app]!]![b.run].filter((i) => i.scenario === b.detectedBy);
    const hit = items.find(failed);
    return {
      id: b.id,
      app: b.app,
      layer: b.layer,
      title: b.title,
      scenario: b.detectedBy,
      run: b.run,
      detected: !!hit,
      diagnosis: hit ? { category: hit.category, title: hit.title, owner: hit.owner } : null,
      diagnosedCorrectly: !!hit && !!hit.category && b.acceptableDiagnoses.includes(hit.category),
      acceptableDiagnoses: b.acceptableDiagnoses,
    };
  });
  const linked = new Set(manifest.bugs.map((b) => `${appKey[b.app]}|${b.run}|${b.detectedBy}`));
  const falseAlarms = Object.entries(results).flatMap(([key, r]) =>
    (['desktop', 'mobile'] as const).flatMap((run) =>
      r[run]
        .filter((i) => failed(i) && !linked.has(`${key}|${run}|${i.scenario}`))
        .map((i) => ({ app: key, run, scenario: i.scenario, status: i.status, diagnosis: i.title })),
    ),
  );
  const pct = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 10 : 0);
  const apps = Object.entries(results).map(([key, r]) => {
    const own = bugs.filter((b) => appKey[b.app] === key);
    return {
      app: key === 'clinic' ? 'CareClinic' : 'ShopDesk',
      scenarios: r.scenarios,
      testRuns: r.desktop.length + r.mobile.length,
      passed: [...r.desktop, ...r.mobile].filter((i) => i.status === 'passed').length,
      failed: [...r.desktop, ...r.mobile].filter(failed).length,
      plantedBugs: own.length,
      detected: own.filter((b) => b.detected).length,
      diagnosedCorrectly: own.filter((b) => b.diagnosedCorrectly).length,
      runTimeMs: { desktop: r.desktopMs, mobile: r.mobileMs },
    };
  });
  const detected = bugs.filter((b) => b.detected).length;
  const correct = bugs.filter((b) => b.diagnosedCorrectly).length;
  const out = {
    $comment:
      'Measured by scripts/benchmark.ts. These are the only numbers the README, case study and Upwork assets may use.',
    generatedAt: new Date().toISOString(),
    stepforgeVersion: STEPFORGE_VERSION,
    machine: {
      os: `${platform()} ${release()}`,
      arch: arch(),
      cpu: cpus()[0]?.model ?? 'unknown',
      cores: cpus().length,
      memoryGb: Math.round(totalmem() / 2 ** 30),
      node: process.version,
    },
    method:
      'Each demo app runs its whole demo-workspace suite at desktop size and its phone scenarios at mobile size, one test at a time. Planted bugs are scored afterwards against demo/manifests/planted_bugs.json, which StepForge never reads.',
    totals: {
      plantedBugs: bugs.length,
      detected,
      detectionRatePct: pct(detected, bugs.length),
      diagnosedCorrectly: correct,
      diagnosisAccuracyPct: pct(correct, detected),
      falseAlarms: falseAlarms.length,
      scenarios: apps.reduce((n, a) => n + a.scenarios, 0),
      testRuns: apps.reduce((n, a) => n + a.testRuns, 0),
      runTimeSeconds:
        Math.round(apps.reduce((n, a) => n + a.runTimeMs.desktop + a.runTimeMs.mobile, 0) / 100) / 10,
      layers: [...new Set(bugs.map((b) => b.layer))],
    },
    apps,
    bugs,
    falseAlarms,
    benchmarkDurationSeconds: Math.round((Date.now() - started) / 1000),
  };
  writeFileSync(join(ROOT, 'docs/benchmarks.json'), `${JSON.stringify(out, null, 2)}\n`);
  const t = out.totals;
  console.log(
    `\n${t.detected}/${t.plantedBugs} planted bugs detected (${t.detectionRatePct}%), ${t.diagnosedCorrectly}/${t.detected} diagnosed correctly (${t.diagnosisAccuracyPct}%), ${t.falseAlarms} false alarms; ${t.testRuns} test runs in ${t.runTimeSeconds} s.`,
  );
  for (const b of bugs.filter((x) => !x.detected || !x.diagnosedCorrectly))
    console.log(
      `  ${b.detected ? '~' : '✗'} ${b.id} ${b.title} — ${b.detected ? `diagnosed as ${b.diagnosis?.category}` : 'not detected'}`,
    );
  console.log('Wrote docs/benchmarks.json');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
