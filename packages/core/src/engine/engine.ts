import { Step, stepGroupOf, type Locator, type StepGroup } from '../schemas/steps.ts';
import type { ProbeCheck } from './types.ts';
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
  type StepOutcome,
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
  /** Hooks: steps run before the test (a failure skips the test) and after it (always, even after a failure). */
  before?: InputStep[];
  after?: InputStep[];
  /** Saved elements of the application (id → locators) for steps that use `element` locators. */
  elements?: Record<string, Locator[]>;
  /** Resolves `util.useBlock` targets: the block's steps, and the inputs it declares (set as `vars`). */
  loadBlockSteps?: (blockId: string) => BlockTarget | InputStep[] | Promise<BlockTarget | InputStep[]>;
};

/** A loaded block: its steps and declared inputs (`{{vars.<name>}}` inside the block). */
export type BlockTarget = {
  steps: InputStep[];
  name?: string;
  inputs?: { name: string; default?: string }[];
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

function withTimeout<T>(p: Promise<T>, ms: number, signal: AbortSignal, what = 'Step'): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new StepError('timeout', `${what} did not finish within ${ms} ms`)),
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

/**
 * Replaces `element` locators with the saved element's current locators (best first). A deleted element is
 * dropped while the step still has other locators to try; only a step left with none fails.
 */
function expandElements(locators: RunnableStep['locators'], elements?: Record<string, Locator[]>) {
  if (!locators.some((l) => l.strategy === 'element')) return locators;
  const expanded = locators.flatMap((l) => (l.strategy === 'element' ? (elements?.[l.value] ?? []) : [l]));
  if (!expanded.length)
    throw new StepError(
      'invalid_params',
      'The saved element this step uses was deleted; choose another element',
    );
  return expanded;
}

/**
 * Resolves placeholders in everything an executor reads. Nested step lists are resolved when they run, and
 * the conditions of `util.if` / `util.loop` each time they are evaluated (so they can use variables set later).
 */
function resolveStep(
  step: RunnableStep,
  r: VariableResolver,
  elements?: Record<string, Locator[]>,
): RunnableStep {
  const { steps: nested, else: elseSteps, ...rest } = step.params as Record<string, unknown>;
  const deferred: Record<string, unknown> = {};
  if (step.type === 'util.if' || step.type === 'util.loop')
    for (const key of ['condition', 'while'])
      if (rest[key] !== undefined) {
        deferred[key] = rest[key];
        delete rest[key];
      }
  return {
    ...step,
    params: {
      ...r.resolve(rest),
      ...deferred,
      ...(nested !== undefined && { steps: nested }),
      ...(elseSteps !== undefined && { else: elseSteps }),
    },
    locators: expandElements(step.locators, elements).map((l) => ({
      ...l,
      value: String(r.resolve(l.value)),
      ...(l.name && { name: String(r.resolve(l.name)) }),
    })),
    assertions: step.assertions.map((a) => ({ ...a, expected: r.resolve(a.expected) })),
  };
}

/**
 * Parses nested step lists from control-step params, giving each child a stable runtime id: its own id, or
 * `<parentId>:<key><n>`. Inside a block or called scenario the own id keeps the call chain (`useStep>`), like
 * the block's top-level steps, so the run step can be traced back to its owner.
 */
function childSteps(raw: unknown, parentId: string, key: string): InputStep[] {
  if (!Array.isArray(raw)) return [];
  const chain = parentId.slice(0, parentId.lastIndexOf('>') + 1);
  return raw.map((s, i) => {
    const parsed = Step.safeParse(s);
    if (!parsed.success) {
      throw new StepError(
        'invalid_params',
        `Nested step ${i + 1}: ${parsed.error.issues.map((x) => x.message).join('; ')}`,
      );
    }
    const own = (s as { id?: string }).id;
    return { ...parsed.data, id: own ? `${chain}${own}` : `${parentId}:${key}${i}` };
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
  // Kept by reference so block inputs can be restored afterwards (the resolver only offers setVar).
  const vars: Record<string, unknown> = {};
  const resolver = new VariableResolver({
    env: input.env ?? {},
    secret: input.secrets ?? {},
    data: input.data ?? {},
    run: { id: input.runId },
    vars,
  });
  const emit = (e: EngineEvent) => input.onEvent?.(e);
  const ctx: TestContext = {
    runId: input.runId,
    artifactsDir: input.artifactsDir,
    resolver,
    options: input.options,
    signal,
    shared: new Map(),
    startedAt: started,
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

  /** Secrets must never be persisted: request/response payloads are masked before they leave the engine. */
  const maskDeep = <T>(v: T): T => resolver.maskDeep(v);

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
    /** Numbering starts after this many steps (after-hooks run one at a time). */
    offset = 0,
  ): Promise<boolean> => {
    for (const [index, raw] of list.entries()) {
      const i = index + offset;
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
      if (step.type === 'util.manual') {
        // Done by a person in a manual run; an automated run notes it and goes on.
        const p = step.params as { instruction?: unknown };
        record({
          ...base,
          status: 'skipped',
          attempts: 0,
          durationMs: 0,
          message: `Manual check, done in a manual run: ${resolver.mask(String(p.instruction ?? ''))}`,
          assertions: [],
        });
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
      const control = CONTROL_STEP_TYPES.has(step.type);
      const result = control ? await runControl(step, base, callDepth) : await runLeaf(step, base);
      record(result);
      if (result.status === 'failed' || result.status === 'broken') {
        // A control step (if, loop, block) fails when a nested step failed. If those failures were all allowed to
        // continue, the test continues too; a nested failure that stops the test has already set `stopped`.
        const onlySoftChildren = control && !stopped && result.message?.endsWith('; a nested step failed');
        if (!step.continueOnFail && !onlySoftChildren) stopped = true;
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
    // A step that waits on purpose (e.g. email.waitForEmail) declares its own timeout in params.timeoutMs.
    const paramTimeout = Number((step.params as { timeoutMs?: unknown }).timeoutMs);
    const timeoutMs =
      step.timeoutMs ??
      (Number.isFinite(paramTimeout) && paramTimeout > 0 ? paramTimeout : input.options.defaultTimeoutMs);
    let result: StepResult | undefined;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const stepCtx: StepContext = { ...ctx, timeoutMs, stepIndex: step.position };
      const assertions: AssertionResult[] = [];
      let session: ExecutorSession | undefined;
      let resolved: RunnableStep = step;
      // Kept for failures after the action itself succeeded (e.g. an API assertion): its request/response matter most.
      let outcome: StepOutcome | undefined;
      try {
        resolved = resolveStep(step, resolver, input.elements);
        session = await sessionFor(stepGroupOf(step.type));
        // Guard slightly above the step timeout: executors enforce their own timeouts first.
        // The message names the step, so a hang can be traced ("Step 4 (ui.fill) did not finish …").
        outcome = await withTimeout(
          session.execute(resolved, stepCtx),
          timeoutMs + 5_000,
          signal,
          `Step ${step.position + 1} (${step.type})`,
        );
        assertions.push(...(outcome.assertions ?? []));
        for (const a of resolved.assertions) {
          const custom = outcome.evaluate ? await outcome.evaluate(a) : undefined;
          if (custom) {
            assertions.push(custom);
            continue;
          }
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
          assertions: maskDeep(assertions),
          request: maskDeep(outcome.request),
          response: maskDeep(outcome.response),
          query: maskDeep(outcome.query),
          email: maskDeep(outcome.email),
          perf: maskDeep(outcome.perf),
          visual: outcome.visual,
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
          assertions: maskDeep(assertions),
          screenshotPath: evidence.screenshotPath ?? outcome?.screenshotPath,
          request: maskDeep(outcome?.request ?? evidence.request),
          response: maskDeep(outcome?.response ?? evidence.response),
          query: maskDeep(outcome?.query),
          email: maskDeep(outcome?.email),
          perf: maskDeep(outcome?.perf),
          visual: outcome?.visual,
          diagnostics: maskDeep(evidence.diagnostics),
          healedLocator: outcome?.healedLocator,
          metrics: outcome?.metrics,
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
      const resolved = resolveStep(step, resolver, input.elements);
      const p = resolved.params as Record<string, unknown>;
      const failedBefore = results.length;
      const childFailed = () =>
        results
          .slice(failedBefore)
          .some((r) => (r.status === 'failed' || r.status === 'broken') && !CONTROL_STEP_TYPES.has(r.type));

      /**
       * A condition is either a value comparison, or (type "element") a check on the page — visible, hidden, present,
       * absent, enabled, text contains, count — on the control step's own element, with a short wait.
       */
      const evaluate = async (raw: unknown): Promise<{ passed: boolean; detail: string }> => {
        // Resolved now (not when the step started), so a loop sees variables its steps changed.
        const c = resolver.resolve(raw ?? {}) as {
          type?: string;
          value?: unknown;
          operator?: string;
          expected?: unknown;
          check?: string;
          timeoutMs?: unknown;
        };
        if (c.type === 'element') {
          const session = await sessionFor('ui');
          if (!session.probe) throw new StepError('unsupported', 'Page conditions need the UI executor');
          const timeoutMs = Number(c.timeoutMs ?? 2000);
          const r = await session.probe(
            {
              locators: resolved.locators,
              check: (c.check ?? 'visible') as ProbeCheck,
              expected: c.expected,
              timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : 2000,
            },
            { ...ctx, timeoutMs: step.timeoutMs ?? input.options.defaultTimeoutMs, stepIndex: step.position },
          );
          return { passed: r.ok, detail: `${c.check ?? 'visible'} check: ${r.detail}` };
        }
        const check = evaluateAssertion(
          { target: 'condition', operator: (c.operator ?? 'equals') as never, expected: c.expected },
          c.value,
        );
        return { passed: check.passed, detail: check.message };
      };

      if (step.type === 'util.if') {
        const check = await evaluate((step.params as Record<string, unknown>).condition);
        const branch = check.passed ? childSteps(p.steps, step.id, 't') : childSteps(p.else, step.id, 'e');
        const which = check.passed ? 'then' : 'else';
        await runList(branch, `${base.path}${check.passed ? '' : 'e'}`, base.depth + 1, callDepth);
        const msg = `Condition ${check.passed ? 'true' : 'false'} (${check.detail}) → ${which} (${branch.length} step${branch.length === 1 ? '' : 's'})`;
        return childFailed()
          ? done('failed', `${msg}; a nested step failed`, 'assertion')
          : done('passed', msg);
      }

      if (step.type === 'util.loop' && p.while !== undefined) {
        // "Repeat while": checked before every pass; the count (default 100) is a safety limit.
        const children = childSteps(p.steps, step.id, 'l');
        const max = Math.min(Number(p.count ?? 100) || 100, MAX_LOOP_ITERATIONS);
        let ran = 0;
        let last = { passed: true, detail: '' };
        // An outer loop's index is back once this loop is done.
        const restore = resolver.saveVars(['index']);
        try {
          while (ran < max && !stopped && !signal.aborted) {
            // Set before the check, so the condition can use {{vars.index}} on the first pass too.
            resolver.setVar('index', ran);
            last = await evaluate((step.params as Record<string, unknown>).while);
            if (!last.passed) break;
            await runList(children, `${base.path}[${ran + 1}]`, base.depth + 1, callDepth);
            ran++;
          }
        } finally {
          restore();
        }
        const msg =
          ran >= max && last.passed
            ? `Stopped after the limit of ${max} pass(es); the condition still held`
            : `Repeated ${ran} time(s) while the condition held (${last.detail})`;
        if (childFailed()) return done('failed', `${msg}; a nested step failed`, 'assertion');
        if (ran >= max && last.passed) {
          // The loop itself failed (no nested step did), so it is the test's failure.
          firstFailure ??= { stepId: step.id, kind: 'assertion', message: msg };
          return done('failed', msg, 'assertion');
        }
        return done('passed', msg);
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
        // An outer loop's index and item are back once this loop is done.
        const restore = resolver.saveVars([as, 'index']);
        try {
          for (const [i, item] of items.entries()) {
            if (stopped || signal.aborted) break;
            resolver.setVar(as, item);
            resolver.setVar('index', i);
            await runList(children, `${base.path}[${i + 1}]`, base.depth + 1, callDepth);
            ran++;
          }
        } finally {
          restore();
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
      let declared: BlockTarget['inputs'] = [];
      try {
        const loaded = await loader(targetId);
        const list = Array.isArray(loaded) ? loaded : loaded.steps;
        if (!Array.isArray(loaded)) declared = loaded.inputs ?? [];
        target = list.map((s) => ({ ...s, id: `${step.id}>${s.id}` }));
      } catch (err) {
        throw new StepError(
          'invalid_params',
          `Cannot load ${isBlock ? 'block' : 'scenario'} "${targetId}": ${(err as Error).message}`,
        );
      }
      // Block inputs become variables for the block's steps: the value this step passes, else the default.
      const given = (isBlock && p.inputs && typeof p.inputs === 'object' ? p.inputs : {}) as Record<
        string,
        unknown
      >;
      const inputNames: string[] = [];
      // Inputs are scoped to the block: the caller's variables of the same name come back afterwards.
      const saved = new Map<string, { existed: boolean; value: unknown }>();
      const setInput = (name: string, value: unknown) => {
        if (!saved.has(name)) saved.set(name, { existed: Object.hasOwn(vars, name), value: vars[name] });
        resolver.setVar(name, value);
        inputNames.push(name);
      };
      try {
        for (const def of declared ?? []) {
          const passed = given[def.name] !== undefined && given[def.name] !== '';
          // A default may itself use placeholders, e.g. {{env.admin}}.
          const value = passed
            ? given[def.name]
            : def.default === undefined
              ? undefined
              : resolver.resolve(def.default);
          if (value === undefined)
            throw new StepError('invalid_params', `The block needs a value for its input "${def.name}"`);
          setInput(def.name, value);
        }
        for (const [name, value] of Object.entries(given))
          if (!inputNames.includes(name) && value !== undefined) setInput(name, value);
        await runList(target, base.path, base.depth + 1, callDepth + 1);
      } finally {
        for (const [name, prev] of saved) {
          if (prev.existed) vars[name] = prev.value;
          else delete vars[name];
        }
      }
      const msg = `Ran ${isBlock ? 'block' : 'scenario'} (${target.length} steps)${inputNames.length ? ` with ${inputNames.join(', ')}` : ''}`;
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

  // Before-hooks (paths "before.n"), then the test, then after-hooks ("after.n") — which run even after a failure,
  // so cleanup happens; a cancelled run skips them.
  if (input.before?.length) await runList(input.before, 'before', 0, 0);
  await runList(input.steps, '', 0, 0);
  // Each after-hook runs even when an earlier one failed: one broken cleanup must not skip the others.
  for (const [i, hook] of (input.after ?? []).entries()) {
    if (signal.aborted) break;
    stopped = false;
    await runList([hook], 'after', 0, 0, i);
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
