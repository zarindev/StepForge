import { DEFAULT_RUN_OPTIONS, newId, runTestCase, type StepInput } from '@stepforge/core';
import { describe, expect, it } from 'vitest';
import { fromPattern, generate, runSandboxed, utilExecutor } from '../src/index.ts';

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
const run = (s: ReturnType<typeof steps>) =>
  runTestCase({
    runId: 'R',
    steps: s,
    executors: [utilExecutor],
    options: { ...DEFAULT_RUN_OPTIONS, defaultTimeoutMs: 2000 },
    artifactsDir: '/tmp',
  });

describe('util executor', () => {
  it('sets variables, generates data and chains them', async () => {
    const r = await run(
      steps(
        { type: 'util.setVariable', params: { name: 'greeting', value: 'hi' } },
        { type: 'util.generateData', params: { kind: 'pattern', pattern: 'PAT-####' }, captureAs: 'code' },
        {
          type: 'util.log',
          params: { message: '{{vars.greeting}} {{vars.code}}' },
          assertions: [{ target: 'x', operator: 'notExists' }],
        },
      ),
    );
    expect(r.status).toBe('passed');
    expect(r.vars.code).toMatch(/^PAT-\d{4}$/);
    expect(r.steps[2]!.message).toMatch(/^hi PAT-\d{4}$/);
  });

  it('runs sandboxed scripts that can read and write vars', async () => {
    const r = await run(
      steps(
        { type: 'util.setVariable', params: { name: 'n', value: 20 } },
        {
          type: 'util.runScript',
          params: { code: 'vars.total = vars.n * 2 + 2; console.log("ok"); return vars.total;' },
          captureAs: 'answer',
        },
      ),
    );
    expect(r.status).toBe('passed');
    expect(r.vars).toMatchObject({ n: 20, total: 42, answer: 42 });
  });

  it('blocks require/process and stops infinite loops', () => {
    expect(() => runSandboxed('return require("fs")', { vars: {}, data: {}, env: {} }, 1000)).toThrow(
      /require is not defined/,
    );
    expect(() => runSandboxed('return process.env', { vars: {}, data: {}, env: {} }, 1000)).toThrow(
      /process is not defined/,
    );
    expect(() => runSandboxed('return eval("1")', { vars: {}, data: {}, env: {} }, 1000)).toThrow(
      /Script error/,
    );
    expect(() => runSandboxed('while(true){}', { vars: {}, data: {}, env: {} }, 200)).toThrow(/timed out/);
  });

  it('script errors make the test broken, control flow is reported as unsupported', async () => {
    expect(
      (await run(steps({ type: 'util.runScript', params: { code: 'throw new Error("boom")' } }))).errorKind,
    ).toBe('script');
    expect((await run(steps({ type: 'util.loop' }))).errorKind).toBe('unsupported');
  });

  it('generators produce plausible values', () => {
    expect(generate('email', {})).toMatch(/@example\.test$/);
    expect(generate('number', { min: 5, max: 5 })).toBe(5);
    expect(generate('date', { direction: 'future' })).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(fromPattern('??-##')).toMatch(/^[A-Z]{2}-\d{2}$/);
    expect(() => generate('nope', {})).toThrow(/Unknown data kind/);
  });
});
