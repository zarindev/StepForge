import { Step, stepGroupOf, type StepGroup } from '../schemas/steps.ts';
import { VariableResolutionError, VariableResolver } from '../variables.ts';
import { evaluateAssertion } from './assertions.ts';
import {
  BROKEN_KINDS,
  StepError,
  type ArtifactRef,
  type AssertionResult,
  type EngineEvent,
  type Executor,
  type ExecutorSession,
  type RunOptions,
  type RunnableStep,
  type StepContext,
  type StepErrorKind,
  type StepResult,
  type TestCaseResult,
  type TestContext,
} from './types.ts';

type InputStep = Step & { id: string };

export type RunTestCaseInput = {
  runId: string;
  steps: InputStep[];
  data?: Record<string, unknown>;
  env?: Record<string, unknown>;
  secrets?: Record<string, string>;
  executors: Executor[];
  options: RunOptions;
  artifactsDir: string;
  signal?: AbortSignal;
  onEvent?: (e: EngineEvent) => void;
  /** Resolves `util.callScenario` targets. */
  loadScenarioSteps?: (scenarioId: string) => InputStep[] | Promise<InputStep[]>;
  /** Resolves `util.useBlock` targets. */
  loadBlockSteps?: (blockId: string) => InputStep[] | Promise<InputStep[]>;
};

/** Control-flow steps are interpreted by the engine itself, not by an executor. */
export const CONTROL_STEP_TYPES = new Set(['util.if', 'util.loop', 'util.callScenario', 'util.useBlock']);
const MAX_LOOP_ITERATIONS = 1000;
const MAX_CALL_DEPTH = 5;

function classify(err: unknown): { kind: StepErrorKind; message: string } {
  if (err instanceof StepError || (err as { name?: string })?.name === 'StepError') {
    const e = err as StepError;
    return { kind: e.kind, message: e.message };
  }
  if (err instanceof VariableResolutionError) return { kind: 'variable', message: err.message };
  const e = err as Error;
  if (e?.name === 'TimeoutError') return { kind: 'timeout', message: e.message };
  return { kind: 'unknown', message: e?.message ?? String(err) };
}

function withTimeout<T>(p: Promise<T>, ms: number, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new StepError('timeout', `Step did not finish within ${ms} ms`)),
      ms,
    );
    const onAbort = () => reject(new StepError('aborted', 'Run was cancelled'));
    if (signal.aborted) onAbort();
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(resolve, reject).finally(() => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    });
  });
}

/** Resolves placeholders in everything an executor reads (nested step lists are resolved when they run). */
function resolveStep(step: RunnableStep, r: VariableResolver): RunnableStep {
  const { steps: nested, else: elseSteps, ...rest } = step.params as Record<string, unknown>;
  return {
    ...step,
    params: {
      ...r.resolve(rest),
      ...(nested !== undefined && { steps: nested }),
      ...(elseSteps !== undefined && { else: elseSteps }),
    },
    locators: step.locators.map((l) => ({
      ...l,
      value: String(r.resolve(l.value)),
      ...(l.name && { name: String(r.resolve(l.name)) }),
    })),
    assertions: step.assertions.map((a) => ({ ...a, expected: r.resolve(a.expected) })),
  };
}

/** Parses nested step lists from control-step params, giving each child a stable runtime id. */
function childSteps(raw: unknown, parentId: string, key: string): InputStep[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((s, i) => {
    const parsed = Step.safeParse(s);
    if (!parsed.success) {
      throw new StepError(
        'invalid_params',
        `Nested step ${i + 1}: ${parsed.error.issues.map((x) => x.message).join('; ')}`,
      );
    }
    return { ...parsed.data, id: (s as { id?: string }).id ?? `${parentId}:${key}${i}` };
  });
}

/**
 * Runs one test case: every step in order (including nested control flow), with per-step retries and
 * timeouts, assertions, `captureAs`, soft failures (`continueOnFail`) and secret masking.
 * Shared by the server and the CLI.
 */
export async function runTestCase(input: RunTestCaseInput): Promise<TestCaseResult> {
  const started = Date.now();
  const signal = input.signal ?? new AbortController().signal;
  const resolver = new VariableResolver({
    env: input.env ?? {},
    secret: input.secrets ?? {},
    data: input.data ?? {},
    run: { id: input.runId },
    vars: {},
  });
  const emit = (e: EngineEvent) => input.onEvent?.(e);
  const ctx: TestContext = {
    runId: input.runId,
    artifactsDir: input.artifactsDir,
    resolver,
    options: input.options,
    signal,
    shared: new Map(),
    log: (level, message) => emit({ type: 'log', level, message: resolver.mask(message) }),
  };

  const executors = new Map<StepGroup, Executor>(input.executors.map((e) => [e.group, e]));
  const sessions = new Map<StepGroup, ExecutorSession>();
  const sessionFor = async (group: StepGroup): Promise<ExecutorSession> => {
    const existing = sessions.get(group);
    if (existing) return existing;
    const ex = executors.get(group);
    if (!ex) throw new StepError('unsupported', `No executor is installed for "${group}" steps yet`);
    const s = await ex.createSession(ctx);
    sessions.set(group, s);
    return s;
  };

  const results: StepResult[] = [];
  let counter = 0;
  let firstFailure: { stepId: string; kind: StepErrorKind; message: string } | undefined;
  let stopped = false;

  const record = (r: StepResult) => {
    results.push(r);
    emit({ type: 'step.finished', result: r });
    if ((r.status === 'failed' || r.status === 'broken') && !CONTROL_STEP_TYPES.has(r.type)) {
      firstFailure ??= {
        stepId: r.stepId,
        kind: (r.errorKind ?? 'unknown') as StepErrorKind,
        message: r.message ?? '',
      };
    }
  };

  /** Runs a list of steps; returns false if a hard failure stopped execution. */
  const runList = async (
    list: InputStep[],
    prefix: string,
    depth: number,
    callDepth: number,
  ): Promise<boolean> => {
    for (const [i, raw] of list.entries()) {
      const path = prefix ? `${prefix}.${i + 1}` : String(i + 1);
      const position = counter++;
      const step: RunnableStep = { ...raw, position };
      const base = { stepId: step.id, position, path, depth, type: step.type, label: step.label ?? '' };
      if (!step.enabled || stopped || signal.aborted) {
        const message = !step.enabled
          ? 'Disabled'
          : signal.aborted
            ? 'Run cancelled'
            : 'Skipped after an earlier failure';
        record({ ...base, status: 'skipped', attempts: 0, durationMs: 0, message, assertions: [] });
        continue;
      }
      emit({
        type: 'step.started',
        stepId: step.id,
        position,
        path,
        depth,
        stepType: step.type,
        label: base.label,
      });
      const result = CONTROL_STEP_TYPES.has(step.type)
        ? await runControl(step, base, callDepth)
        : await runLeaf(step, base);
      record(result);
      if (result.status === 'failed' || result.status === 'broken') {
        if (!step.continueOnFail) stopped = true;
      }
    }
    return !stopped;
  };

  const runLeaf = async (
    step: RunnableStep,
    base: Omit<StepResult, 'status' | 'attempts' | 'durationMs' | 'assertions'>,
  ): Promise<StepResult> => {
    const stepStarted = Date.now();
    const maxAttempts = step.retries + 1;
    const timeoutMs = step.timeoutMs ?? input.options.defaultTimeoutMs;
    let result: StepResult | undefined;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const stepCtx: StepContext = { ...ctx, timeoutMs, stepIndex: step.position };
      const assertions: AssertionResult[] = [];
      let session: ExecutorSession | undefined;
      let resolved: RunnableStep = step;
      try {
        resolved = resolveStep(step, resolver);
        session = await sessionFor(stepGroupOf(step.type));
        // Guard slightly above the step timeout: executors enforce their own timeouts first.
        const outcome = await withTimeout(session.execute(resolved, stepCtx), timeoutMs + 5_000, signal);
        for (const a of resolved.assertions) {
          const actual = outcome.getTarget ? await outcome.getTarget(a.target) : undefined;
          assertions.push(evaluateAssertion(a, actual));
        }
        const failed = assertions.filter((a) => !a.passed);
        if (failed.length) throw new StepError('assertion', failed.map((a) => a.message).join('; '));
        if (step.captureAs) resolver.setVar(step.captureAs, outcome.output);
        result = {
          ...base,
          status: 'passed',
          attempts: attempt,
          durationMs: Date.now() - stepStarted,
          message: outcome.message ? resolver.mask(outcome.message) : undefined,
          assertions,
          request: outcome.request,
          response: outcome.response,
          query: outcome.query,
          screenshotPath: outcome.screenshotPath,
          healedLocator: outcome.healedLocator,
          metrics: outcome.metrics,
        };
        break;
      } catch (err) {
        const { kind, message } = classify(err);
        const retryable = attempt < maxAttempts && !BROKEN_KINDS.has(kind) && kind !== 'aborted';
        if (retryable) {
          ctx.log('warn', `Step ${base.path} failed (attempt ${attempt}/${maxAttempts}): ${message}`);
          continue;
        }
        let evidence: Awaited<ReturnType<NonNullable<ExecutorSession['onStepFailed']>>> = {};
        if (session?.onStepFailed && kind !== 'aborted') {
          try {
            evidence = await session.onStepFailed(resolved, stepCtx);
          } catch {
            // evidence collection must never mask the real failure
          }
        }
        result = {
          ...base,
          status: kind === 'aborted' ? 'skipped' : BROKEN_KINDS.has(kind) ? 'broken' : 'failed',
          attempts: attempt,
          durationMs: Date.now() - stepStarted,
          message: resolver.mask(message),
          errorKind: kind,
          assertions,
          screenshotPath: evidence.screenshotPath,
          request: evidence.request,
          response: evidence.response,
        };
        break;
      }
    }
    return result!;
  };

  const runControl = async (
    step: RunnableStep,
    base: Omit<StepResult, 'status' | 'attempts' | 'durationMs' | 'assertions'>,
    callDepth: number,
  ): Promise<StepResult> => {
    const t0 = Date.now();
    const done = (
      status: StepResult['status'],
      message: string,
      errorKind?: StepErrorKind,
      assertions: AssertionResult[] = [],
    ): StepResult => ({
      ...base,
      status,
      attempts: 1,
      durationMs: Date.now() - t0,
      message: resolver.mask(message),
      errorKind,
      assertions,
    });
    try {
      const resolved = resolveStep(step, resolver);
      const p = resolved.params as Record<string, unknown>;
      const failedBefore = results.length;
      const childFailed = () =>
        results
          .slice(failedBefore)
          .some((r) => (r.status === 'failed' || r.status === 'broken') && !CONTROL_STEP_TYPES.has(r.type));

      if (step.type === 'util.if') {
        const c = (p.condition ?? {}) as { value?: unknown; operator?: string; expected?: unknown };
        const check = evaluateAssertion(
          { target: 'condition', operator: (c.operator ?? 'equals') as never, expected: c.expected },
          c.value,
        );
        const branch = check.passed ? childSteps(p.steps, step.id, 't') : childSteps(p.else, step.id, 'e');
        const which = check.passed ? 'then' : 'else';
        await runList(branch, `${base.path}${check.passed ? '' : 'e'}`, base.depth + 1, callDepth);
        const msg = `Condition ${check.passed ? 'true' : 'false'} → ${which} (${branch.length} step${branch.length === 1 ? '' : 's'})`;
        return childFailed()
          ? done('failed', `${msg}; a nested step failed`, 'assertion')
          : done('passed', msg);
      }

      if (step.type === 'util.loop') {
        const children = childSteps(p.steps, step.id, 'l');
        const as = typeof p.as === 'string' && p.as ? p.as : 'item';
        let items: unknown[];
        if (p.over !== undefined) {
          if (!Array.isArray(p.over))
            throw new StepError('invalid_params', 'loop "over" must resolve to an array');
          items = p.over;
        } else {
          const count = Number(p.count ?? 1);
          if (!Number.isInteger(count) || count < 0)
            throw new StepError('invalid_params', 'loop "count" must be a non-negative integer');
          items = Array.from({ length: count }, (_, i) => i + 1);
        }
        if (items.length > MAX_LOOP_ITERATIONS)
          throw new StepError('invalid_params', `loop is limited to ${MAX_LOOP_ITERATIONS} iterations`);
        let ran = 0;
        for (const [i, item] of items.entries()) {
          if (stopped || signal.aborted) break;
          resolver.setVar(as, item);
          resolver.setVar('index', i);
          await runList(children, `${base.path}[${i + 1}]`, base.depth + 1, callDepth);
          ran++;
        }
        const msg = `Ran ${ran}/${items.length} iteration(s)`;
        return childFailed()
          ? done('failed', `${msg}; a nested step failed`, 'assertion')
          : done('passed', msg);
      }

      // callScenario / useBlock
      if (callDepth >= MAX_CALL_DEPTH)
        throw new StepError(
          'invalid_params',
          `Calls nested deeper than ${MAX_CALL_DEPTH} levels (recursion?)`,
        );
      const isBlock = step.type === 'util.useBlock';
      const targetId = String(isBlock ? (p.blockId ?? '') : (p.scenarioId ?? ''));
      if (!targetId)
        throw new StepError('invalid_params', `${step.type} needs "${isBlock ? 'blockId' : 'scenarioId'}"`);
      const loader = isBlock ? input.loadBlockSteps : input.loadScenarioSteps;
      if (!loader) throw new StepError('unsupported', `${step.type} is not available in this context`);
      let target: InputStep[];
      try {
        target = (await loader(targetId)).map((s) => ({ ...s, id: `${step.id}>${s.id}` }));
      } catch (err) {
        throw new StepError(
          'invalid_params',
          `Cannot load ${isBlock ? 'block' : 'scenario'} "${targetId}": ${(err as Error).message}`,
        );
      }
      await runList(target, base.path, base.depth + 1, callDepth + 1);
      const msg = `Ran ${isBlock ? 'block' : 'scenario'} (${target.length} steps)`;
      return childFailed()
        ? done('failed', `${msg}; a nested step failed`, 'assertion')
        : done('passed', msg);
    } catch (err) {
      const { kind, message } = classify(err);
      const status = BROKEN_KINDS.has(kind) ? 'broken' : 'failed';
      firstFailure ??= { stepId: step.id, kind, message };
      return done(status, message, kind);
    }
  };

  await runList(input.steps, '', 0, 0);

  const failed = !!firstFailure;
  const artifacts: ArtifactRef[] = [];
  for (const s of sessions.values()) {
    try {
      artifacts.push(...(await s.close({ failed })));
    } catch (err) {
      ctx.log('warn', `Executor cleanup failed: ${(err as Error).message}`);
    }
  }

  const status =
    signal.aborted && !failed
      ? 'skipped'
      : firstFailure
        ? BROKEN_KINDS.has(firstFailure.kind)
          ? 'broken'
          : 'failed'
        : 'passed';
  return {
    status,
    durationMs: Date.now() - started,
    steps: results,
    error: firstFailure?.message,
    errorKind: firstFailure?.kind,
    failedStepId: firstFailure?.stepId,
    artifacts,
    vars: resolver.snapshotVars(),
  };
}
