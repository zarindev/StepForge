import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { buildApp } from '../src/app.ts';
import { H, testServer } from './helpers.ts';

let app: Awaited<ReturnType<typeof buildApp>>['app'];
beforeAll(async () => {
  ({ app } = await testServer());
});
afterAll(async () => app.close());

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
async function call(method: Method, url: string, payload?: unknown): Promise<LightMyRequestResponse> {
  return app.inject({
    method,
    url,
    headers: H,
    ...(payload !== undefined && { payload: payload as object }),
  });
}
async function ok<T = Record<string, unknown> & { id: string }>(
  method: Method,
  url: string,
  payload?: unknown,
): Promise<T> {
  const res = await call(method, url, payload);
  if (res.statusCode >= 300) throw new Error(`${method} ${url} → ${res.statusCode}: ${res.body}`);
  return (res.body ? res.json() : undefined) as T;
}

describe('organising a full test tree over the API', () => {
  it('builds CareClinic: environments, secrets, nested modules, scenarios, steps, test cases, tags', async () => {
    const clinic = await ok('POST', '/api/applications', {
      name: 'CareClinic',
      slug: 'careclinic',
      color: '#22C55E',
    });
    const local = await ok('POST', `/api/applications/${clinic.id}/environments`, {
      name: 'Local',
      baseUrl: 'http://localhost:8101',
      variables: { apiBase: 'http://localhost:8101/api' },
    });
    await ok('POST', `/api/applications/${clinic.id}/environments`, {
      name: 'Production',
      baseUrl: 'https://clinic.example.com',
      isProduction: true,
    });

    // secrets: write-only
    await ok('PUT', `/api/environments/${local.id}/secrets`, { key: 'adminPassword', value: 'Adm1n!pass' });
    const secretsRes = await call('GET', `/api/environments/${local.id}/secrets`);
    expect(secretsRes.json()).toEqual([expect.objectContaining({ key: 'adminPassword' })]);
    expect(secretsRes.body).not.toContain('Adm1n');

    const patients = await ok('POST', `/api/applications/${clinic.id}/modules`, { name: 'Patients' });
    const registration = await ok('POST', `/api/applications/${clinic.id}/modules`, {
      name: 'Registration',
      parentId: patients.id,
    });
    const appointments = await ok('POST', `/api/applications/${clinic.id}/modules`, { name: 'Appointments' });
    const smoke = await ok('POST', `/api/applications/${clinic.id}/tags`, {
      name: 'smoke',
      color: '#F97316',
    });

    const register = await ok<{ id: string; version: number; kind: string }>(
      'POST',
      `/api/modules/${registration.id}/scenarios`,
      { name: 'Register a new patient', priority: 'P1' },
    );
    const withSteps = await ok<{ version: number; kind: string; steps: { id: string }[] }>(
      'PUT',
      `/api/scenarios/${register.id}/steps`,
      {
        steps: [
          { type: 'ui.navigate', params: { url: '{{env.baseUrl}}/patients/new' } },
          {
            type: 'ui.fill',
            params: { value: '{{data.name}}' },
            locators: [{ strategy: 'label', value: 'Full name' }],
          },
          { type: 'db.query', params: { sql: 'SELECT * FROM patients WHERE name = ?' } },
        ],
      },
    );
    expect(withSteps).toMatchObject({ version: 2, kind: 'hybrid' });

    const tc = await ok<{ code: string }>('POST', `/api/scenarios/${register.id}/test-cases`, {
      title: 'Valid patient',
      data: { name: 'Ana Lopez' },
      technique: 'positive',
    });
    expect(tc.code).toBe('TC-REG-001');
    await ok('PUT', `/api/scenarios/${register.id}/tags`, { tagIds: [smoke.id] });
    await ok('POST', `/api/modules/${appointments.id}/scenarios`, { name: 'Book appointment' });

    const tree = await ok<{
      modules: unknown[];
      scenarios: { tagIds: string[]; stepCount: number }[];
      testCases: unknown[];
    }>('GET', `/api/applications/${clinic.id}/tree`);
    expect(tree.modules).toHaveLength(3);
    expect(tree.scenarios).toHaveLength(2);
    expect(tree.testCases).toHaveLength(1);
    expect(tree.scenarios.find((s) => s.stepCount === 3)?.tagIds).toEqual([smoke.id]);

    const summary = await ok<{ counts: Record<string, number>; hasProduction: boolean }>(
      'GET',
      `/api/applications/${clinic.id}`,
    );
    expect(summary.counts).toMatchObject({ environments: 2, modules: 3, scenarios: 2, testCases: 1 });
    expect(summary.hasProduction).toBe(true);

    // version history + restore
    const versions = await ok<{ version: number }[]>('GET', `/api/scenarios/${register.id}/versions`);
    expect(versions.map((v) => v.version)).toEqual([2, 1]);
    const restored = await ok<{ version: number; steps: unknown[] }>(
      'POST',
      `/api/scenarios/${register.id}/versions/1/restore`,
    );
    expect(restored).toMatchObject({ version: 3, steps: [] });

    // search for the command palette
    const hits = await ok<{ kind: string }[]>('GET', '/api/search?q=patient');
    expect(hits.some((h) => h.kind === 'scenario')).toBe(true);
  });

  it('bulk actions stay inside one application', async () => {
    const shop = await ok('POST', '/api/applications', { name: 'ShopDesk', slug: 'shopdesk' });
    const other = await ok('POST', '/api/applications', { name: 'Other', slug: 'other' });
    const sales = await ok('POST', `/api/applications/${shop.id}/modules`, { name: 'Sales' });
    const stock = await ok('POST', `/api/applications/${shop.id}/modules`, { name: 'Stock' });
    const tag = await ok('POST', `/api/applications/${shop.id}/tags`, { name: 'regression' });
    const a = await ok('POST', `/api/modules/${sales.id}/scenarios`, { name: 'Sell item' });
    const b = await ok('POST', `/api/modules/${sales.id}/scenarios`, { name: 'Refund' });
    const bulk = (payload: unknown, appId = shop.id) =>
      call('POST', `/api/applications/${appId}/scenarios/bulk`, payload);

    expect((await bulk({ action: 'addTag', ids: [a.id, b.id], tagId: tag.id })).json()).toEqual({
      action: 'addTag',
      affected: 2,
    });
    expect((await bulk({ action: 'move', ids: [a.id], moduleId: stock.id })).statusCode).toBe(200);
    expect((await bulk({ action: 'duplicate', ids: [b.id] })).statusCode).toBe(200);
    expect((await bulk({ action: 'delete', ids: [a.id] }, other.id)).statusCode).toBe(400);
    expect((await bulk({ action: 'explode', ids: [a.id] })).statusCode).toBe(400);

    const tree = await ok<{ scenarios: { name: string; moduleId: string }[] }>(
      'GET',
      `/api/applications/${shop.id}/tree`,
    );
    expect(tree.scenarios.map((s) => s.name).sort()).toEqual(['Refund', 'Refund (copy)', 'Sell item']);
    expect(tree.scenarios.find((s) => s.name === 'Sell item')?.moduleId).toBe(stock.id);
  });

  it('requires typed confirmation for destructive deletes', async () => {
    const a = await ok('POST', '/api/applications', { name: 'Throwaway', slug: 'throwaway' });
    const prod = await ok('POST', `/api/applications/${a.id}/environments`, {
      name: 'Prod',
      baseUrl: 'https://x.example.com',
      isProduction: true,
    });
    expect((await call('DELETE', `/api/environments/${prod.id}`)).statusCode).toBe(400);
    expect((await call('DELETE', `/api/environments/${prod.id}`, { confirm: 'Throwaway' })).statusCode).toBe(
      204,
    );
    const res = await call('DELETE', `/api/applications/${a.id}`, { confirm: 'wrong' });
    expect(res.json().error).toBe('confirmation_required');
    expect((await call('DELETE', `/api/applications/${a.id}`, { confirm: 'Throwaway' })).statusCode).toBe(
      204,
    );
    expect((await call('GET', `/api/applications/${a.id}`)).statusCode).toBe(404);
  });

  it('maps validation and repository errors to 4xx', async () => {
    expect((await call('POST', '/api/applications', { name: '', slug: 'Bad Slug' })).statusCode).toBe(400);
    await ok('POST', '/api/applications', { name: 'Dup', slug: 'dup' });
    const dup = await call('POST', '/api/applications', { name: 'Dup2', slug: 'dup' });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error).toBe('conflict');
    expect((await call('GET', '/api/scenarios/01ARZ3NDEKTSV4RRFFQ69G5FAV')).statusCode).toBe(404);
  });
});
