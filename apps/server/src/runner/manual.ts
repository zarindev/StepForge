import { describeSteps, newId, type Locator, type PlainLine } from '@stepforge/core';
import type { StepForgeDb } from '@stepforge/db';
import { schema } from '@stepforge/db';
import * as repo from '@stepforge/db/repos';
import { and, eq, inArray } from 'drizzle-orm';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { EventBus } from '../context.ts';
import type { RunManager } from './manager.ts';
import { testCaseData } from './scope.ts';

type StoredExtra = {
  blocked?: boolean;
  screenshots?: string[];
  clips?: { startMs: number; endMs: number; video?: string }[];
  bug?: { id: string; code: string };
};

/** One line of a manual checklist: a step to do and check, or a heading (a block, a branch) over nested lines. */
export type ManualLine = PlainLine & { group: boolean };
export type ManualStatus = 'passed' | 'failed' | 'blocked' | 'skipped';
type AnyStep = {
  type: string;
  label?: string;
  params?: Record<string, unknown>;
  locators?: Locator[];
  enabled?: boolean;
};

const MAX_DEPTH = 5;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const now = () => new Date().toISOString();

export const ManualSave = z.object({
  results: z
    .array(
      z.object({
        number: z.string().min(1).max(100),
        status: z.enum(['passed', 'failed', 'blocked', 'skipped', 'pending']),
        note: z.string().max(5000).optional(),
        /** One screenshot (older clients), or several (each may be an annotated copy). */
        screenshot: z.string().max(500).optional(),
        screenshots: z.array(z.string().max(500)).max(20).optional(),
        /** Parts of the session's screen recording, in ms from its start. */
        clips: z
          .array(
            z.object({
              startMs: z.number().min(0),
              endMs: z.number().min(0),
              video: z.string().max(500).optional(),
            }),
          )
          .max(20)
          .optional(),
      }),
    )
    .max(2000),
  /** true: the test is finished; lines without a result count as skipped. */
  done: z.boolean().default(false),
});

/**
 * Manual test runs: nothing is executed; a person follows each test's
 * steps — written out in plain English, with blocks, hooks and called scenarios expanded and test data filled in —
 * and records passed / failed / blocked / skipped per step, with a note and a screenshot. The results are ordinary
 * run results, so history, analytics, quality gates and reports include them.
 */
export class ManualRunService {
  constructor(
    private readonly db: StepForgeDb,
    private readonly bus: EventBus,
    private readonly runs: RunManager,
    private readonly artifactsRoot: string,
  ) {}

  private item(itemId: string) {
    const item = this.db.select().from(schema.runItems).where(eq(schema.runItems.id, itemId)).get();
    if (!item) throw repo.notFound('Run item', itemId);
    const run = this.runs.getRun(item.runId);
    if (run.mode !== 'manual') throw new repo.RepoError(409, 'conflict', 'This run is automated, not manual');
    return { item, run };
  }

  /** The steps of one test as checklist lines (numbered like an automated run: before.1, 1, 2.1, after.1). */
  lines(itemId: string): ManualLine[] {
    const { item, run } = this.item(itemId);
    if (!item.scenarioId) return [];
    const scenario = repo.getScenario(this.db, item.scenarioId);
    const env = run.environmentId ? repo.getEnvironment(this.db, run.environmentId) : undefined;
    const values: Record<string, Record<string, unknown>> = {
      data: testCaseData(this.db, item.testCaseId),
      env: env ? { ...env.variablesJson, baseUrl: env.baseUrl, name: env.name } : {},
    };
    const elements = repo.elementLocatorMap(this.db, run.applicationId);
    const blockSteps = (blockId: string) => {
      const b = repo.getBlock(this.db, blockId);
      return b.applicationId === run.applicationId ? b : undefined;
    };

    // Blocks and called scenarios are expanded under their step, saved elements become their locators, and
    // {{data.x}} / {{env.x}} / block inputs are filled in (secrets stay as placeholders).
    const expand = (list: AnyStep[], vars: Record<string, unknown>, depth: number): AnyStep[] =>
      list.map((s) => {
        const params = { ...(s.params ?? {}) };
        const locators = (s.locators ?? []).flatMap((l) =>
          l.strategy === 'element' ? ((elements[l.value] as Locator[] | undefined) ?? [l]) : [l],
        );
        let label = s.label;
        if (depth < MAX_DEPTH && s.type === 'util.useBlock' && typeof params.blockId === 'string') {
          const b = blockSteps(params.blockId);
          if (b) {
            const inputs = (params.inputs ?? {}) as Record<string, unknown>;
            const own = { ...vars };
            for (const i of b.inputsJson) own[i.name] = inputs[i.name] ?? i.default ?? '';
            label ||= b.name;
            params.steps = expand(b.steps as AnyStep[], own, depth + 1);
          }
        } else if (
          depth < MAX_DEPTH &&
          s.type === 'util.callScenario' &&
          typeof params.scenarioId === 'string'
        ) {
          if (repo.applicationIdForScenario(this.db, params.scenarioId) === run.applicationId) {
            const called = repo.getScenario(this.db, params.scenarioId);
            label ||= called.name;
            params.steps = expand(called.steps as AnyStep[], vars, depth + 1);
          }
        } else {
          for (const key of ['steps', 'else'])
            if (Array.isArray(params[key])) params[key] = expand(params[key] as AnyStep[], vars, depth);
        }
        return fill({ ...s, label, params, locators }, { ...values, vars });
      });

    const hooks = repo.hooksFor(this.db, scenario.id);
    const hookLines = (list: repo.Hook[], when: 'before' | 'after') =>
      describeSteps(
        expand(
          list.map((h) => ({
            type: 'util.useBlock',
            label: `${when === 'before' ? 'Before' : 'After'} each test: ${h.blockName}`,
            params: { blockId: h.blockId },
          })),
          {},
          0,
        ) as never,
        when,
      );
    const all = [
      ...hookLines(hooks.before, 'before'),
      ...describeSteps(expand(scenario.steps as AnyStep[], {}, 0) as never),
      ...hookLines(hooks.after, 'after'),
    ];
    return all.map((l, i) => ({
      ...l,
      group: (all[i + 1]?.depth ?? -1) > l.depth || l.text === 'Otherwise',
    }));
  }

  /** The checklist with the results recorded so far. */
  checklist(itemId: string) {
    const { item, run } = this.item(itemId);
    const results = this.db
      .select()
      .from(schema.stepResults)
      .where(eq(schema.stepResults.runItemId, itemId))
      .orderBy(schema.stepResults.position)
      .all()
      .map((r) => {
        const extra = (r.responseJson ?? {}) as StoredExtra;
        return {
          number: r.stepId ?? '',
          status: (extra.blocked ? 'blocked' : r.status) as ManualStatus | 'pending',
          note: r.message ?? '',
          screenshots: extra.screenshots ?? (r.screenshotPath ? [r.screenshotPath] : []),
          clips: extra.clips ?? [],
          ...(extra.bug && { bug: extra.bug }),
        };
      });
    const video = this.db
      .select()
      .from(schema.artifacts)
      .where(and(eq(schema.artifacts.runItemId, itemId), eq(schema.artifacts.kind, 'video')))
      .get();
    return {
      item,
      run: { id: run.id, status: run.status, mode: run.mode },
      lines: this.lines(itemId),
      results,
      video: video?.path ?? null,
    };
  }

  /** Records results; `done` finishes the test (and the run when it was the last open test). */
  save(itemId: string, input: unknown) {
    const { item, run } = this.item(itemId);
    if (run.status !== 'running') throw new repo.RepoError(409, 'conflict', `This run is ${run.status}`);
    const body = ManualSave.parse(input);
    const lines = this.lines(itemId);
    const given = new Map(body.results.map((r) => [r.number, r]));
    const folder = `runs/${run.id}/${item.id}/`;
    const shotsOf = (r: z.infer<typeof ManualSave>['results'][number]) =>
      r.screenshots ?? (r.screenshot ? [r.screenshot] : []);
    // A step without a result is kept when it has a note, screenshots or clips (it stays pending).
    const rows = lines
      .map((line, position) => ({ line, position, r: given.get(line.number) }))
      .filter(
        (x) =>
          !x.line.group &&
          x.r &&
          (x.r.status !== 'pending' || x.r.note?.trim() || shotsOf(x.r).length || x.r.clips?.length),
      );
    for (const { r } of rows)
      for (const shot of shotsOf(r!))
        if (!shot.startsWith(folder) || shot.includes('..'))
          throw new repo.RepoError(
            400,
            'invalid',
            'A screenshot must be one taken or uploaded for this test',
          );
    const previous = new Map(
      this.db
        .select()
        .from(schema.stepResults)
        .where(eq(schema.stepResults.runItemId, itemId))
        .all()
        .map((r) => [r.stepId, (r.responseJson ?? {}) as StoredExtra]),
    );

    const statuses = rows.map((x) => x.r!.status).filter((st) => st !== 'pending');
    const firstFailed =
      rows.find((x) => x.r!.status === 'failed') ?? rows.find((x) => x.r!.status === 'blocked');
    const status = !body.done
      ? 'running'
      : statuses.includes('failed')
        ? 'failed'
        : statuses.includes('blocked')
          ? 'broken'
          : statuses.includes('passed')
            ? 'passed'
            : 'skipped';
    this.db.transaction(() => {
      this.db.delete(schema.stepResults).where(eq(schema.stepResults.runItemId, itemId)).run();
      for (const { line, position, r } of rows)
        this.db
          .insert(schema.stepResults)
          .values({
            id: newId(),
            runItemId: itemId,
            stepId: line.number,
            position,
            type: 'manual',
            label: line.text,
            // Blocked is stored as broken (the test could not be done), and remembered as blocked. A finished test's
            // open steps count as skipped.
            status:
              r!.status === 'blocked'
                ? 'broken'
                : r!.status === 'pending'
                  ? body.done
                    ? 'skipped'
                    : 'pending'
                  : r!.status,
            message: r!.note?.trim() || null,
            screenshotPath: shotsOf(r!)[0] ?? null,
            responseJson: {
              path: line.number,
              depth: line.depth,
              manual: true,
              blocked: r!.status === 'blocked',
              screenshots: shotsOf(r!),
              clips: r!.clips ?? [],
              // A bug filed from this step stays linked.
              ...(previous.get(line.number)?.bug && { bug: previous.get(line.number)!.bug }),
            } satisfies StoredExtra & Record<string, unknown>,
          })
          .run();
      this.db
        .update(schema.runItems)
        .set({
          status,
          errorMessage: firstFailed
            ? `${firstFailed.r!.status === 'blocked' ? 'Blocked at' : 'Failed at'} step ${firstFailed.line.number}: ${firstFailed.r!.note?.trim() || firstFailed.line.text}`
            : null,
          failedStepId: firstFailed?.line.number ?? null,
          durationMs: run.startedAt ? Date.now() - Date.parse(run.startedAt) : null,
          updatedAt: now(),
        })
        .where(eq(schema.runItems.id, itemId))
        .run();
    });
    this.bus.publish({
      type: 'item.updated',
      runId: run.id,
      item: this.db.select().from(schema.runItems).where(eq(schema.runItems.id, itemId)).get(),
    });
    this.bus.publish({ type: 'manual.updated', runId: run.id, itemId });
    if (body.done && !this.open(run.id).length) this.complete(run.id);
    else this.runs.publishRun(run.id);
    return this.checklist(itemId);
  }

  /** Files a bug from a failed (or blocked) step: expected vs actual, with that step's screenshots as evidence. */
  reportBug(itemId: string, input: unknown) {
    const { item, run } = this.item(itemId);
    const d = z
      .object({
        number: z.string().min(1).max(100),
        title: z.string().trim().min(3).max(200),
        expected: z.string().max(5000).default(''),
        actual: z.string().max(5000).default(''),
        severity: z.enum(['critical', 'major', 'minor', 'trivial']).default('major'),
        priority: z.enum(['P1', 'P2', 'P3', 'P4']).default('P2'),
      })
      .parse(input);
    if (!item.scenarioId) throw new repo.RepoError(400, 'invalid', 'This test has no scenario any more');
    const lines = this.lines(itemId);
    const at = lines.findIndex((l) => l.number === d.number);
    if (at < 0) throw new repo.RepoError(400, 'invalid', `There is no step ${d.number}`);
    const env = run.environmentId ? repo.getEnvironment(this.db, run.environmentId) : undefined;
    const { bug } = repo.recordFailure(this.db, {
      applicationId: run.applicationId,
      runItemId: item.id,
      scenarioId: item.scenarioId,
      testCaseId: item.testCaseId,
      failedStepId: d.number,
      category: 'manual',
      title: d.title,
      summary: `Found in a manual test: ${item.labelJson?.scenario ?? ''}, step ${d.number}`,
      severity: d.severity,
      priority: d.priority,
      environment: env ? { environment: env.name, baseUrl: env.baseUrl, run: run.id } : { run: run.id },
      preconditions: repo.getScenario(this.db, item.scenarioId).preconditions,
      stepsToReproduce: lines
        .slice(0, at + 1)
        .filter((l) => !l.group)
        .map((l) => `${l.number}. ${l.text}`),
      expected: d.expected,
      actual: d.actual,
      diagnosis: null,
      owner: 'app',
    });
    const row = this.db
      .select()
      .from(schema.stepResults)
      .where(and(eq(schema.stepResults.runItemId, itemId), eq(schema.stepResults.stepId, d.number)))
      .get();
    if (row)
      this.db
        .update(schema.stepResults)
        .set({ responseJson: { ...(row.responseJson as object), bug: { id: bug.id, code: bug.code } } })
        .where(eq(schema.stepResults.id, row.id))
        .run();
    this.bus.publish({ type: 'manual.updated', runId: run.id, itemId });
    return bug;
  }

  /** Keeps a screenshot (a PNG or JPEG data URL) for one line; the path goes into that line's result. */
  attach(itemId: string, input: unknown) {
    const { item, run } = this.item(itemId);
    const { number, dataUrl } = z
      .object({ number: z.string().min(1).max(100), dataUrl: z.string() })
      .parse(input);
    const m = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
    if (!m) throw new repo.RepoError(400, 'invalid', 'Attach a PNG or JPEG image');
    const bytes = Buffer.from(m[2]!, 'base64');
    if (bytes.length > MAX_IMAGE_BYTES)
      throw new repo.RepoError(400, 'invalid', 'Images are limited to 10 MB');
    const rel = `runs/${run.id}/${item.id}/manual-${number.replace(/[^\w.-]+/g, '_')}-${Date.now()}.${m[1] === 'png' ? 'png' : 'jpg'}`;
    mkdirSync(join(this.artifactsRoot, 'runs', run.id, item.id), { recursive: true });
    writeFileSync(join(this.artifactsRoot, rel), bytes);
    return { path: rel };
  }

  private open(runId: string) {
    return this.db
      .select({ id: schema.runItems.id })
      .from(schema.runItems)
      .where(and(eq(schema.runItems.runId, runId), inArray(schema.runItems.status, ['queued', 'running'])))
      .all();
  }

  private complete(runId: string) {
    const t = this.runs.totals(runId);
    this.runs.finish(runId, t.failed + t.broken > 0 ? 'failed' : 'passed');
  }

  /** Ends the run now: tests nobody finished count as skipped ("not tested"). */
  finishRun(runId: string) {
    const run = this.runs.getRun(runId);
    if (run.mode !== 'manual') throw new repo.RepoError(409, 'conflict', 'This run is automated, not manual');
    if (run.status !== 'running') throw new repo.RepoError(409, 'conflict', `This run is ${run.status}`);
    this.db
      .update(schema.runItems)
      .set({ status: 'skipped', errorMessage: 'Not tested', updatedAt: now() })
      .where(and(eq(schema.runItems.runId, runId), inArray(schema.runItems.status, ['queued', 'running'])))
      .run();
    this.complete(runId);
    return this.runs.getRun(runId);
  }
}

/** Fills {{data.x}}, {{env.x}} and {{vars.x}} in a step's params for reading; anything unknown stays as written. */
function fill<T>(value: T, scopes: Record<string, Record<string, unknown>>): T {
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string')
      return v.replace(/\{\{\s*(data|env|vars)\.([\w.-]+)\s*\}\}/g, (all, scope: string, key: string) => {
        const found = key
          .split('.')
          .reduce<unknown>(
            (o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
            scopes[scope],
          );
        return found === undefined || found === null || typeof found === 'object' ? all : String(found);
      });
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object')
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(value) as T;
}
