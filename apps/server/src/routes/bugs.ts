import { Locator } from '@stepforge/core';
import { getSetting, schema } from '@stepforge/db';
import * as repo from '@stepforge/db/repos';
import {
  bugHtml,
  bugListHtml,
  bugMarkdown,
  bugsCsv,
  bugsXlsx,
  htmlToPdf,
  runReportHtml,
  runXlsx,
} from '@stepforge/reports';
import { eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.ts';
import { branding, bugReportData, runReportData } from '../diagnosis/report-data.ts';
import { SETTINGS_DEFAULTS } from './system.ts';

type P<T extends string> = { Params: Record<T, string> };

const TYPES = {
  pdf: 'application/pdf',
  html: 'text/html; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  csv: 'text/csv; charset=utf-8',
} as const;

function send(reply: FastifyReply, body: string | Buffer, ext: keyof typeof TYPES, filename: string) {
  const safe = filename.replace(/[^\w.-]+/g, '_');
  return reply
    .header('content-type', TYPES[ext])
    .header('content-disposition', `attachment; filename="${safe}.${ext}"`)
    .send(body);
}

type AnyStep = { id?: string; params?: Record<string, unknown>; locators?: unknown[] };
function withLocator(steps: AnyStep[], id: string, loc: unknown): boolean {
  for (const s of steps) {
    if (s.id === id) {
      // The suggestion becomes the primary locator; the old ones stay as fallbacks.
      s.locators = [
        loc,
        ...((s.locators ?? []) as unknown[]).filter((l) => JSON.stringify(l) !== JSON.stringify(loc)),
      ];
      return true;
    }
    for (const key of ['steps', 'else']) {
      const nested = s.params?.[key];
      if (Array.isArray(nested) && withLocator(nested as AnyStep[], id, loc)) return true;
    }
  }
  return false;
}

export function registerBugRoutes(app: FastifyInstance, ctx: AppContext) {
  const { db } = ctx;
  const root = ctx.config.artifactsDir;
  const list = (s?: string) => (s ? s.split(',').filter(Boolean) : undefined);

  // ─── Bugs ────────────────────────────────────────────────────────────────
  app.get<P<'id'> & { Querystring: { status?: string; severity?: string; owner?: string } }>(
    '/api/applications/:id/bugs',
    async (req) => {
      repo.getApplication(db, req.params.id);
      return repo.listBugs(db, req.params.id, {
        status: list(req.query.status),
        severity: list(req.query.severity),
        owner: list(req.query.owner),
      });
    },
  );
  app.get<P<'id'>>('/api/bugs/:id', async (req) => {
    const bug = repo.getBug(db, req.params.id);
    const item = bug.runItemId
      ? db.select().from(schema.runItems).where(eq(schema.runItems.id, bug.runItemId)).get()
      : undefined;
    const artifacts = bug.runItemId
      ? db.select().from(schema.artifacts).where(eq(schema.artifacts.runItemId, bug.runItemId)).all()
      : [];
    const steps = bug.runItemId
      ? db.select().from(schema.stepResults).where(eq(schema.stepResults.runItemId, bug.runItemId)).all()
      : [];
    const failed =
      steps.find((s) => s.stepId === bug.failedStepId && s.status !== 'passed') ??
      steps.find((s) => s.status === 'failed' || s.status === 'broken');
    let scenario: { id: string; name: string } | undefined;
    try {
      if (bug.scenarioId) {
        const s = repo.getScenario(db, bug.scenarioId);
        scenario = { id: s.id, name: s.name };
      }
    } catch {
      scenario = undefined;
    }
    return { ...bug, runId: item?.runId, scenario, artifacts, failedStep: failed };
  });
  app.patch<P<'id'>>('/api/bugs/:id', async (req) => repo.updateBug(db, req.params.id, req.body as object));
  app.delete<P<'id'>>('/api/bugs/:id', async (req, reply) => {
    repo.deleteBug(db, req.params.id);
    return reply.code(204).send();
  });

  // Single bug: PDF, HTML or GitHub-issue Markdown.
  app.get<P<'id'> & { Querystring: { format?: string } }>('/api/bugs/:id/export', async (req, reply) => {
    const bug = repo.getBug(db, req.params.id);
    const data = bugReportData(db, root, bug);
    const b = branding(db);
    const format = req.query.format ?? 'pdf';
    const name = `${bug.code}-${bug.title.slice(0, 40)}`;
    if (format === 'md') return send(reply, bugMarkdown(data, b), 'md', name);
    if (format === 'html') return send(reply, bugHtml(data, b), 'html', name);
    if (format === 'pdf') return send(reply, await htmlToPdf(bugHtml(data, b), b), 'pdf', name);
    throw new repo.RepoError(400, 'invalid', 'format must be pdf, html or md');
  });

  // Bug list: PDF, XLSX, Jira or Trello CSV, Markdown.
  app.get<P<'id'> & { Querystring: { format?: string; ids?: string; status?: string } }>(
    '/api/applications/:id/bugs/export',
    async (req, reply) => {
      const appRow = repo.getApplication(db, req.params.id);
      const ids = list(req.query.ids);
      const bugs = repo
        .listBugs(db, appRow.id, { status: list(req.query.status) })
        .filter((x) => !ids || ids.includes(x.id));
      const data = bugs.map((x) => bugReportData(db, root, x));
      const b = branding(db);
      const name = `${appRow.slug}-bugs`;
      switch (req.query.format ?? 'pdf') {
        case 'pdf':
          return send(reply, await htmlToPdf(bugListHtml(data, `Bugs — ${appRow.name}`, b), b), 'pdf', name);
        case 'xlsx':
          return send(reply, await bugsXlsx(data, b), 'xlsx', name);
        case 'jira':
          return send(reply, bugsCsv(data, 'jira', b), 'csv', `${name}-jira`);
        case 'trello':
          return send(reply, bugsCsv(data, 'trello', b), 'csv', `${name}-trello`);
        case 'md':
          return send(reply, data.map((x) => bugMarkdown(x, b)).join('\n\n'), 'md', name);
        default:
          throw new repo.RepoError(400, 'invalid', 'format must be pdf, xlsx, jira, trello or md');
      }
    },
  );

  // ─── Diagnosis ───────────────────────────────────────────────────────────
  app.post<P<'id'>>('/api/run-items/:id/diagnose', async (req) => {
    const d = ctx.diagnosis.diagnoseItem(req.params.id);
    if (!d) throw new repo.RepoError(400, 'invalid', 'This test has no failed step to diagnose');
    return d;
  });

  /** One-click fix for "locator changed": make the suggested locator the step's primary one. */
  app.post<P<'id'>>('/api/run-items/:id/accept-locator', async (req) => {
    const { stepId, locator } = z.object({ stepId: z.string(), locator: Locator }).parse(req.body);
    const item = db.select().from(schema.runItems).where(eq(schema.runItems.id, req.params.id)).get();
    if (!item?.scenarioId) throw repo.notFound('Run item', req.params.id);
    const scenario = repo.getScenario(db, item.scenarioId);
    const steps = structuredClone(scenario.steps) as unknown as AnyStep[];
    if (!withLocator(steps, stepId, locator))
      throw new repo.RepoError(404, 'not_found', 'The step no longer exists in this scenario');
    return repo.saveSteps(db, scenario.id, steps as never);
  });

  // ─── Run reports ─────────────────────────────────────────────────────────
  app.get<P<'id'> & { Querystring: { format?: string } }>('/api/runs/:id/report', async (req, reply) => {
    const data = runReportData(db, root, req.params.id);
    const b = branding(db);
    const name = `stepforge-run-${data.application}-${req.params.id.slice(-6)}`;
    switch (req.query.format ?? 'html') {
      case 'html':
        return send(reply, runReportHtml(data, b), 'html', name);
      case 'pdf':
        return send(reply, await htmlToPdf(runReportHtml(data, b), b), 'pdf', name);
      case 'xlsx':
        return send(reply, await runXlsx(data, b), 'xlsx', name);
      default:
        throw new repo.RepoError(400, 'invalid', 'format must be html, pdf or xlsx');
    }
  });

  // ─── Optional local AI (Ollama) ──────────────────────────────────────────
  const ollama = () => getSetting(db, 'ollama', SETTINGS_DEFAULTS.ollama);
  const isLocal = (url: string) => /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?\/?/.test(url);

  app.get('/api/ai/status', async () => {
    const o = ollama();
    if (!isLocal(o.url)) return { available: false, reason: 'Ollama must run on this computer' };
    try {
      const res = await fetch(`${o.url.replace(/\/$/, '')}/api/tags`, { signal: AbortSignal.timeout(1500) });
      if (!res.ok) return { available: false };
      const models = ((await res.json()) as { models?: { name: string }[] }).models?.map((m) => m.name) ?? [];
      return {
        available: models.some((m) => m === o.model || m.startsWith(`${o.model}:`)),
        model: o.model,
        models,
      };
    } catch {
      return { available: false };
    }
  });

  app.post<P<'id'>>('/api/run-items/:id/explain', async (req) => {
    const o = ollama();
    if (!isLocal(o.url)) throw new repo.RepoError(400, 'invalid', 'Ollama must run on this computer');
    const item = db.select().from(schema.runItems).where(eq(schema.runItems.id, req.params.id)).get();
    if (!item?.diagnosisJson) throw new repo.RepoError(400, 'invalid', 'Diagnose the test first');
    // Only the (already secret-masked) diagnosis is sent, and only to the local model.
    const d = item.diagnosisJson as {
      title: string;
      explanation: string;
      fix: string;
      owner: string;
      evidence?: unknown;
    };
    const prompt = `You help a QA tester. Explain this automated test failure in plain English for a non-technical reader, in at most 5 short sentences. Do not invent facts.\n\nFailure: ${d.title}\nDetails: ${d.explanation}\nLikely owner: ${d.owner}\nSuggested fix: ${d.fix}\nEvidence: ${JSON.stringify(d.evidence ?? [])}`;
    try {
      const res = await fetch(`${o.url.replace(/\/$/, '')}/api/generate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: o.model, prompt, stream: false }),
        signal: AbortSignal.timeout(120_000),
      });
      if (!res.ok) throw new Error(`Ollama answered ${res.status}`);
      return { text: ((await res.json()) as { response?: string }).response?.trim() ?? '' };
    } catch (err) {
      throw new repo.RepoError(502, 'ai_unavailable', `Ollama is not reachable: ${(err as Error).message}`);
    }
  });
}
