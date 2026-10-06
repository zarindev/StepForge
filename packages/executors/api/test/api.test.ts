import { DEFAULT_RUN_OPTIONS, newId, runTestCase, type StepInput } from '@stepforge/core';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApiExecutor, type ContractResolver } from '../src/index.ts';

let server: Server;
let base = '';
const body = (req: IncomingMessage) =>
  new Promise<string>((r) => {
    let s = '';
    req.on('data', (c) => (s += c));
    req.on('end', () => r(s));
  });

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const json = (status: number, data: unknown, headers: Record<string, string> = {}) =>
      res.writeHead(status, { 'content-type': 'application/json', ...headers }).end(JSON.stringify(data));
    const url = new URL(req.url!, 'http://x');
    if (url.pathname === '/patients')
      return json(
        200,
        {
          items: [
            { id: 1, name: 'Ana', fee: 60 },
            { id: 2, name: 'Ben', fee: '120' },
          ],
          total: 2,
        },
        { 'x-request-id': 'abc' },
      );
    if (url.pathname === '/echo')
      return json(201, {
        method: req.method,
        body: JSON.parse((await body(req)) || 'null'),
        auth: req.headers.authorization ?? null,
        q: url.searchParams.get('q'),
      });
    if (url.pathname === '/form')
      return json(200, { raw: await body(req), type: req.headers['content-type'] });
    if (url.pathname === '/login')
      return json(200, { ok: true }, { 'set-cookie': 'sid=s3ss10n; Path=/; HttpOnly' });
    if (url.pathname === '/me')
      return req.headers.cookie?.includes('sid=s3ss10n')
        ? json(200, { user: 'ana' })
        : json(401, { error: 'login required' });
    if (url.pathname === '/basic')
      return req.headers.authorization === `Basic ${Buffer.from('ana:pw').toString('base64')}`
        ? json(200, { ok: 1 })
        : json(401, {});
    if (url.pathname === '/token') return json(200, { access_token: 'oauth-xyz', expires_in: 3600 });
    if (url.pathname === '/secure')
      return req.headers.authorization === 'Bearer oauth-xyz' ? json(200, { ok: 1 }) : json(403, {});
    if (url.pathname === '/slow') return setTimeout(() => json(200, {}), 1500);
    if (url.pathname === '/graphql') {
      const q = JSON.parse(await body(req)) as { query: string };
      return q.query.includes('bad')
        ? json(200, { errors: [{ message: 'Cannot query field "bad"' }] })
        : json(200, { data: { doctors: [{ name: 'Dr. Lin' }] } });
    }
    json(404, { error: 'not found' });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => server.close());

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
const run = (
  s: ReturnType<typeof steps>,
  contracts?: ContractResolver,
  extra: { secrets?: Record<string, string>; data?: Record<string, unknown> } = {},
) =>
  runTestCase({
    runId: 'R',
    steps: s,
    executors: [createApiExecutor({ contracts })],
    options: { ...DEFAULT_RUN_OPTIONS, baseUrl: base, defaultTimeoutMs: 3000 },
    artifactsDir: '/tmp',
    ...extra,
  });
const fails = (r: Awaited<ReturnType<typeof run>>) =>
  r.steps.filter((s) => s.status !== 'passed').map((s) => s.message);

describe('API executor', () => {
  it('asserts status, time, headers, JSONPath values and lengths', async () => {
    const r = await run(
      steps({
        type: 'api.request',
        params: { method: 'GET', url: '/patients' },
        assertions: [
          { target: 'status', operator: 'equals', expected: 200 },
          { target: 'time', operator: 'lt', expected: 2000 },
          { target: 'header:x-request-id', operator: 'equals', expected: 'abc' },
          { target: '$.items[0].name', operator: 'equals', expected: 'Ana' },
          { target: '$.items', operator: 'lengthEquals', expected: 2 },
          { target: '$.items[*].name', operator: 'contains', expected: 'Ben' },
          { target: '$.total', operator: 'gte', expected: 2 },
        ],
        captureAs: 'list',
      }),
    );
    expect(fails(r)).toEqual([]);
    expect((r.vars.list as { total: number }).total).toBe(2);
  });

  it('reports field-level JSON Schema mismatches', async () => {
    const schema = {
      type: 'object',
      required: ['items'],
      properties: {
        items: {
          type: 'array',
          items: { type: 'object', required: ['id', 'name', 'fee'], properties: { fee: { type: 'number' } } },
        },
      },
    };
    const r = await run(
      steps({
        type: 'api.request',
        params: { url: '/patients' },
        assertions: [{ target: 'body', operator: 'matchesSchema', expected: schema }],
      }),
    );
    expect(r.status).toBe('failed');
    expect(r.error).toBe('Schema mismatch: items.1.fee should be number');
  });

  it('sends JSON, form and query, resolves variables, and masks secrets in stored requests', async () => {
    const r = await run(
      steps(
        {
          type: 'api.request',
          params: {
            method: 'POST',
            url: '/echo',
            query: { q: 'x' },
            body: { name: '{{data.n}}' },
            auth: { type: 'bearer', token: '{{secret.token}}' },
          },
          assertions: [
            { target: '$.body.name', operator: 'equals', expected: 'Ana' },
            { target: '$.q', operator: 'equals', expected: 'x' },
            { target: 'status', operator: 'equals', expected: 201 },
          ],
        },
        {
          type: 'api.request',
          params: { method: 'POST', url: '/form', body: { a: 1, b: 'two' }, bodyType: 'form' },
          assertions: [{ target: '$.raw', operator: 'equals', expected: 'a=1&b=two' }],
        },
      ),
      undefined,
      { secrets: { token: 'tok-SECRET-123' }, data: { n: 'Ana' } },
    );
    expect(fails(r)).toEqual([]);
    expect(JSON.stringify(r.steps)).not.toContain('tok-SECRET-123');
    expect((r.steps[0]!.request as { headers: Record<string, string> }).headers.authorization).toBe(
      'Bearer ••••',
    );
  });

  it('keeps cookies between requests, supports basic auth and OAuth2 client credentials', async () => {
    const r = await run(
      steps(
        {
          type: 'api.request',
          params: { url: '/me' },
          assertions: [{ target: 'status', operator: 'equals', expected: 401 }],
        },
        { type: 'api.request', params: { method: 'POST', url: '/login' } },
        {
          type: 'api.request',
          params: { url: '/me' },
          assertions: [{ target: '$.user', operator: 'equals', expected: 'ana' }],
        },
        {
          type: 'api.request',
          params: { url: '/basic', auth: { type: 'basic', username: 'ana', password: 'pw' } },
          assertions: [{ target: 'status', operator: 'equals', expected: 200 }],
        },
        {
          type: 'api.request',
          params: {
            url: '/secure',
            auth: { type: 'oauth2', tokenUrl: `${base}/token`, clientId: 'c', clientSecret: 's' },
          },
          assertions: [{ target: 'status', operator: 'equals', expected: 200 }],
        },
      ),
    );
    expect(fails(r)).toEqual([]);
  });

  it('GraphQL: data passes, errors fail by default; api.extract reads the last response', async () => {
    const ok = await run(
      steps(
        { type: 'api.graphql', params: { url: '/graphql', query: '{ doctors { name } }' } },
        { type: 'api.extract', params: { path: '$.data.doctors[0].name' }, captureAs: 'doc' },
      ),
    );
    expect(ok.vars.doc).toBe('Dr. Lin');
    const bad = await run(steps({ type: 'api.graphql', params: { url: '/graphql', query: '{ bad }' } }));
    expect(bad.error).toBe('GraphQL errors: Cannot query field "bad"');
  });

  it('runs contract checks through the host resolver', async () => {
    const resolver: ContractResolver = async (_ref, req, res) => ({
      ok: res.status === 200,
      operation: `GET ${new URL(req.url).pathname}`,
      errors: res.status === 200 ? [] : [`status ${res.status} is not documented`],
    });
    const good = await run(
      steps({ type: 'api.request', params: { url: '/patients', contract: {} } }),
      resolver,
    );
    expect(good.steps[0]!.assertions[0]).toMatchObject({ target: 'contract', passed: true });
    const bad = await run(steps({ type: 'api.request', params: { url: '/nope', contract: {} } }), resolver);
    expect(bad.error).toBe('Contract violation (GET /nope): status 404 is not documented');
  });

  it('classifies timeouts and connection errors', async () => {
    const slow = await run(steps({ type: 'api.request', params: { url: '/slow' }, timeoutMs: 300 }));
    expect(slow.errorKind).toBe('timeout');
    const closed = createServer();
    await new Promise<void>((r) => closed.listen(0, '127.0.0.1', r));
    const freePort = (closed.address() as { port: number }).port;
    await new Promise((r) => closed.close(r));
    const down = await run(steps({ type: 'api.request', params: { url: `http://127.0.0.1:${freePort}/x` } }));
    expect(down.errorKind).toBe('network');
    expect(down.error).toMatch(/ECONNREFUSED/);
  });
});

describe('failure evidence', () => {
  it('keeps the request and response when an assertion fails', async () => {
    const r = await run(
      steps({
        type: 'api.request',
        params: { url: '/patients' },
        assertions: [{ target: 'status', operator: 'equals', expected: 201 }],
      }),
    );
    expect(r.status).toBe('failed');
    expect(r.steps[0]!.request).toMatchObject({ method: 'GET' });
    expect(r.steps[0]!.response).toMatchObject({ status: 200, body: { total: 2 } });
  });
});
