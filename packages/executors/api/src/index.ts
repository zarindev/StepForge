import {
  evaluateAssertion,
  StepError,
  type Assertion,
  type AssertionResult,
  type Executor,
  type ExecutorSession,
  type RunnableStep,
  type StepContext,
  type StepOutcome,
} from '@stepforge/core';
import { JSONPath } from 'jsonpath-plus';
import { CookieJar, send, type HttpResponse, type RequestSpec, type SentRequest } from './http.ts';
import { validateSchema } from './schema.ts';

export { send, CookieJar, resolveUrl, type RequestSpec, type HttpResponse, type Auth } from './http.ts';
export { validateSchema, normalizeOpenApiSchema } from './schema.ts';

/** Validates a response against an API contract (OpenAPI operation). Provided by the host. */
export type ContractCheck = { ok: boolean; operation?: string; errors: string[] };
export type ContractResolver = (
  ref: { specId?: string },
  req: { method: string; url: string },
  res: { status: number; headers: Record<string, string>; body: unknown },
) => Promise<ContractCheck | null>;

/** Reads a value from a response for an assertion target. */
export function responseTarget(res: HttpResponse, target: string): unknown {
  if (target === 'status') return res.status;
  if (target === 'time' || target === 'timeMs') return res.timeMs;
  if (target === 'size') return res.size;
  if (target === 'body') return res.body;
  if (target === 'text') return res.text;
  if (target.startsWith('header:') || target.startsWith('headers.'))
    return res.headers[target.replace(/^headers?[.:]/, '').toLowerCase()];
  if (target.startsWith('$')) {
    if (res.body === null || typeof res.body !== 'object') return undefined;
    const found = JSONPath({ path: target, json: res.body as object, wrap: true }) as unknown[];
    if (found.length === 0) return undefined;
    // A definite path (no wildcards/filters) yields one value; otherwise return the list.
    return found.length === 1 && !/[*?]|\.\.|\[[^\]]*[:,]/.test(target) ? found[0] : found;
  }
  return undefined;
}

class ApiSession implements ExecutorSession {
  private jar = new CookieJar();
  private last: { request: SentRequest; response: HttpResponse } | null = null;

  constructor(private readonly contracts?: ContractResolver) {}

  async execute(step: RunnableStep, ctx: StepContext): Promise<StepOutcome> {
    const p = step.params as Record<string, unknown>;
    const name = step.type.split('.')[1];
    if (name === 'extract') return this.extract(p);
    if (name !== 'request' && name !== 'graphql')
      throw new StepError('unsupported', `Unknown API step "${step.type}"`);
    if (!p.url) throw new StepError('invalid_params', `${step.type} needs a "url"`);

    const spec: RequestSpec =
      name === 'graphql'
        ? {
            method: 'POST',
            url: String(p.url),
            headers: (p.headers as Record<string, string>) ?? {},
            auth: p.auth as RequestSpec['auth'],
            body: {
              query: String(p.query ?? ''),
              ...(p.variables !== undefined && { variables: p.variables }),
              ...(p.operationName ? { operationName: p.operationName } : {}),
            },
            bodyType: 'json',
          }
        : {
            method: String(p.method ?? 'GET'),
            url: String(p.url),
            headers: (p.headers as Record<string, string>) ?? {},
            query: p.query as RequestSpec['query'],
            body: p.body,
            bodyType: p.bodyType as RequestSpec['bodyType'],
            auth: p.auth as RequestSpec['auth'],
            followRedirects: p.followRedirects as boolean | undefined,
            cookies: p.cookies as boolean | undefined,
          };
    const { request, response } = await send(spec, {
      baseUrl: ctx.options.baseUrl,
      timeoutMs: ctx.timeoutMs,
      signal: ctx.signal,
      jar: this.jar,
    });
    this.last = { request, response };

    const extra: AssertionResult[] = [];
    if (name === 'graphql' && p.allowErrors !== true) {
      const errors = (response.body as { errors?: { message?: string }[] } | null)?.errors;
      if (errors?.length) {
        extra.push({
          target: 'errors',
          operator: 'isEmpty',
          actual: errors,
          passed: false,
          message: `GraphQL errors: ${errors.map((e) => e.message).join('; ')}`,
        });
      }
    }
    if (p.contract && this.contracts) {
      const check = await this.contracts(
        p.contract as { specId?: string },
        { method: request.method, url: request.url },
        response,
      );
      if (check) {
        extra.push({
          target: 'contract',
          operator: 'matches',
          expected: check.operation,
          passed: check.ok,
          message: check.ok
            ? `Response matches the contract${check.operation ? ` of ${check.operation}` : ''}`
            : `Contract violation${check.operation ? ` (${check.operation})` : ''}: ${check.errors.join('; ')}`,
        });
      }
    }

    return {
      message: `${request.method} ${request.url} → ${response.status} in ${response.timeMs} ms`,
      output: response.body,
      request,
      response: {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
        body: response.body,
        timeMs: response.timeMs,
        size: response.size,
      },
      assertions: extra,
      getTarget: (t) => responseTarget(response, t),
      evaluate: (a) => this.evaluate(a, response),
      metrics: [{ metric: 'api.response_time', value: response.timeMs, unit: 'ms' }],
    };
  }

  private evaluate(a: Assertion, res: HttpResponse): AssertionResult | undefined {
    if (a.operator !== 'matchesSchema') return undefined;
    const value = a.target === 'body' || a.target === '$' ? res.body : responseTarget(res, a.target);
    const r = validateSchema(a.expected, value);
    return {
      target: a.target,
      operator: a.operator,
      passed: r.ok,
      actual: r.ok ? undefined : r.errors,
      message: r.ok
        ? `${a.target} matches the JSON schema`
        : (a.message ?? `Schema mismatch: ${r.errors.join('; ')}`),
    };
  }

  private extract(p: Record<string, unknown>): StepOutcome {
    if (!this.last)
      throw new StepError('invalid_params', 'api.extract needs an earlier API request in this test');
    const res = this.last.response;
    const from = String(p.from ?? 'body');
    const value =
      from === 'status'
        ? res.status
        : from === 'header'
          ? res.headers[String(p.name ?? '').toLowerCase()]
          : responseTarget(res, String(p.path ?? '$'));
    if (value === undefined && p.required !== false)
      throw new StepError(
        'assertion',
        `Nothing found at ${String(p.path ?? p.name ?? from)} in the last response`,
      );
    return {
      output: value,
      message: `Extracted ${JSON.stringify(value)?.slice(0, 120)}`,
      getTarget: (t) => (t === 'value' ? value : responseTarget(res, t)),
    };
  }

  async close() {
    return [];
  }
}

export function createApiExecutor(opts: { contracts?: ContractResolver } = {}): Executor {
  return {
    group: 'api',
    async createSession() {
      return new ApiSession(opts.contracts);
    },
  };
}

/** Convenience used by the API Client: evaluate assertions against a response outside the engine. */
export function checkAssertions(res: HttpResponse, assertions: Assertion[]): AssertionResult[] {
  return assertions.map((a) => {
    if (a.operator === 'matchesSchema') {
      const r = validateSchema(
        a.expected,
        a.target === 'body' || a.target === '$' ? res.body : responseTarget(res, a.target),
      );
      return {
        target: a.target,
        operator: a.operator,
        passed: r.ok,
        message: r.ok ? 'matches schema' : r.errors.join('; '),
      };
    }
    return evaluateAssertion(a, responseTarget(res, a.target));
  });
}
