import { faker } from '@faker-js/faker';
import {
  StepError,
  type Executor,
  type ExecutorSession,
  type RunnableStep,
  type StepContext,
  type StepOutcome,
} from '@stepforge/core';
import { runInNewContext } from 'node:vm';

const MAX_SCRIPT_MS = 5_000;

/** Replaces # with a digit, ? with a letter and * with either, e.g. "PAT-####". */
export function fromPattern(pattern: string): string {
  return pattern.replace(/[#?*]/g, (c) =>
    c === '#'
      ? String(faker.number.int(9))
      : c === '?'
        ? faker.string.alpha({ casing: 'upper' })
        : faker.string.alphanumeric(1).toUpperCase(),
  );
}

export function generate(kind: string, p: Record<string, unknown>): unknown {
  switch (kind) {
    case 'name':
      return faker.person.fullName();
    case 'firstName':
      return faker.person.firstName();
    case 'lastName':
      return faker.person.lastName();
    case 'email':
      // example.test is reserved (RFC 2606): generated mail never reaches a real inbox.
      return faker.internet.email({ provider: String(p.domain ?? 'example.test') }).toLowerCase();
    case 'phone':
      return fromPattern(String(p.pattern ?? '+1-555-###-####'));
    case 'date': {
      const d =
        p.direction === 'future'
          ? faker.date.soon({ days: Number(p.days ?? 30) })
          : faker.date.past({ years: Number(p.years ?? 1) });
      return d.toISOString().slice(0, 10);
    }
    case 'birthdate':
      return faker.date
        .birthdate({ min: Number(p.minAge ?? 18), max: Number(p.maxAge ?? 80), mode: 'age' })
        .toISOString()
        .slice(0, 10);
    case 'number':
      return faker.number.int({ min: Number(p.min ?? 0), max: Number(p.max ?? 1000) });
    case 'uuid':
      return faker.string.uuid();
    case 'word':
      return faker.lorem.word();
    case 'sentence':
      return faker.lorem.sentence();
    case 'address':
      return faker.location.streetAddress();
    case 'company':
      return faker.company.name();
    case 'pattern':
      return fromPattern(String(p.pattern ?? '####'));
    default:
      throw new StepError('invalid_params', `Unknown data kind "${kind}"`);
  }
}

/**
 * Runs user JavaScript in a fresh V8 context with a timeout. The context only receives plain copies of
 * vars/data/env and a captured console: no `require`, `process`, filesystem or network.
 * Note: node:vm isolates globals but is not a hardened security boundary; scripts are authored by the user.
 */
export function runSandboxed(
  code: string,
  input: { vars: unknown; data: unknown; env: unknown },
  timeoutMs: number,
) {
  const logs: string[] = [];
  const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v ?? {})) as T;
  const sandbox = {
    vars: clone(input.vars),
    data: clone(input.data),
    env: clone(input.env),
    console: {
      log: (...a: unknown[]) =>
        logs.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')),
    },
  };
  try {
    const result: unknown = runInNewContext(`'use strict'; (() => { ${code}\n })()`, sandbox, {
      timeout: Math.min(timeoutMs, MAX_SCRIPT_MS),
      contextCodeGeneration: { strings: false, wasm: false },
    });
    return {
      result: result === undefined ? undefined : clone(result),
      vars: sandbox.vars as Record<string, unknown>,
      logs,
    };
  } catch (err) {
    throw new StepError('script', `Script error: ${(err as Error).message}`);
  }
}

class UtilSession implements ExecutorSession {
  async execute(step: RunnableStep, ctx: StepContext): Promise<StepOutcome> {
    const p = step.params as Record<string, unknown>;
    const name = step.type.split('.')[1];
    switch (name) {
      case 'setVariable': {
        if (typeof p.name !== 'string' || !p.name)
          throw new StepError('invalid_params', 'setVariable needs a "name"');
        ctx.resolver.setVar(p.name, p.value);
        return { output: p.value, message: `vars.${p.name} set` };
      }
      case 'wait': {
        const ms = Math.max(0, Number(p.ms ?? 1000));
        ctx.log('warn', `Hard wait of ${ms} ms — prefer waitFor on a condition`);
        await new Promise<void>((resolve, reject) => {
          const t = setTimeout(resolve, ms);
          ctx.signal.addEventListener(
            'abort',
            () => (clearTimeout(t), reject(new StepError('aborted', 'Run was cancelled'))),
            { once: true },
          );
        });
        return { message: `Waited ${ms} ms` };
      }
      case 'log': {
        const message = String(p.message ?? '');
        ctx.log('info', message);
        return { message };
      }
      case 'generateData': {
        const value = generate(String(p.kind ?? 'name'), p);
        if (typeof p.name === 'string' && p.name) ctx.resolver.setVar(p.name, value);
        return {
          output: value,
          message: `Generated ${String(p.kind ?? 'name')}: ${String(value)}`,
          getTarget: () => value,
        };
      }
      case 'runScript': {
        if (typeof p.code !== 'string') throw new StepError('invalid_params', 'runScript needs "code"');
        const snapshot = ctx.resolver.snapshotVars();
        const { result, vars, logs } = runSandboxed(
          p.code,
          { vars: snapshot, data: {}, env: {} },
          ctx.timeoutMs,
        );
        for (const [k, v] of Object.entries(vars))
          if (JSON.stringify(snapshot[k]) !== JSON.stringify(v)) ctx.resolver.setVar(k, v);
        logs.forEach((l) => ctx.log('info', l));
        return {
          output: result,
          message: logs.length ? logs.join('\n') : 'Script finished',
          getTarget: (t) => (t === 'result' ? result : vars[t]),
        };
      }
      case 'if':
      case 'loop':
      case 'callScenario':
      case 'useBlock':
        // Control flow is interpreted by the engine and never reaches an executor.
        throw new StepError('unsupported', `util.${name} must be run by the StepForge engine`);
      default:
        throw new StepError('unsupported', `Unknown utility step "${step.type}"`);
    }
  }

  async close() {
    return [];
  }
}

export const utilExecutor: Executor = {
  group: 'util',
  async createSession() {
    return new UtilSession();
  },
};
