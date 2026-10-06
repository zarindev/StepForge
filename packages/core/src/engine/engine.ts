import { stepGroupOf, type Step, type StepGroup } from '../schemas/steps.ts';
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

export type RunTestCaseInput = {
  runId: string;
  steps: (Step & { id: string })[];
  data?: Record<string, unknown>;
  env?: Record<string, unknown>;
  secrets?: Record<string, string>;
  executors: Executor[];
  options: RunOptions;
  artifactsDir: string;
  signal?: AbortSignal;
  onEvent?: (e: EngineEvent) => void;
};

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

/** Resolves placeholders in everything an executor reads. */
function resolveStep(step: RunnableStep, r: VariableResolver): RunnableStep {
  return {
    ...step,
    params: r.resolve(step.params),
    locators: step.locators.map((l) => ({
      ...l,
      value: String(r.resolve(l.value)),
      ...(l.name && { name: String(r.resolve(l.name)) }),
    })),
    assertions: step.assertions.map((a) => ({ ...a, expected: r.resolve(a.expected) })),
  };
}

/**
 * Runs one test case: every step in order, with per-step retries and timeouts, assertions,
 * `captureAs`, soft failures (`continueOnFail`) and secret masking. Shared by the server and the CLI.
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
  let firstFailure: { stepId: string; kind: StepErrorKind; message: string } | undefined;
  let stopped = false;

  for (const [position, raw] of input.steps.entries()) {
    const step: RunnableStep = { ...raw, position };
    const base = { stepId: step.id, position, type: step.type, label: step.label ?? '' };
    if (!step.enabled || stopped || signal.aborted) {
      const message = !step.enabled
        ? 'Disabled'
        : signal.aborted
          ? 'Run cancelled'
          : 'Skipped after an earlier failure';
      const r: StepResult = {
        ...base,
        status: 'skipped',
        attempts: 0,
        durationMs: 0,
        message,
        assertions: [],
      };
      results.push(r);
      emit({ type: 'step.finished', result: r });
      continue;
    }

    emit({ type: 'step.started', stepId: step.id, position, stepType: step.type, label: base.label });
    const stepStarted = Date.now();
    const maxAttempts = step.retries + 1;
    const timeoutMs = step.timeoutMs ?? input.options.defaultTimeoutMs;
    let result: StepResult | undefined;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const stepCtx: StepContext = { ...ctx, timeoutMs, stepIndex: position };
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
          ctx.log('warn', `Step ${position + 1} failed (attempt ${attempt}/${maxAttempts}): ${message}`);
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

    results.push(result!);
    emit({ type: 'step.finished', result: result! });
    if (result!.status === 'failed' || result!.status === 'broken') {
      firstFailure ??= {
        stepId: step.id,
        kind: (result!.errorKind ?? 'unknown') as StepErrorKind,
        message: result!.message ?? '',
      };
      if (!step.continueOnFail) stopped = true;
    }
  }

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
