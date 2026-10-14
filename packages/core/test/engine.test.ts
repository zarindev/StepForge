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
    ['noNulls', [1, 'a', 0], undefined, true],
    ['noNulls', [1, null], undefined, false],
    ['unique', ['a', 'b', 'c'], undefined, true],
    ['unique', [1, 2, 1], undefined, false],
    ['inRange', [0, 5, 10], { min: 0, max: 10 }, true],
    ['inRange', 11, [0, 10], false],
    ['inRange', -4, '0..', false],
    ['inRange', '7', '..9', true],
    ['inRange', [null], '0..', false],
  ] as const)('%s(%j, %j) → %s', (operator, actual, expected, passed) => {
    expect(evaluateAssertion({ target: 't', operator, expected }, actual).passed).toBe(passed);
  });

  it('writes a readable failure message', () => {
    expect(evaluateAssertion({ target: 'status', operator: 'equals', expected: 201 }, 500).message).toBe(
      'Expected status equals 201, but got 500',
    );
  });
});

describe('control flow', () => {
  const util = (log: string[]): Executor => ({
    group: 'util',
    async createSession(ctx) {
      return {
        async execute(step) {
          const p = step.params as Record<string, unknown>;
          if (step.type === 'util.setVariable') ctx.resolver.setVar(String(p.name), p.value);
          if (step.type === 'util.log') log.push(String(p.message));
          if (p.fail) throw new StepError('assertion', 'nested boom');
          return {};
        },
        async close() {
          return [];
        },
      };
    },
  });
  const go = (
    s: ReturnType<typeof steps>,
    extra: Partial<Parameters<typeof runTestCase>[0]> = {},
    log: string[] = [],
  ) =>
    runTestCase({
      runId: 'R',
      steps: s,
      executors: [util(log)],
      options: opts,
      artifactsDir: '/tmp',
      ...extra,
    });
  const logStep = (message: string) => ({ type: 'util.log', params: { message } });

  it('if/else picks a branch from a value comparison', async () => {
    const log: string[] = [];
    const r = await go(
      steps(
        { type: 'util.setVariable', params: { name: 'n', value: 3 } },
        {
          type: 'util.if',
          params: {
            condition: { value: '{{vars.n}}', operator: 'gt', expected: 2 },
            steps: [logStep('big')],
            else: [logStep('small')],
          },
        },
        {
          type: 'util.if',
          params: {
            condition: { value: '{{vars.n}}', operator: 'gt', expected: 5 },
            steps: [logStep('huge')],
            else: [logStep('not huge')],
          },
        },
      ),
      {},
      log,
    );
    expect(r.status).toBe('passed');
    expect(log).toEqual(['big', 'not huge']);
    expect(r.steps.find((s) => s.type === 'util.log' && s.depth === 1)?.path).toBe('2.1');
    expect(r.steps.find((s) => s.path === '3e.1')).toBeDefined();
  });

  it('loops over a count and over an array, exposing item and index', async () => {
    const log: string[] = [];
    const r = await go(
      steps(
        { type: 'util.loop', params: { count: 2, steps: [logStep('tick {{vars.item}}')] } },
        {
          type: 'util.loop',
          params: { over: ['a', 'b', 'c'], as: 'letter', steps: [logStep('{{vars.index}}:{{vars.letter}}')] },
        },
      ),
      {},
      log,
    );
    expect(log).toEqual(['tick 1', 'tick 2', '0:a', '1:b', '2:c']);
    expect(r.steps.map((s) => s.path)).toContain('2[3].1');
    expect(r.steps.find((s) => s.type === 'util.loop')?.message).toBe('Ran 2/2 iteration(s)');
  });

  it('repeats while a condition holds, re-checked before every pass; the count is a safety limit', async () => {
    const log: string[] = [];
    const r = await go(
      steps(
        { type: 'util.setVariable', params: { name: 'status', value: 0 } },
        {
          type: 'util.loop',
          params: {
            while: { value: '{{vars.status}}', operator: 'lt', expected: 2 },
            steps: [
              { type: 'util.setVariable', params: { name: 'status', value: '{{vars.index}}' } },
              logStep('pass {{vars.index}}'),
            ],
          },
        },
      ),
      {},
      log,
    );
    expect(r.status).toBe('passed');
    expect(log).toEqual(['pass 0', 'pass 1', 'pass 2']);
    expect(r.steps.find((s) => s.type === 'util.loop')?.message).toMatch(/^Repeated 3 time\(s\)/);

    const stuck = await go(
      steps({
        type: 'util.loop',
        params: {
          while: { value: 'x', operator: 'equals', expected: 'x' },
          count: 4,
          steps: [logStep('again')],
        },
      }),
    );
    expect(stuck.status).toBe('failed');
    expect(stuck.steps.find((s) => s.type === 'util.loop')?.message).toBe(
      'Stopped after the limit of 4 pass(es); the condition still held',
    );
  });

  it('page conditions ask the UI session to probe the step’s element', async () => {
    const log: string[] = [];
    const probes: string[] = [];
    let visibleFor = 2;
    const ui: Executor = {
      group: 'ui',
      async createSession() {
        return {
          async execute() {
            return {};
          },
          async probe(req) {
            probes.push(`${req.check} ${req.locators[0]?.value} ${req.timeoutMs}`);
            const ok = req.check === 'visible' ? visibleFor-- > 0 : false;
            return { ok, detail: ok ? 'yes' : 'no' };
          },
          async close() {
            return [];
          },
        };
      },
    };
    const more = [{ strategy: 'text' as const, value: 'Load more' }];
    const r = await go(
      steps(
        {
          type: 'util.loop',
          locators: more,
          params: { while: { type: 'element', check: 'visible' }, steps: [logStep('click')] },
        },
        {
          type: 'util.if',
          locators: more,
          params: {
            condition: { type: 'element', check: 'present', timeoutMs: 50 },
            steps: [logStep('still there')],
            else: [logStep('gone')],
          },
        },
      ),
      { executors: [util(log), ui] },
      log,
    );
    expect(r.status).toBe('passed');
    expect(log).toEqual(['click', 'click', 'gone']);
    expect(probes).toEqual([
      'visible Load more 2000',
      'visible Load more 2000',
      'visible Load more 2000',
      'present Load more 50',
    ]);
    expect(r.steps.find((s) => s.type === 'util.if')?.message).toBe(
      'Condition false (present check: no) → else (1 step)',
    );
  });

  it('an automated run skips manual checks without failing', async () => {
    const log: string[] = [];
    const r = await go(
      steps(
        {
          type: 'util.manual',
          params: { instruction: 'Check the printed receipt', expected: 'Logo is sharp' },
        },
        logStep('after'),
      ),
      {},
      log,
    );
    expect(r.status).toBe('passed');
    expect(log).toEqual(['after']);
    expect(r.steps[0]).toMatchObject({
      status: 'skipped',
      message: 'Manual check, done in a manual run: Check the printed receipt',
    });
  });

  it('a failing nested step fails the parent and stops the test', async () => {
    const log: string[] = [];
    const r = await go(
      steps(
        {
          type: 'util.loop',
          params: { count: 3, steps: [{ type: 'util.log', params: { message: 'x', fail: true } }] },
        },
        logStep('after'),
      ),
      {},
      log,
    );
    expect(r.status).toBe('failed');
    expect(r.error).toBe('nested boom');
    expect(log).toEqual(['x']);
    expect(r.steps.find((s) => s.type === 'util.loop')?.status).toBe('failed');
    expect(r.steps.at(-1)).toMatchObject({ path: '2', status: 'skipped' });
  });

  it('callScenario and useBlock run loaded steps; recursion is capped; invalid nested steps are broken', async () => {
    const log: string[] = [];
    const loginId = newId();
    const r = await go(
      steps(
        { type: 'util.useBlock', params: { blockId: 'B1' } },
        { type: 'util.callScenario', params: { scenarioId: 'S1' } },
      ),
      {
        loadBlockSteps: () => steps(logStep('block step')),
        loadScenarioSteps: () => [{ ...steps(logStep('scenario step'))[0]!, id: loginId }],
      },
      log,
    );
    expect(r.status).toBe('passed');
    expect(log).toEqual(['block step', 'scenario step']);

    const self = await go(steps({ type: 'util.callScenario', params: { scenarioId: 'S' } }), {
      loadScenarioSteps: () => steps({ type: 'util.callScenario', params: { scenarioId: 'S' } }),
    });
    expect(self.status).toBe('broken');
    expect(self.error).toMatch(/deeper than 5/);

    const bad = await go(
      steps({
        type: 'util.if',
        params: {
          condition: { value: 1, operator: 'equals', expected: 1 },
          steps: [{ type: 'ui.teleport' }],
        },
      }),
    );
    expect(bad).toMatchObject({ status: 'broken', errorKind: 'invalid_params' });
    expect((await go(steps({ type: 'util.callScenario', params: { scenarioId: 'S' } }))).errorKind).toBe(
      'unsupported',
    );
  });

  it('block inputs are scoped to the block: the caller’s variables come back afterwards', async () => {
    const log: string[] = [];
    const r = await go(
      steps(
        { type: 'util.setVariable', params: { name: 'user', value: 'caller' } },
        { type: 'util.useBlock', params: { blockId: 'B', inputs: { user: 'block-user', extra: 'x' } } },
        logStep('after {{vars.user}}'),
      ),
      {
        loadBlockSteps: () => ({
          steps: steps(logStep('inside {{vars.user}} {{vars.extra}}')),
          inputs: [{ name: 'user' }],
        }),
      },
      log,
    );
    expect(r.status).toBe('passed');
    expect(log).toEqual(['inside block-user x', 'after caller']);
    expect(r.vars).toEqual({ user: 'caller' });
  });

  it('block input defaults are resolved like any other value', async () => {
    const log: string[] = [];
    const r = await go(
      steps({ type: 'util.useBlock', params: { blockId: 'B' } }),
      {
        env: { admin: 'root@x.test' },
        loadBlockSteps: () => ({
          steps: steps(logStep('as {{vars.email}}')),
          inputs: [{ name: 'email', default: '{{env.admin}}' }],
        }),
      },
      log,
    );
    expect(r.status).toBe('passed');
    expect(log).toEqual(['as root@x.test']);
  });

  it('a while condition and an if condition may use variables set later (resolved when evaluated)', async () => {
    const log: string[] = [];
    const r = await go(
      steps(
        {
          type: 'util.loop',
          params: {
            while: { value: '{{vars.index}}', operator: 'lt', expected: 2 },
            steps: [{ type: 'util.setVariable', params: { name: 'later', value: 'set' } }, logStep('pass')],
          },
        },
        {
          type: 'util.if',
          params: {
            condition: { value: '{{vars.later}}', operator: 'equals', expected: 'set' },
            steps: [logStep('yes')],
          },
        },
      ),
      {},
      log,
    );
    expect(r.status).toBe('passed');
    expect(log).toEqual(['pass', 'pass', 'yes']);
  });
});

describe('saved elements', () => {
  const seen: unknown[] = [];
  const ui: Executor = {
    group: 'ui',
    async createSession() {
      return {
        async execute(step) {
          seen.push(step.locators.map((l) => `${l.strategy}=${l.value}`));
          return {};
        },
        async close() {
          return [];
        },
      };
    },
  };
  const click = (locators: { strategy: string; value: string }[]) =>
    steps({ type: 'ui.click', locators: locators as never });

  it('drops a deleted element while other locators remain; fails only when none are left', async () => {
    seen.length = 0;
    const ok = await run(
      click([
        { strategy: 'element', value: 'GONE' },
        { strategy: 'element', value: 'E1' },
        { strategy: 'css', value: '#b' },
      ]),
      { executors: [ui], elements: { E1: [{ strategy: 'css', value: '#a' }] as never } },
    );
    expect(ok.status).toBe('passed');
    expect(seen).toEqual([['css=#a', 'css=#b']]);

    const none = await run(click([{ strategy: 'element', value: 'GONE' }]), {
      executors: [ui],
      elements: {},
    });
    expect(none).toMatchObject({ status: 'broken', errorKind: 'invalid_params' });
    expect(none.error).toMatch(/was deleted/);
  });
});
