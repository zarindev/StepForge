import { CLINIC_OPENAPI } from '@stepforge/demo-clinic/openapi';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';
import {
  countScenarios,
  importCurl,
  importHar,
  importOpenApi,
  importPostman,
  matchOperation,
  loadOpenApi,
  sample,
  tokenize,
} from '../src/index.ts';

const names = (plan: Awaited<ReturnType<typeof importOpenApi>>) =>
  (plan.root.children ?? []).flatMap((m) => m.scenarios.map((s) => `${m.name}: ${s.name}`));

describe('OpenAPI importer', () => {
  it('generates happy-path and negative suites per tag with an auth block', async () => {
    const plan = await importOpenApi(CLINIC_OPENAPI);
    const all = names(plan);
    expect(plan.root.name).toBe('CareClinic API (OpenAPI)');
    expect(plan.root.children!.map((m) => m.name).sort()).toEqual([
      'Appointments',
      'Auth',
      'Doctors',
      'Patients',
      'System',
    ]);
    expect(all).toContain('Patients: POST /api/patients — happy path');
    expect(all).toContain('Patients: POST /api/patients — missing full_name');
    expect(all).toContain('Patients: POST /api/patients — wrong type for full_name');
    expect(all).toContain('Appointments: POST /api/appointments — invalid time');
    expect(all).toContain('Doctors: GET /api/doctors — unauthorized');
    expect(all).toContain('Patients: GET /api/patients/{id} — not found');
    expect(all).not.toContain('Patients: DELETE /api/patients/{id} — happy path'); // destructive off by default
    expect(all).toContain('Patients: DELETE /api/patients/{id} — not found');
    expect(all.some((n) => n.startsWith('System: GET /api/health — unauthorized'))).toBe(false); // public endpoint
    expect(plan.warnings.join(' ')).toMatch(/DELETE operation/);
    // Login detected → block with secret password; secured tests use it
    expect(plan.blocks).toHaveLength(1);
    expect(plan.secretsNeeded).toEqual(['apiPassword']);
    expect(plan.blocks[0]!.steps[0]!.params).toMatchObject({
      body: { email: 'admin@careclinic.test', password: '{{secret.apiPassword}}' },
    });
    const doctors = plan.root.children!.find((m) => m.name === 'Doctors')!.scenarios[0]!;
    expect(doctors.steps[0]).toMatchObject({ type: 'util.useBlock', params: { blockId: '@block:auth' } });
    expect(doctors.steps[1]!.params).toMatchObject({
      method: 'GET',
      url: '{{env.baseUrl}}/api/doctors',
      headers: { authorization: 'Bearer {{vars.auth.token}}' },
    });
    expect(doctors.steps[1]!.assertions!.map((a) => a.operator)).toEqual(['equals', 'matchesSchema', 'lt']);
    const unauth = plan.root.children!.find((m) => m.name === 'Doctors')!.scenarios[1]!;
    expect(unauth.steps).toHaveLength(1);
    expect(unauth.steps[0]!.assertions![0]).toEqual({ target: 'status', operator: 'equals', expected: 401 });
    expect(countScenarios(plan.root)).toBe(plan.stats.happyPath! + plan.stats.negative!);
  });

  it('accepts YAML, Swagger 2 and matches concrete URLs to operations', async () => {
    const yaml = YAML.stringify({
      swagger: '2.0',
      info: { title: 'Pets', version: '1' },
      basePath: '/v1',
      paths: {
        '/pets/{petId}': {
          get: {
            parameters: [{ name: 'petId', in: 'path', required: true, type: 'integer' }],
            responses: {
              '200': {
                description: 'ok',
                schema: { type: 'object', properties: { id: { type: 'integer' } } },
              },
            },
          },
        },
      },
    });
    const plan = await importOpenApi(yaml, { negative: false });
    const step = plan.root.children![0]!.scenarios[0]!.steps[0]!;
    expect(step.params).toMatchObject({ url: '{{env.baseUrl}}/v1/pets/1' });
    const doc = await loadOpenApi(CLINIC_OPENAPI);
    expect(matchOperation(doc, 'GET', 'http://h/api/patients/42')?.path).toBe('/api/patients/{id}');
    expect(matchOperation(doc, 'POST', 'http://h/api/patients')?.op.operationId).toBe('createPatient');
    expect(matchOperation(doc, 'GET', 'http://h/nope')).toBeNull();
    expect(
      sample({
        type: 'object',
        properties: { d: { type: 'string', format: 'date' }, n: { type: 'integer', minimum: 5 } },
      }),
    ).toEqual({ d: '2026-01-15', n: 5 });
  });

  it('rejects invalid documents', async () => {
    await expect(importOpenApi({ openapi: '3.0.0' })).rejects.toThrow();
  });
});

describe('Postman importer', () => {
  it('maps folders, variables, auth, bodies and simple test scripts', () => {
    const plan = importPostman({
      info: { name: 'Shop', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
      variable: [{ key: 'baseUrl', value: 'http://localhost:8102' }],
      auth: { type: 'bearer', bearer: [{ key: 'token', value: '{{token}}' }] },
      item: [
        {
          name: 'Products',
          item: [
            {
              name: 'List',
              request: { method: 'GET', url: { raw: '{{baseUrl}}/api/products?limit=5' } },
              event: [{ listen: 'test', script: { exec: ['pm.response.to.have.status(200);'] } }],
            },
            {
              name: 'Create',
              request: {
                method: 'POST',
                url: '{{baseUrl}}/api/products',
                header: [{ key: 'Content-Type', value: 'application/json' }],
                body: { mode: 'raw', raw: '{"name":"Pen"}' },
              },
            },
          ],
        },
        {
          name: 'Login form',
          request: {
            method: 'POST',
            url: '{{baseUrl}}/login',
            auth: { type: 'noauth' },
            body: { mode: 'urlencoded', urlencoded: [{ key: 'u', value: 'a' }] },
          },
          event: [{ listen: 'test', script: { exec: ['pm.test("x", () => {})'] } }],
        },
      ],
    });
    expect(plan.root.name).toBe('Shop (Postman)');
    const products = plan.root.children![0]!;
    expect(products.scenarios[0]!.steps[0]).toMatchObject({
      params: {
        method: 'GET',
        url: '{{env.baseUrl}}/api/products?limit=5',
        auth: { type: 'bearer', token: '{{env.token}}' },
      },
      assertions: [{ target: 'status', operator: 'equals', expected: 200 }],
    });
    expect(products.scenarios[1]!.steps[0]!.params).toMatchObject({
      body: { name: 'Pen' },
      bodyType: 'json',
    });
    expect(plan.root.scenarios[0]!.steps[0]!.params).toMatchObject({ body: { u: 'a' }, bodyType: 'form' });
    expect(plan.root.scenarios[0]!.steps[0]!.params).not.toHaveProperty('auth');
    expect(plan.variables).toEqual({ baseUrl: 'http://localhost:8102', token: '' });
    expect(plan.warnings[0]).toMatch(/1 request/);
  });
});

describe('cURL importer', () => {
  it('parses devtools-style commands', () => {
    const s = importCurl(`curl 'https://api.example.test/v1/orders' \\
      -H 'Authorization: Bearer abc' -H "Content-Type: application/json" \\
      --data-raw '{"sku":"X1","qty":2}' --compressed`);
    expect(s.params).toEqual({
      method: 'POST',
      url: 'https://api.example.test/v1/orders',
      headers: { authorization: 'Bearer abc', 'content-type': 'application/json' },
      body: { sku: 'X1', qty: 2 },
      bodyType: 'json',
    });
    expect(importCurl('curl -X DELETE -u admin:p:w https://h.test/x/1').params).toMatchObject({
      method: 'DELETE',
      auth: { type: 'basic', username: 'admin', password: 'p:w' },
    });
    expect(importCurl('curl -G https://h.test/s -d q=pen -d page=2').params).toMatchObject({
      method: 'GET',
      url: 'https://h.test/s?q=pen&page=2',
    });
    expect(importCurl('curl https://h.test/f -F name=a -F doc=@/tmp/a.pdf').params).toMatchObject({
      bodyType: 'multipart',
      body: { name: 'a', doc: { file: '/tmp/a.pdf' } },
    });
    expect(importCurl('curl https://h.test/l -d "a=1&b=two"').params).toMatchObject({
      method: 'POST',
      bodyType: 'form',
      body: { a: '1', b: 'two' },
    });
    expect(tokenize(`curl "a \\"b\\"" 'c d'`)).toEqual(['curl', 'a "b"', 'c d']);
    expect(() => importCurl('wget x')).toThrow(/starting with "curl"/);
  });
});

describe('HAR importer', () => {
  it('keeps XHR/fetch, dedupes by path template and skips noise', () => {
    const e = (url: string, type: string, status = 200, method = 'GET') => ({
      _resourceType: type,
      request: { method, url, headers: [] },
      response: { status, content: { mimeType: 'application/json' } },
      time: 40,
    });
    const plan = importHar({
      log: {
        entries: [
          e('http://shop.test/', 'document'),
          e('http://shop.test/api/products/1', 'fetch'),
          e('http://shop.test/api/products/2', 'fetch'),
          e('http://shop.test/api/cart', 'xhr', 201, 'POST'),
          e('https://www.google-analytics.com/collect', 'xhr'),
        ],
      },
    });
    const all = plan.root.children!.flatMap((m) => m.scenarios.map((s) => s.name));
    expect(all.sort()).toEqual(['GET /api/products/{id}', 'POST /api/cart']);
    expect(plan.variables.baseUrl).toBe('http://shop.test');
    expect(plan.warnings[0]).toMatch(/2 non-API entries/);
  });
});
