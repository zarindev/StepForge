import { getSetting, schema, type StepForgeDb } from '@stepforge/db';
import * as repo from '@stepforge/db/repos';
import type { Branding, BugReportData, DiagnosisSummary, RunReportData } from '@stepforge/reports';
import { DEFAULT_BRANDING } from '@stepforge/reports';
import { asc, eq } from 'drizzle-orm';
import { existsSync, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { SETTINGS_DEFAULTS } from '../routes/system.ts';

const MAX_TEXT = 6000;

export function branding(db: StepForgeDb): Branding {
  const b = getSetting(db, 'reportBranding', SETTINGS_DEFAULTS.reportBranding);
  return { author: b.author || DEFAULT_BRANDING.author, company: b.company || undefined, accent: b.accent };
}

/** Embeds an artifact image as a data: URI so reports are self-contained. */
function dataUri(artifactsRoot: string, rel: string | null | undefined): string | undefined {
  if (!rel) return undefined;
  const file = join(artifactsRoot, rel);
  if (!existsSync(file)) return undefined;
  const type = extname(file) === '.png' ? 'image/png' : 'image/jpeg';
  return `data:${type};base64,${readFileSync(file).toString('base64')}`;
}

const text = (v: unknown) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v, null, 2);
  return s && s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT)}\n… (truncated)` : s;
};

function failedStep(db: StepForgeDb, runItemId: string | null, stepId: string | null) {
  if (!runItemId) return undefined;
  const steps = db.select().from(schema.stepResults).where(eq(schema.stepResults.runItemId, runItemId)).all();
  return (
    steps.find((s) => s.stepId === stepId && (s.status === 'failed' || s.status === 'broken')) ??
    steps.find((s) => s.status === 'failed' || s.status === 'broken')
  );
}

/** Everything a bug export needs, with evidence embedded. */
export function bugReportData(db: StepForgeDb, artifactsRoot: string, bug: repo.Bug): BugReportData {
  const app = repo.getApplication(db, bug.applicationId);
  let scenario: repo.ScenarioDetail | undefined;
  try {
    scenario = bug.scenarioId ? repo.getScenario(db, bug.scenarioId) : undefined;
  } catch {
    scenario = undefined;
  }
  const moduleName = scenario
    ? db
        .select({ name: schema.modules.name })
        .from(schema.modules)
        .where(eq(schema.modules.id, scenario.moduleId))
        .get()?.name
    : undefined;
  const tc = scenario?.testCases.find((t) => t.id === bug.testCaseId);
  const step = failedStep(db, bug.runItemId, bug.failedStepId);
  const artifacts = bug.runItemId
    ? db.select().from(schema.artifacts).where(eq(schema.artifacts.runItemId, bug.runItemId)).all()
    : [];
  const req = step?.requestJson as
    { method?: string; url?: string; headers?: unknown; body?: unknown } | null | undefined;
  const res = (step?.responseJson as { body?: { status?: number; headers?: unknown; body?: unknown } } | null)
    ?.body;
  const env = bug.environmentJson as BugReportData['environment'];
  return {
    code: bug.code,
    title: bug.title,
    summary: bug.summary,
    severity: bug.severity,
    priority: bug.priority,
    status: bug.status,
    application: app.name,
    module: moduleName,
    scenario: scenario?.name,
    testCase: tc ? `${tc.code} ${tc.title}` : undefined,
    environment: env,
    preconditions: bug.preconditions,
    steps: bug.stepsToReproduceJson,
    expected: bug.expected,
    actual: bug.actual,
    diagnosis: (bug.diagnosisJson as DiagnosisSummary | null) ?? undefined,
    owner: bug.ownerHint ?? undefined,
    occurrences: bug.occurrences,
    createdAt: bug.createdAt,
    lastSeenAt: bug.lastSeenAt ?? undefined,
    evidence: {
      screenshot: dataUri(artifactsRoot, step?.screenshotPath),
      request: req?.url
        ? `${req.method ?? 'GET'} ${req.url}${req.body !== undefined ? `\n\n${text(req.body)}` : ''}`
        : undefined,
      response: res?.status !== undefined ? `${res.status}\n\n${text(res.body)}` : undefined,
      files: [
        ...new Set(
          artifacts.map(
            (a) =>
              ({
                video: 'video',
                trace: 'trace',
                console: 'console log',
                network: 'network log',
                dom: 'DOM snapshot',
                email: 'email',
                load_report: 'load report',
                lighthouse: 'Lighthouse report',
              })[a.kind as string] ?? a.kind,
          ),
        ),
      ],
    },
  };
}

export function runReportData(db: StepForgeDb, artifactsRoot: string, runId: string): RunReportData {
  const run = db.select().from(schema.runs).where(eq(schema.runs.id, runId)).get();
  if (!run) throw repo.notFound('Run', runId);
  const app = repo.getApplication(db, run.applicationId);
  const env = run.environmentId
    ? db.select().from(schema.environments).where(eq(schema.environments.id, run.environmentId)).get()
    : undefined;
  const items = db
    .select()
    .from(schema.runItems)
    .where(eq(schema.runItems.runId, runId))
    .orderBy(asc(schema.runItems.position))
    .all();
  return {
    application: app.name,
    environment: { name: env?.name, url: env?.baseUrl },
    run: {
      id: run.id,
      status: run.status,
      trigger: run.trigger,
      startedAt: run.startedAt ?? undefined,
      finishedAt: run.finishedAt ?? undefined,
      durationMs: run.durationMs ?? undefined,
      browser: run.browser,
      viewport: run.viewport,
      totals: run.totalsJson as RunReportData['run']['totals'],
    },
    items: items.map((it) => {
      const label = (it.labelJson ?? {}) as {
        scenario?: string;
        modulePath?: string[];
        testCaseCode?: string | null;
        testCaseTitle?: string | null;
      };
      const steps = db
        .select()
        .from(schema.stepResults)
        .where(eq(schema.stepResults.runItemId, it.id))
        .orderBy(asc(schema.stepResults.position))
        .all();
      const failed = steps.find((s) => s.status === 'failed' || s.status === 'broken');
      return {
        title:
          [label.scenario, label.testCaseCode && `${label.testCaseCode} ${label.testCaseTitle ?? ''}`.trim()]
            .filter(Boolean)
            .join(' — ') || it.id,
        module: label.modulePath?.join(' › '),
        status: it.status,
        durationMs: it.durationMs ?? undefined,
        error: it.errorMessage ?? undefined,
        diagnosis: (it.diagnosisJson as DiagnosisSummary | null) ?? undefined,
        steps: steps.map((s) => ({
          path: String((s.responseJson as { path?: string } | null)?.path ?? s.position + 1),
          label: s.label || s.type,
          status: s.status,
          durationMs: s.durationMs ?? undefined,
          message: s.message ?? undefined,
        })),
        screenshot: failed ? dataUri(artifactsRoot, failed.screenshotPath) : undefined,
      };
    }),
  };
}
