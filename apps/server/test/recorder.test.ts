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
let moduleId = '';

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
  appId = (await ok('POST', '/api/applications', { name: 'Clinic', slug: 'clinic' })).id;
  envId = (await ok('POST', `/api/applications/${appId}/environments`, { name: 'Local', baseUrl: base })).id;
  moduleId = (await ok('POST', `/api/applications/${appId}/modules`, { name: 'Recorded' })).id;
}, 30_000);
afterAll(async () => {
  await app.close();
  await clinic.close();
});

describe('recorder API', () => {
  it('records, saves (with secret + API scenario) and replays through the runner', async () => {
    const started = await ok<{ state: string; steps: unknown[] }>('POST', '/api/recorder/start', {
      applicationId: appId,
      environmentId: envId,
      startPath: '/login',
      headless: true,
    });
    expect(started.state).toBe('recording');
    const conflict = await app.inject({
      method: 'POST',
      url: '/api/recorder/start',
      headers: H,
      payload: { applicationId: appId, environmentId: envId, headless: true },
    });
    expect(conflict.statusCode).toBe(409);

    const page = ctx.recorder.session()!.page;
    await page.getByLabel('Email').fill('admin@careclinic.test');
    await page.getByLabel('Password').fill('Admin123!');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.locator('#next-appointments li').first().waitFor();
    await page.getByRole('link', { name: 'Patients' }).click();
    await page.getByTestId('patient-search').fill('Chloe');
    await page.getByTestId('patient-search').press('Enter');
    await page.waitForURL(/q=Chloe/);
    await page.getByRole('link', { name: 'Chloe Nguyen' }).click();
    await page.waitForURL(/patients\/3/);
    await new Promise((r) => setTimeout(r, 300));

    const stopped = await ok<{
      state: string;
      steps: { type: string }[];
      network: { id: number; url: string }[];
      secretKeys: string[];
    }>('POST', '/api/recorder/stop');
    expect(stopped.state).toBe('stopped');
    expect(stopped.secretKeys).toEqual(['password']);
    expect(JSON.stringify(stopped)).not.toContain('Admin123!');
    expect(stopped.steps.map((s) => s.type)).toEqual([
      'ui.navigate',
      'ui.fill',
      'ui.fill',
      'ui.click',
      'ui.click',
      'ui.fill',
      'ui.press',
      'ui.click',
    ]);
    const apiReq = stopped.network.find((n) => n.url.endsWith('/api/appointments'))!;

    const saved = await ok<{
      scenario: { id: string; kind: string; steps: unknown[] };
      apiScenario: { id: string; kind: string; steps: { type: string }[] };
    }>('POST', '/api/recorder/save', {
      moduleId,
      name: 'Admin finds a patient',
      apiScenario: { name: 'Captured API calls', requestIds: [apiReq.id] },
    });
    expect(saved.scenario).toMatchObject({ kind: 'ui' });
    expect(saved.scenario.steps).toHaveLength(8);
    expect(saved.apiScenario.kind).toBe('api');
    expect(saved.apiScenario.steps[0]!.type).toBe('api.request');
    expect(await ok('GET', `/api/environments/${envId}/secrets`)).toEqual([
      expect.objectContaining({ key: 'password' }),
    ]);
    expect(await ok('GET', '/api/recorder')).toBeNull();

    const run = await ok<{ id: string }>('POST', '/api/runs', {
      applicationId: appId,
      environmentId: envId,
      scope: { type: 'scenarios', ids: [saved.scenario.id] },
      options: { video: 'off', trace: 'off' },
    });
    await ctx.runs.idle();
    const done = await ok<{ status: string; items: { errorMessage: string | null }[] }>(
      'GET',
      `/api/runs/${run.id}`,
    );
    expect(done.items[0]!.errorMessage).toBeNull();
    expect(done.status).toBe('passed');
  }, 90_000);

  it('blocks: create, use from a scenario with util.useBlock, and validate nested steps', async () => {
    await ok('PUT', `/api/environments/${envId}/secrets`, { key: 'password', value: 'Admin123!' });
    const block = await ok<{ id: string }>('POST', `/api/applications/${appId}/blocks`, {
      name: 'Login as Admin',
      steps: [
        { type: 'ui.navigate', params: { url: '/login' } },
        {
          type: 'ui.fill',
          params: { value: 'admin@careclinic.test' },
          locators: [{ strategy: 'label', value: 'Email' }],
        },
        {
          type: 'ui.fill',
          params: { value: '{{secret.password}}' },
          locators: [{ strategy: 'testId', value: 'password' }],
        },
        { type: 'ui.click', locators: [{ strategy: 'testId', value: 'login-submit' }] },
      ],
    });
    expect(
      (await ok<{ stepCount: number }[]>('GET', `/api/applications/${appId}/blocks`))[0]!.stepCount,
    ).toBe(4);
    const s = await ok<{ id: string }>('POST', `/api/modules/${moduleId}/scenarios`, {
      name: 'Uses the login block twice in a loop',
      steps: [
        {
          type: 'util.loop',
          params: { count: 2, steps: [{ type: 'util.useBlock', params: { blockId: block.id } }] },
        },
        {
          type: 'ui.assert',
          params: { check: 'textContains', expected: 'Alex Admin' },
          locators: [{ strategy: 'css', value: '#current-user' }],
        },
      ],
    });
    const bad = await app.inject({
      method: 'PUT',
      url: `/api/scenarios/${s.id}/steps`,
      headers: H,
      payload: { steps: [{ type: 'util.if', params: { condition: {}, steps: [{ type: 'ui.teleport' }] } }] },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().message).toMatch(/Step 1\.1/);

    const run = await ok<{ id: string }>('POST', '/api/runs', {
      applicationId: appId,
      environmentId: envId,
      scope: { type: 'scenarios', ids: [s.id] },
      options: { video: 'off', trace: 'off', screenshots: 'off' },
    });
    await ctx.runs.idle();
    const done = await ok<{ status: string; items: { id: string; errorMessage: string | null }[] }>(
      'GET',
      `/api/runs/${run.id}`,
    );
    expect(done.items[0]!.errorMessage).toBeNull();
    const item = await ok<{ steps: { type: string; responseJson: { path: string; depth: number } }[] }>(
      'GET',
      `/api/run-items/${done.items[0]!.id}`,
    );
    expect(item.steps.map((x) => x.responseJson.path)).toContain('1[2].1.4');
    expect(item.steps.find((x) => x.type === 'util.loop')?.responseJson.depth).toBe(0);
  }, 90_000);
});
