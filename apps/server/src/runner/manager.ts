import {
  CreateRunInput,
  DEFAULT_RUN_OPTIONS,
  newId,
  runTestCase,
  VIEWPORT_PRESETS,
  type RunOptions,
  type RunOptionsInput,
  type StepResult,
  type TestCaseResult,
} from '@stepforge/core';
import { schema, type StepForgeDb } from '@stepforge/db';
import * as repo from '@stepforge/db/repos';
import { createApiExecutor } from '@stepforge/executor-api';
import { createDbExecutor } from '@stepforge/executor-db';
import { createUiExecutor, BrowserPool } from '@stepforge/executor-ui';
import { utilExecutor } from '@stepforge/executor-util';
import { and, eq, inArray } from 'drizzle-orm';
import { mkdirSync, rmSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { z } from 'zod';
import type { EventBus } from '../context.ts';
import type { SpecService } from '../api/specs.ts';
import type { DatabaseService } from '../database/service.ts';
import { expandScope, testCaseData, unfinishedItems } from './scope.ts';

type Run = typeof schema.runs.$inferSelect;
type RunItem = typeof schema.runItems.$inferSelect;
type Totals = {
  total: number;
  passed: number;
  failed: number;
  broken: number;
  skipped: number;
  flaky: number;
};

const now = () => new Date().toISOString();
const FINAL_ITEM = ['passed', 'failed', 'broken', 'skipped', 'flaky'];

/**
 * Persisted, in-process run queue. One run executes at a time; inside a run, `workers` test cases run in
 * parallel. All state is in SQLite, so a restart leaves runs `interrupted` and they can be resumed.
 */
export class RunManager {
  private queue: string[] = [];
  private active: { runId: string; abort: AbortController } | null = null;
  private draining: Promise<void> | null = null;

  constructor(
    private readonly db: StepForgeDb,
    private readonly bus: EventBus,
    private readonly artifactsRoot: string,
    private readonly masterKey: Buffer,
    private readonly defaults: () => { timeoutMs: number },
    private readonly specs?: SpecService,
    private readonly database?: DatabaseService,
  ) {}

  /** Path relative to the artifacts root with forward slashes (used in URLs). */
  rel(abs: string): string {
    return relative(this.artifactsRoot, abs).split(sep).join('/');
  }

  create(input: z.input<typeof CreateRunInput>): Run {
    const d = CreateRunInput.parse(input);
    repo.getApplication(this.db, d.applicationId);
    const env = repo.getEnvironment(this.db, d.environmentId);
    if (env.applicationId !== d.applicationId)
      throw new repo.RepoError(400, 'invalid', 'Environment belongs to another application');
    const planned = expandScope(this.db, d.applicationId, d.scope);
    if (planned.length === 0)
      throw new repo.RepoError(400, 'empty_scope', 'Nothing to run: the selection has no runnable scenarios');

    const runId = newId();
    this.db.transaction(() => {
      this.db
        .insert(schema.runs)
        .values({
          id: runId,
          applicationId: d.applicationId,
          environmentId: d.environmentId,
          trigger: d.trigger,
          scopeJson: d.scope,
          browser: d.options.browser,
          viewport: d.options.viewport,
          workers: d.options.workers,
          optionsJson: d.options,
          status: 'queued',
          totalsJson: { total: planned.length, passed: 0, failed: 0, broken: 0, skipped: 0, flaky: 0 },
        })
        .run();
      planned.forEach((p, position) =>
        this.db
          .insert(schema.runItems)
          .values({
            id: newId(),
            runId,
            scenarioId: p.scenarioId,
            testCaseId: p.testCaseId,
            labelJson: p.label,
            position,
            status: 'queued',
          })
          .run(),
      );
    });
    this.enqueue(runId);
    return this.getRun(runId);
  }

  getRun(id: string): Run {
    const r = this.db.select().from(schema.runs).where(eq(schema.runs.id, id)).get();
    if (!r) throw repo.notFound('Run', id);
    return r;
  }

  enqueue(runId: string): void {
    if (!this.queue.includes(runId)) this.queue.push(runId);
    this.draining ??= this.drain().finally(() => (this.draining = null));
  }

  /** Resolves when the queue is idle (used by tests and graceful shutdown). */
  async idle(): Promise<void> {
    while (this.draining) await this.draining;
  }

  cancel(runId: string): Run {
    const run = this.getRun(runId);
    if (this.active?.runId === runId) this.active.abort.abort();
    else if (run.status === 'queued' || run.status === 'interrupted') {
      this.queue = this.queue.filter((q) => q !== runId);
      this.db
        .update(schema.runItems)
        .set({ status: 'skipped', errorMessage: 'Run cancelled', updatedAt: now() })
        .where(and(eq(schema.runItems.runId, runId), inArray(schema.runItems.status, ['queued', 'running'])))
        .run();
      this.finish(runId, 'cancelled');
    }
    return this.getRun(runId);
  }

  resume(runId: string): Run {
    const run = this.getRun(runId);
    if (run.status !== 'interrupted')
      throw new repo.RepoError(
        409,
        'conflict',
        `Only interrupted runs can be resumed (this one is ${run.status})`,
      );
    this.db
      .update(schema.runItems)
      .set({ status: 'queued', updatedAt: now() })
      .where(and(eq(schema.runItems.runId, runId), eq(schema.runItems.status, 'running')))
      .run();
    this.db
      .update(schema.runs)
      .set({ status: 'queued', updatedAt: now() })
      .where(eq(schema.runs.id, runId))
      .run();
    this.publishRun(runId);
    this.enqueue(runId);
    return this.getRun(runId);
  }

  delete(runId: string): void {
    const run = this.getRun(runId);
    if (run.status === 'running' || run.status === 'queued')
      throw new repo.RepoError(409, 'conflict', 'Cancel the run before deleting it');
    this.db.delete(schema.runs).where(eq(schema.runs.id, runId)).run();
    rmSync(join(this.artifactsRoot, 'runs', runId), { recursive: true, force: true });
  }

  /** Marks the active run interrupted on shutdown so it can be resumed later. */
  async shutdown(): Promise<void> {
    this.queue = [];
    if (this.active) {
      const id = this.active.runId;
      this.active.abort.abort('shutdown');
      await this.idle();
      this.db
        .update(schema.runs)
        .set({ status: 'interrupted', updatedAt: now() })
        .where(eq(schema.runs.id, id))
        .run();
    }
  }

  private async drain(): Promise<void> {
    for (let next = this.queue.shift(); next; next = this.queue.shift()) {
      try {
        await this.execute(next);
      } catch (err) {
        this.bus.publish({
          type: 'run.log',
          runId: next,
          level: 'error',
          message: `Run crashed: ${(err as Error).message}`,
        });
        this.finish(next, 'failed');
      }
    }
  }

  private toRunOptions(o: RunOptionsInput, baseUrl: string): RunOptions {
    return {
      ...DEFAULT_RUN_OPTIONS,
      browser: o.browser,
      viewport: VIEWPORT_PRESETS[o.viewport],
      headed: o.headed,
      video: o.video,
      trace: o.trace,
      screenshots: o.screenshots,
      defaultTimeoutMs: o.timeoutMs ?? this.defaults().timeoutMs,
      baseUrl,
    };
  }

  private async execute(runId: string): Promise<void> {
    const run = this.getRun(runId);
    if (run.status === 'cancelled') return;
    const opts = run.optionsJson as RunOptionsInput;
    const env = repo.getEnvironment(this.db, run.environmentId!);
    const secrets = repo.resolveSecrets(this.db, this.masterKey, env.id);
    const options = this.toRunOptions(opts, env.baseUrl);
    const envScope = { ...env.variablesJson, baseUrl: env.baseUrl, name: env.name };
    const abort = new AbortController();
    this.active = { runId, abort };
    const pool = new BrowserPool();
    const specs = this.specs;
    const executors = [
      createUiExecutor(pool),
      createApiExecutor({
        contracts: specs
          ? async (ref, req, res) => {
              const specId = ref.specId ?? specs.latestFor(run.applicationId);
              return specId ? specs.check(specId, req, res) : null;
            }
          : undefined,
      }),
      ...(this.database ? [createDbExecutor({ resolve: this.database.resolverFor(env.id) })] : []),
      utilExecutor,
    ];
    const startedAt = run.startedAt ?? now();
    this.db
      .update(schema.runs)
      .set({ status: 'running', startedAt, updatedAt: now() })
      .where(eq(schema.runs.id, runId))
      .run();
    this.publishRun(runId);

    const pending = unfinishedItems(this.db, runId);
    let stop = false;
    const worker = async () => {
      for (let item = pending.shift(); item && !abort.signal.aborted && !stop; item = pending.shift()) {
        const status = await this.executeItem(run, item, {
          options,
          envScope,
          secrets,
          executors,
          signal: abort.signal,
          retries: opts.retries,
        });
        if (opts.stopOnFirstFailure && (status === 'failed' || status === 'broken')) stop = true;
      }
    };
    try {
      await Promise.all(Array.from({ length: Math.max(1, run.workers) }, worker));
    } finally {
      await pool.closeAll();
      this.active = null;
    }

    if (abort.signal.reason === 'shutdown') return; // left as interrupted by shutdown()
    const leftoverReason = abort.signal.aborted ? 'Run cancelled' : 'Stopped after the first failure';
    this.db
      .update(schema.runItems)
      .set({ status: 'skipped', errorMessage: leftoverReason, updatedAt: now() })
      .where(and(eq(schema.runItems.runId, runId), inArray(schema.runItems.status, ['queued', 'running'])))
      .run();
    const totals = this.totals(runId);
    this.finish(
      runId,
      abort.signal.aborted ? 'cancelled' : totals.failed + totals.broken > 0 ? 'failed' : 'passed',
    );
  }

  private async executeItem(
    run: Run,
    item: RunItem,
    ctx: {
      options: RunOptions;
      envScope: Record<string, unknown>;
      secrets: Record<string, string>;
      executors: Parameters<typeof runTestCase>[0]['executors'];
      signal: AbortSignal;
      retries: number;
    },
  ): Promise<string> {
    if (!item.scenarioId) {
      this.saveItem(item, { status: 'skipped', errorMessage: 'Scenario was deleted before the run started' });
      return 'skipped';
    }
    let scenario: repo.ScenarioDetail;
    try {
      scenario = repo.getScenario(this.db, item.scenarioId);
    } catch {
      this.saveItem(item, { status: 'skipped', errorMessage: 'Scenario was deleted before the run started' });
      return 'skipped';
    }
    const data = testCaseData(this.db, item.testCaseId);
    const maxAttempts = ctx.retries + 1;
    let result: TestCaseResult | undefined;
    let attempt = 0;
    let sawFailure = false;

    while (attempt < maxAttempts) {
      attempt++;
      const dir = join(this.artifactsRoot, 'runs', run.id, item.id, `a${attempt}`);
      mkdirSync(dir, { recursive: true });
      this.saveItem(item, {
        status: 'running',
        attempt,
        scenarioVersion: scenario.version,
        errorMessage: null,
      });
      result = await runTestCase({
        runId: run.id,
        steps: scenario.steps.map((s) => ({ ...s, id: s.id })),
        data,
        env: ctx.envScope,
        secrets: ctx.secrets,
        executors: ctx.executors,
        options: ctx.options,
        artifactsDir: dir,
        signal: ctx.signal,
        loadScenarioSteps: (id) => {
          if (repo.applicationIdForScenario(this.db, id) !== run.applicationId)
            throw new Error('scenario belongs to another application');
          return repo.getScenario(this.db, id).steps.map((s) => ({ ...s, id: s.id }));
        },
        loadBlockSteps: (id) => {
          const block = repo.getBlock(this.db, id);
          if (block.applicationId !== run.applicationId)
            throw new Error('block belongs to another application');
          return block.steps.map((s) => ({ ...s, id: s.id }));
        },
        onEvent: (e) => {
          if (e.type === 'step.started') this.bus.publish({ ...e, runId: run.id, itemId: item.id, attempt });
          else if (e.type === 'step.finished')
            this.bus.publish({
              type: 'step.finished',
              runId: run.id,
              itemId: item.id,
              attempt,
              result: this.publicStep(e.result),
            });
          else
            this.bus.publish({
              type: 'run.log',
              runId: run.id,
              itemId: item.id,
              level: e.level,
              message: e.message,
            });
        },
      });
      if (result.status === 'passed' || result.status === 'skipped' || ctx.signal.aborted) break;
      sawFailure = true;
      if (attempt < maxAttempts)
        this.bus.publish({
          type: 'run.log',
          runId: run.id,
          itemId: item.id,
          level: 'warn',
          message: `Retrying (attempt ${attempt + 1}/${maxAttempts})`,
        });
    }

    const r = result!;
    const status = r.status === 'passed' && sawFailure ? 'flaky' : r.status;
    this.persistResult(item.id, r);
    this.saveItem(item, {
      status,
      attempt,
      durationMs: r.durationMs,
      errorMessage: r.error ?? (status === 'skipped' ? 'Run cancelled' : null),
      failedStepId: r.failedStepId ?? null,
    });
    this.publishRun(run.id);
    return status;
  }

  private publicStep(s: StepResult) {
    return { ...s, screenshotPath: s.screenshotPath ? this.rel(s.screenshotPath) : undefined };
  }

  private persistResult(itemId: string, r: TestCaseResult): void {
    this.db.transaction(() => {
      this.db.delete(schema.stepResults).where(eq(schema.stepResults.runItemId, itemId)).run();
      this.db.delete(schema.artifacts).where(eq(schema.artifacts.runItemId, itemId)).run();
      for (const s of r.steps) {
        this.db
          .insert(schema.stepResults)
          .values({
            id: newId(),
            runItemId: itemId,
            stepId: s.stepId,
            position: s.position,
            type: s.type,
            label: s.label,
            status: s.status,
            durationMs: s.durationMs,
            message: s.message ?? null,
            requestJson: s.request ?? null,
            responseJson: {
              ...(s.response ? { body: s.response } : {}),
              assertions: s.assertions,
              attempts: s.attempts,
              path: s.path,
              depth: s.depth,
              errorKind: s.errorKind,
              healedLocator: s.healedLocator,
            },
            queryJson: s.query ?? null,
            screenshotPath: s.screenshotPath ? this.rel(s.screenshotPath) : null,
          })
          .run();
      }
      for (const a of r.artifacts) {
        let size = 0;
        try {
          size = statSync(a.path).size;
        } catch {
          continue;
        }
        this.db
          .insert(schema.artifacts)
          .values({ id: newId(), runItemId: itemId, kind: a.kind, path: this.rel(a.path), size })
          .run();
      }
    });
  }

  private saveItem(item: RunItem, patch: Partial<RunItem>): void {
    this.db
      .update(schema.runItems)
      .set({ ...patch, updatedAt: now() })
      .where(eq(schema.runItems.id, item.id))
      .run();
    const fresh = this.db.select().from(schema.runItems).where(eq(schema.runItems.id, item.id)).get();
    this.bus.publish({ type: 'item.updated', runId: item.runId, item: fresh });
  }

  totals(runId: string): Totals {
    const items = this.db
      .select({ status: schema.runItems.status })
      .from(schema.runItems)
      .where(eq(schema.runItems.runId, runId))
      .all();
    const t: Totals = { total: items.length, passed: 0, failed: 0, broken: 0, skipped: 0, flaky: 0 };
    for (const i of items) if (FINAL_ITEM.includes(i.status)) t[i.status as keyof Omit<Totals, 'total'>]++;
    return t;
  }

  private publishRun(runId: string): void {
    this.db
      .update(schema.runs)
      .set({ totalsJson: this.totals(runId) })
      .where(eq(schema.runs.id, runId))
      .run();
    this.bus.publish({ type: 'run.updated', run: this.getRun(runId) });
  }

  private finish(runId: string, status: 'passed' | 'failed' | 'cancelled'): void {
    const run = this.getRun(runId);
    const finishedAt = now();
    this.db
      .update(schema.runs)
      .set({
        status,
        finishedAt,
        durationMs: run.startedAt ? Date.parse(finishedAt) - Date.parse(run.startedAt) : 0,
        totalsJson: this.totals(runId),
        updatedAt: finishedAt,
      })
      .where(eq(schema.runs.id, runId))
      .run();
    this.publishRun(runId);
  }
}
