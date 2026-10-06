import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RUN_OPTIONS,
  evaluateAssertion,
  newId,
  runTestCase,
  StepError,
  type EngineEvent,
  type Executor,
  type StepInput,
} from '../src/index.ts';

/** A fake "ui" executor driven by step params. */
function fakeUi(log: string[] = [], closed: { failed?: boolean } = {}): Executor {
  return {
    group: 'ui',
    async createSession() {
      let flaky = 0;
      return {
        async execute(step) {
          log.push(`${step.type}:${JSON.stringify(step.params)}`);
          const p = step.params as Record<string, unknown>;
          if (p.fail) throw new StepError('element_not_found', `No element for ${String(p.fail)}`);
          if (p.flakyTimes && flaky++ < Number(p.flakyTimes)) throw new StepError('timeout', 'flaky');
          if (p.hang) await new Promise((r) => setTimeout(r, 10_000));
          return {
            output: p.out,
            message: `did ${step.type}`,
            getTarget: (t) => (p.targets as Record<string, unknown>)?.[t],
          };
        },
        async onStepFailed() {
          return { screenshotPath: '/tmp/fail.png' };
        },
        async close(r) {
          closed.failed = r.failed;
          return [{ kind: 'video', path: '/tmp/v.webm' }];
        },
      };
    },
  };
}

const opts = { ...DEFAULT_RUN_OPTIONS, defaultTimeoutMs: 1000 };
const steps = (...s: StepInput[]) =>
  s.map((x) => ({
    enabled: true,
    continueOnFail: false,
    retries: 0,
    params: {},
    locators: [],
    assertions: [],
    id: newId(),
    ...x,
  }));
const run = (s: ReturnType<typeof steps>, extra: Partial<Parameters<typeof runTestCase>[0]> = {}) =>
  runTestCase({
    runId: 'RUN1',
    steps: s,
    executors: [fakeUi()],
    options: opts,
    artifactsDir: '/tmp',
    ...extra,
  });

describe('runTestCase', () => {
  it('passes, resolves variables and captures outputs', async () => {
    const log: string[] = [];
    const r = await runTestCase({
      runId: 'RUN1',
      steps: steps(
        { type: 'ui.navigate', params: { url: '{{env.baseUrl}}/login' } },
        { type: 'ui.extract', params: { out: 'ABC-123' }, captureAs: 'code' },
        { type: 'ui.fill', params: { value: '{{vars.code}} {{data.email}} {{run.id}}' } },
      ),
      env: { baseUrl: 'http://x.test' },
      data: { email: 'a@b.c' },
      executors: [fakeUi(log)],
      options: opts,
      artifactsDir: '/tmp',
    });
    expect(r.status).toBe('passed');
    expect(log[0]).toContain('http://x.test/login');
    expect(log[2]).toContain('ABC-123 a@b.c RUN1');
    expect(r.vars).toEqual({ code: 'ABC-123' });
    expect(r.artifacts).toHaveLength(1);
  });

  it('stops at the first failure, skips the rest and collects evidence', async () => {
    const closed: { failed?: boolean } = {};
    const r = await run(
      steps({ type: 'ui.click' }, { type: 'ui.click', params: { fail: '#save' } }, { type: 'ui.click' }),
      {
        executors: [fakeUi([], closed)],
      },
    );
    expect(r.status).toBe('failed');
    expect(r.errorKind).toBe('element_not_found');
    expect(r.steps.map((s) => s.status)).toEqual(['passed', 'failed', 'skipped']);
    expect(r.steps[1]!.screenshotPath).toBe('/tmp/fail.png');
    expect(r.failedStepId).toBe(r.steps[1]!.stepId);
    expect(closed.failed).toBe(true);
  });

  it('continueOnFail records the failure but keeps going (soft failure)', async () => {
    const r = await run(
      steps({ type: 'ui.click', params: { fail: 'x' }, continueOnFail: true }, { type: 'ui.click' }),
    );
    expect(r.steps.map((s) => s.status)).toEqual(['failed', 'passed']);
    expect(r.status).toBe('failed');
  });

  it('retries a step and reports attempts', async () => {
    const r = await run(steps({ type: 'ui.click', params: { flakyTimes: 2 }, retries: 2 }));
    expect(r.status).toBe('passed');
    expect(r.steps[0]!.attempts).toBe(3);
  });

  it('evaluates step assertions against executor targets', async () => {
    const ok = await run(
      steps({
        type: 'ui.click',
        params: { targets: { url: 'http://x/dash' } },
        assertions: [{ target: 'url', operator: 'contains', expected: '/dash' }],
      }),
    );
    expect(ok.status).toBe('passed');
    const bad = await run(
      steps({
        type: 'ui.click',
        params: { targets: { url: 'http://x/login' } },
        assertions: [{ target: 'url', operator: 'contains', expected: '/dash' }],
      }),
    );
    expect(bad.status).toBe('failed');
    expect(bad.errorKind).toBe('assertion');
    expect(bad.steps[0]!.assertions[0]).toMatchObject({ passed: false, actual: 'http://x/login' });
  });

  it('marks configuration problems as broken without retrying', async () => {
    const unknownVar = await run(
      steps({ type: 'ui.fill', params: { value: '{{data.missing}}' }, retries: 3 }),
    );
    expect(unknownVar.status).toBe('broken');
    expect(unknownVar.steps[0]).toMatchObject({ errorKind: 'variable', attempts: 1 });
    const noExecutor = await run(steps({ type: 'db.query' }));
    expect(noExecutor).toMatchObject({ status: 'broken', errorKind: 'unsupported' });
  });

  it('enforces step timeouts', async () => {
    const r = await run(steps({ type: 'ui.click', params: { hang: true }, timeoutMs: 50 }));
    expect(r.errorKind).toBe('timeout');
  }, 10_000);

  it('skips disabled steps and honours cancellation', async () => {
    const ac = new AbortController();
    const events: EngineEvent[] = [];
    const r = await run(
      steps(
        { type: 'ui.click', enabled: false },
        { type: 'ui.click', params: { hang: true } },
        { type: 'ui.click' },
      ),
      {
        signal: ac.signal,
        onEvent: (e) => {
          events.push(e);
          if (e.type === 'step.started' && e.position === 1) setTimeout(() => ac.abort(), 20);
        },
      },
    );
    expect(r.steps.map((s) => s.status)).toEqual(['skipped', 'skipped', 'skipped']);
    expect(r.status).toBe('skipped');
    expect(events.some((e) => e.type === 'step.started')).toBe(true);
  });

  it('masks secrets in messages and captured vars', async () => {
    const r = await runTestCase({
      runId: 'R',
      steps: steps(
        { type: 'ui.extract', params: { out: 'tok=hunter2' }, captureAs: 'v' },
        { type: 'ui.click', params: { fail: '{{secret.pw}}' } },
      ),
      secrets: { pw: 'hunter2' },
      executors: [fakeUi()],
      options: opts,
      artifactsDir: '/tmp',
    });
    expect(r.steps[1]!.message).toBe('No element for ••••');
    expect(r.vars).toEqual({ v: 'tok=••••' });
  });
});

describe('evaluateAssertion', () => {
  it.each([
    ['equals', 200, '200', true],
    ['equals', 'a', 'b', false],
    ['contains', 'Welcome back', 'Welcome', true],
    ['contains', ['a', 'b'], 'b', true],
    ['matches', 'INV-0042', '^INV-\\d+$', true],
    ['lt', 120, 800, true],
    ['gte', 3, 4, false],
    ['isEmpty', [], undefined, true],
    ['isNotEmpty', 'x', undefined, true],
    ['lengthEquals', [1, 2, 3], 3, true],
    ['exists', null, undefined, false],
  ] as const)('%s(%j, %j) → %s', (operator, actual, expected, passed) => {
    expect(evaluateAssertion({ target: 't', operator, expected }, actual).passed).toBe(passed);
  });

  it('writes a readable failure message', () => {
    expect(evaluateAssertion({ target: 'status', operator: 'equals', expected: 201 }, 500).message).toBe(
      'Expected status equals 201, but got 500',
    );
  });
});
