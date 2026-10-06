import { describeStep, describeSteps } from '@stepforge/core';
import { schema, type StepForgeDb } from '@stepforge/db';
import * as repo from '@stepforge/db/repos';
import {
  builtinRules,
  diagnose,
  loadRules,
  BUILTIN_RULES_DIR,
  type Diagnosis,
  type DiagnosisInput,
  type StepSnapshot,
} from '@stepforge/diagnosis';
import { and, desc, eq, lt, ne } from 'drizzle-orm';
import { existsSync, readFileSync } from 'node:fs';
import { release, type } from 'node:os';
import { join } from 'node:path';

type StepRow = typeof schema.stepResults.$inferSelect;
type ItemRow = typeof schema.runItems.$inferSelect;
type AnyStep = {
  id?: string;
  type: string;
  params?: Record<string, unknown>;
  locators?: unknown[];
  label?: string;
};

/** Finds a step by id anywhere in a step tree (if/else/loop bodies). */
function findStep(steps: AnyStep[], id: string | null): AnyStep | undefined {
  if (!id) return undefined;
  for (const s of steps) {
    if (s.id === id) return s;
    const p = s.params ?? {};
    for (const key of ['steps', 'else']) {
      const nested = p[key];
      if (Array.isArray(nested)) {
        const hit = findStep(nested as AnyStep[], id);
        if (hit) return hit;
      }
    }
  }
  return undefined;
}

function snapshot(row: StepRow): StepSnapshot {
  const r = (row.responseJson ?? {}) as Record<string, unknown>;
  return {
    stepId: row.stepId ?? undefined,
    type: row.type,
    label: row.label,
    path: r.path as string | undefined,
    status: row.status,
    message: row.message ?? undefined,
    errorKind: r.errorKind as string | undefined,
    durationMs: row.durationMs ?? undefined,
    assertions: (r.assertions as StepSnapshot['assertions']) ?? [],
    request: (row.requestJson as StepSnapshot['request']) ?? undefined,
    response: (r.body as StepSnapshot['response']) ?? undefined,
    query: (row.queryJson as StepSnapshot['query']) ?? undefined,
    email: r.email as StepSnapshot['email'],
    perf: r.perf as StepSnapshot['perf'],
    healedLocator: r.healedLocator as StepSnapshot['healedLocator'],
    diagnostics: r.diagnostics as StepSnapshot['diagnostics'],
  };
}

const SEVERITY = ['trivial', 'minor', 'major', 'critical'] as const;
const OWNER_LABEL = {
  app: 'application bug',
  test: 'the test needs updating',
  environment: 'environment problem',
  data: 'test data problem',
} as const;
const CRITICAL_CATEGORIES = new Set([
  'missing_auth',
  'server_error',
  'data_integrity',
  'js_exception',
  'validation_missing',
]);

/** Severity from the scenario priority, adjusted by who is likely responsible and how bad the category is. */
export function deriveSeverity(
  priority: string,
  d: Pick<Diagnosis, 'owner' | 'category'>,
): (typeof SEVERITY)[number] {
  let i = { P1: 3, P2: 2, P3: 1, P4: 0 }[priority] ?? 2;
  if (d.owner === 'test' || d.owner === 'environment') i = Math.min(i, 1);
  if (CRITICAL_CATEGORIES.has(d.category)) i = Math.max(i, 2);
  return SEVERITY[i]!;
}

const fmt = (v: unknown) => (v === undefined ? '' : typeof v === 'string' ? v : JSON.stringify(v));

/** Rule-based diagnosis of failed run items, and the bug reports filed from them. */
export class DiagnosisService {
  constructor(
    private readonly db: StepForgeDb,
    private readonly artifactsRoot: string,
    /** User rules: data/rules/*.yaml (override built-ins with the same id). */
    private readonly userRulesDir: string,
  ) {}

  rules() {
    return existsSync(this.userRulesDir) ? loadRules([BUILTIN_RULES_DIR, this.userRulesDir]) : builtinRules();
  }

  private readJson<T>(rel: string): T | undefined {
    try {
      return JSON.parse(readFileSync(join(this.artifactsRoot, rel), 'utf8')) as T;
    } catch {
      return undefined;
    }
  }

  /** Builds the diagnosis input for a failed item from what the runner stored. */
  input(itemId: string): {
    input: DiagnosisInput;
    item: ItemRow;
    failedRow: StepRow;
    run: typeof schema.runs.$inferSelect;
  } | null {
    const item = this.db.select().from(schema.runItems).where(eq(schema.runItems.id, itemId)).get();
    if (!item) throw repo.notFound('Run item', itemId);
    const run = this.db.select().from(schema.runs).where(eq(schema.runs.id, item.runId)).get()!;
    const steps = this.db
      .select()
      .from(schema.stepResults)
      .where(eq(schema.stepResults.runItemId, item.id))
      .orderBy(schema.stepResults.position)
      .all();
    const failedRow =
      steps.find((s) => s.stepId === item.failedStepId && (s.status === 'failed' || s.status === 'broken')) ??
      steps.find((s) => s.status === 'failed' || s.status === 'broken');
    if (!failedRow) return null;

    const failed = snapshot(failedRow);
    let scenarioSteps: AnyStep[] = [];
    if (item.scenarioId) {
      try {
        scenarioSteps = repo.getScenario(this.db, item.scenarioId).steps as AnyStep[];
      } catch {
        // scenario deleted
      }
    }
    const def = findStep(scenarioSteps, failedRow.stepId);
    if (def) {
      failed.locators = (def.locators ?? []) as StepSnapshot['locators'];
      failed.params = def.params;
      // "Where" reads as a sentence ("Send POST /api/patients") when the step has no label.
      if (!failedRow.label || failedRow.label === failedRow.type) failed.label = describeStep(def as never);
    }
    const opts = (run.optionsJson ?? {}) as { timeoutMs?: number };
    failed.timeoutMs = Number(
      (def?.params as { timeoutMs?: number } | undefined)?.timeoutMs ?? opts.timeoutMs ?? 15_000,
    );

    const artifacts = this.db
      .select()
      .from(schema.artifacts)
      .where(eq(schema.artifacts.runItemId, item.id))
      .all();
    const consoleLog = artifacts.find((a) => a.kind === 'console');
    const networkLog = artifacts.find((a) => a.kind === 'network');

    // History of the same test (scenario + test case), newest first, excluding this item.
    const sameTest = and(
      item.scenarioId ? eq(schema.runItems.scenarioId, item.scenarioId) : undefined,
      item.testCaseId ? eq(schema.runItems.testCaseId, item.testCaseId) : undefined,
      ne(schema.runItems.id, item.id),
      lt(schema.runItems.createdAt, item.createdAt),
    );
    const previous = this.db
      .select()
      .from(schema.runItems)
      .where(sameTest)
      .orderBy(desc(schema.runItems.createdAt))
      .limit(10)
      .all();
    const green = previous.find((p) => p.status === 'passed');
    let lastGreen: DiagnosisInput['lastGreen'];
    if (green) {
      const greenRun = this.db.select().from(schema.runs).where(eq(schema.runs.id, green.runId)).get();
      const greenEnv = greenRun?.environmentId
        ? this.db
            .select()
            .from(schema.environments)
            .where(eq(schema.environments.id, greenRun.environmentId))
            .get()
        : undefined;
      const greenStep = failedRow.stepId
        ? this.db
            .select()
            .from(schema.stepResults)
            .where(
              and(
                eq(schema.stepResults.runItemId, green.id),
                eq(schema.stepResults.stepId, failedRow.stepId),
              ),
            )
            .get()
        : undefined;
      lastGreen = {
        runId: green.runId,
        at: green.updatedAt,
        step: greenStep ? snapshot(greenStep) : undefined,
        durationMs: green.durationMs ?? undefined,
        browser: greenRun?.browser,
        baseUrl: greenEnv?.baseUrl,
      };
    }
    const env = run.environmentId
      ? this.db.select().from(schema.environments).where(eq(schema.environments.id, run.environmentId)).get()
      : undefined;
    return {
      item,
      run,
      failedRow,
      input: {
        failed,
        itemStatus: item.status,
        attempts: item.attempt,
        console: consoleLog ? this.readJson(consoleLog.path) : [],
        network: networkLog ? this.readJson(networkLog.path) : [],
        history: previous.map((p) => p.status),
        lastGreen,
        current: {
          browser: run.browser,
          baseUrl: env?.baseUrl,
          viewport: run.viewport,
          durationMs: item.durationMs ?? undefined,
        },
      },
    };
  }

  /** Diagnoses a failed item and stores the result on it. Returns null for items without a failed step. */
  diagnoseItem(itemId: string): Diagnosis | null {
    const ctx = this.input(itemId);
    if (!ctx) return null;
    const d = diagnose(ctx.input, this.rules());
    this.db.update(schema.runItems).set({ diagnosisJson: d }).where(eq(schema.runItems.id, itemId)).run();
    return d;
  }

  /** Diagnoses the item and files (or counts) its bug. */
  fileBug(itemId: string, extra: { browserVersion?: string } = {}) {
    const ctx = this.input(itemId);
    if (!ctx || !ctx.item.scenarioId) return null;
    const d = diagnose(ctx.input, this.rules());
    this.db.update(schema.runItems).set({ diagnosisJson: d }).where(eq(schema.runItems.id, itemId)).run();

    const { item, run, failedRow, input } = ctx;
    const scenario = repo.getScenario(this.db, item.scenarioId!);
    const env = run.environmentId ? repo.getEnvironment(this.db, run.environmentId) : undefined;
    const tc = item.testCaseId ? scenario.testCases.find((t) => t.id === item.testCaseId) : undefined;
    const data = (tc?.dataJson ?? {}) as Record<string, unknown>;

    // Plain-English steps with the test data filled in; secrets stay hidden.
    const failedPath = String((failedRow.responseJson as { path?: string } | null)?.path ?? '');
    const steps = describeSteps(scenario.steps as never).map((l) => {
      const text = l.text
        .replace(/\{\{\s*data\.([\w.]+)\s*\}\}/g, (m, k: string) =>
          data[k] !== undefined ? fmt(data[k]) : m,
        )
        .replace(/\{\{\s*env\.baseUrl\s*\}\}/g, env?.baseUrl ?? '{{env.baseUrl}}')
        .replace(/\{\{\s*secret\.[\w.]+\s*\}\}/g, '••••');
      return `${'  '.repeat(l.depth)}${l.number}. ${text}${l.number === failedPath ? '  ← fails here' : ''}`;
    });
    const failedAssertion = input.failed.assertions?.find((a) => !a.passed);
    const expected = failedAssertion
      ? `${failedAssertion.target} ${failedAssertion.operator}${failedAssertion.expected !== undefined ? ` ${fmt(failedAssertion.expected)}` : ''}`
      : tc?.expectedResult || 'The step succeeds';
    const actual =
      failedAssertion?.actual !== undefined
        ? `${fmt(failedAssertion.actual)} — ${failedRow.message ?? ''}`
        : (failedRow.message ?? '');

    const { bug, created, reopened } = repo.recordFailure(this.db, {
      applicationId: run.applicationId,
      runItemId: item.id,
      scenarioId: scenario.id,
      testCaseId: item.testCaseId,
      failedStepId: failedRow.stepId ?? failedRow.id,
      category: d.category,
      title: `${scenario.name}: ${d.title}`.slice(0, 300),
      summary: `${d.explanation}\n\nWhose issue: ${OWNER_LABEL[d.owner]}. How to fix: ${d.fix}`,
      severity: deriveSeverity(scenario.priority, d),
      priority: scenario.priority,
      environment: {
        name: env?.name,
        url: env?.baseUrl,
        browser: extra.browserVersion ?? run.browser,
        viewport: run.viewport,
        os: `${type()} ${release()}`,
        at: item.updatedAt,
        runId: run.id,
        ...(tc && { testCase: `${tc.code} ${tc.title}` }),
      },
      preconditions: scenario.preconditions ?? '',
      stepsToReproduce: steps,
      expected,
      actual,
      diagnosis: d,
      owner: d.owner,
    });
    return { bug, created, reopened, diagnosis: d };
  }
}
