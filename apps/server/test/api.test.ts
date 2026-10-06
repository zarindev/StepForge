import { createClinicApp } from '@stepforge/demo-clinic';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AppContext } from '../src/context.ts';
import { H, testServer } from './helpers.ts';

let app: FastifyInstance;
let ctx: AppContext;
const clinic = createClinicApp({ dbFile: ':memory:' });
let appId = '';
let envId = '';

async function ok<T = Record<string, unknown> & { id: string }>(
  method: string,
  url: string,
  payload?: unknown,
): Promise<T> {
  const res = await app.inject({
    method: method as 'GET',
    url,
    headers: H,
    ...(payload !== undefined && { payload: payload as object }),
  });
  if (res.statusCode >= 300) throw new Error(`${method} ${url} → ${res.statusCode}: ${res.body}`);
  return (res.body ? res.json() : undefined) as T;
}

beforeAll(async () => {
  ({ app, ctx } = await testServer());
  await clinic.listen({ host: '127.0.0.1', port: 0 });
  const base = `http://127.0.0.1:${(clinic.server.address() as { port: number }).port}`;
  appId = (await ok('POST', '/api/applications', { name: 'CareClinic', slug: 'careclinic' })).id;
  envId = (await ok('POST', `/api/applications/${appId}/environments`, { name: 'Local', baseUrl: base })).id;
  await ok('PUT', `/api/environments/${envId}/secrets`, { key: 'apiPassword', value: 'Admin123!' });
}, 30_000);
afterAll(async () => {
  await app.close();
  await clinic.close();
});

describe('OpenAPI import → generated suite against CareClinic', () => {
  it('imports the spec from the environment URL, runs it, and fails exactly where the API breaks its contract', async () => {
    const spec = await ok<{ id: string; parsedJson: { title: string; operations: unknown[] } }>(
      'POST',
      `/api/applications/${appId}/api-specs`,
      { url: '/api/openapi.json', environmentId: envId },
    );
    expect(spec.parsedJson.title).toBe('CareClinic API');
    expect(spec.parsedJson.operations).toHaveLength(10);

    const imported = await ok<{
      rootModuleId: string;
      scenarios: number;
      blocks: number;
      secretsNeeded: string[];
    }>('POST', `/api/applications/${appId}/import`, {
      kind: 'openapi',
      specId: spec.id,
      options: { contract: true },
    });
    expect(imported.blocks).toBe(1);
    expect(imported.secretsNeeded).toEqual(['apiPassword']);
    expect(imported.scenarios).toBeGreaterThan(20);

    await clinic.inject({ method: 'POST', url: '/api/reset' });
    const run = await ok<{ id: string }>('POST', '/api/runs', {
      applicationId: appId,
      environmentId: envId,
      scope: { type: 'module', id: imported.rootModuleId },
      options: { workers: 4 },
    });
    await ctx.runs.idle();
    const done = await ok<{
      status: string;
      totalsJson: Record<string, number>;
      items: { status: string; errorMessage: string | null; labelJson: { scenario: string } }[];
    }>('GET', `/api/runs/${run.id}`);
    const failed = done.items
      .filter((i) => i.status !== 'passed')
      .map((i) => `${i.labelJson.scenario} :: ${i.errorMessage}`);
    expect(failed.sort()).toEqual([
      expect.stringMatching(
        /^DELETE \/api\/patients\/\{id\} — not found :: Expected status equals 404, but got 204/,
      ),
      expect.stringMatching(
        /^GET \/api\/appointments — unauthorized :: Expected status equals 401, but got 200/,
      ),
      expect.stringMatching(/^GET \/api\/doctors — happy path :: .*fee should be number/),
    ]);
    expect(done.status).toBe('failed');
    expect(done.totalsJson.passed).toBe(done.totalsJson.total! - 3);
  }, 120_000);

  it('API client: resolves variables and secrets, masks them, checks assertions and the contract', async () => {
    const login = await ok<{
      response: { status: number; body: { token: string } };
      request: { body: { password: string } };
      contract: { ok: boolean; operation: string };
    }>('POST', '/api/api-client/send', {
      environmentId: envId,
      request: {
        method: 'POST',
        url: '/api/auth/login',
        body: { email: 'admin@careclinic.test', password: '{{secret.apiPassword}}' },
      },
    });
    expect(login.response.status).toBe(200);
    expect(login.request.body.password).toBe('••••');
    expect(login.contract).toEqual({ ok: true, operation: 'POST /api/auth/login', errors: [] });

    const doctors = await ok<{
      response: { status: number };
      contract: { ok: boolean; errors: string[] };
      assertions: { passed: boolean }[];
    }>('POST', '/api/api-client/send', {
      environmentId: envId,
      request: {
        method: 'GET',
        url: '{{env.baseUrl}}/api/doctors',
        headers: { authorization: `Bearer ${login.response.body.token}` },
      },
      assertions: [
        { target: 'status', operator: 'equals', expected: 200 },
        { target: '$[0].name', operator: 'exists' },
      ],
    });
    expect(doctors.assertions.every((a) => a.passed)).toBe(true);
    expect(doctors.contract.ok).toBe(false);
    expect(doctors.contract.errors[0]).toBe('0.fee should be number');

    const undocumented = await ok<{ contract: { ok: boolean; errors: string[] } }>(
      'POST',
      '/api/api-client/send',
      { environmentId: envId, request: { url: '/api/openapi.json' } },
    );
    expect(undocumented.contract.errors[0]).toMatch(/is not described in the spec/);
    const bad = await ok<{ error: { kind: string } }>('POST', '/api/api-client/send', {
      environmentId: envId,
      request: { url: '{{secret.nope}}' },
    });
    expect(bad.error.kind).toBe('variable');
  });

  it('imports Postman, cURL and HAR into modules', async () => {
    const pm = await ok<{ scenarios: number }>('POST', `/api/applications/${appId}/import`, {
      kind: 'postman',
      content: {
        info: { name: 'Clinic PM' },
        item: [{ name: 'Health', request: { method: 'GET', url: '{{baseUrl}}/api/health' } }],
      },
    });
    expect(pm.scenarios).toBe(1);
    const curl = await ok<{ scenarios: number; rootModuleId: string }>(
      'POST',
      `/api/applications/${appId}/import`,
      { kind: 'curl', content: "curl 'http://x.test/api/health'", name: 'From cURL' },
    );
    expect(curl.scenarios).toBe(1);
    const har = await ok<{ scenarios: number }>('POST', `/api/applications/${appId}/import`, {
      kind: 'har',
      content: {
        log: {
          entries: [
            {
              _resourceType: 'fetch',
              request: { method: 'GET', url: 'http://x.test/api/a/1' },
              response: { status: 200 },
            },
          ],
        },
      },
    });
    expect(har.scenarios).toBe(1);
    const badSpec = await app.inject({
      method: 'POST',
      url: `/api/applications/${appId}/import`,
      headers: H,
      payload: { kind: 'postman', content: { nope: 1 } },
    });
    expect(badSpec.statusCode).toBe(400);
    expect(badSpec.json().error).toBe('import_failed');
  });
});
