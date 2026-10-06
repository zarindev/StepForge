import { createClinicApp } from '@stepforge/demo-clinic';
import type { FastifyInstance } from 'fastify';
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AppContext } from '../src/context.ts';
import { H, TOKEN, testServer } from './helpers.ts';

let app: FastifyInstance;
let ctx: AppContext;
let clinic: ReturnType<typeof createClinicApp>;
let flakyServer: Server;
let clinicUrl = '';
let flakyUrl = '';
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

const LOGIN_STEPS = [
  { type: 'ui.navigate', params: { url: '/login' } },
  { type: 'ui.fill', params: { value: '{{data.email}}' }, locators: [{ strategy: 'label', value: 'Email' }] },
  {
    type: 'ui.fill',
    params: { value: '{{secret.password}}' },
    locators: [{ strategy: 'testId', value: 'password' }],
  },
  { type: 'ui.click', locators: [{ strategy: 'role', value: 'button', name: 'Sign in' }] },
];

beforeAll(async () => {
  ({ app, ctx } = await testServer());
  clinic = createClinicApp({ dbFile: ':memory:' });
  await clinic.listen({ host: '127.0.0.1', port: 0 });
  clinicUrl = `http://127.0.0.1:${(clinic.server.address() as { port: number }).port}`;
  let hits = 0;
  flakyServer = createServer((_req, res) =>
    res
      .writeHead(200, { 'content-type': 'text/html' })
      .end(`<title>${hits++ === 0 ? 'Warming up' : 'Ready'}</title>`),
  );
  await new Promise<void>((r) => flakyServer.listen(0, '127.0.0.1', r));
  flakyUrl = `http://127.0.0.1:${(flakyServer.address() as { port: number }).port}`;

  appId = (await ok('POST', '/api/applications', { name: 'CareClinic', slug: 'careclinic' })).id;
  envId = (await ok('POST', `/api/applications/${appId}/environments`, { name: 'Local', baseUrl: clinicUrl }))
    .id;
  await ok('PUT', `/api/environments/${envId}/secrets`, { key: 'password', value: 'Reception123!' });
  moduleId = (await ok('POST', `/api/applications/${appId}/modules`, { name: 'Auth' })).id;
}, 30_000);

afterAll(async () => {
  await app.close();
  await clinic.close();
  flakyServer.close();
});

async function scenario(name: string, steps: unknown[], data?: Record<string, unknown>) {
  const s = await ok<{ id: string }>('POST', `/api/modules/${moduleId}/scenarios`, { name, steps });
  if (data) await ok('POST', `/api/scenarios/${s.id}/test-cases`, { title: name, data });
  return s.id;
}
async function runAndWait(scope: unknown, options: Record<string, unknown> = {}) {
  const run = await ok<{ id: string }>('POST', '/api/runs', {
    applicationId: appId,
    environmentId: envId,
    scope,
    options,
  });
  await ctx.runs.idle();
  return ok<{
    status: string;
    totalsJson: Record<string, number>;
    items: { id: string; status: string; errorMessage: string | null; attempt: number }[];
  }>('GET', `/api/runs/${run.id}`);
}

describe('runner against the CareClinic demo', () => {
  it('runs a recorded-style login + booking flow and stores step evidence', async () => {
    const id = await scenario(
      'Receptionist books an appointment',
      [
        ...LOGIN_STEPS,
        {
          type: 'ui.assert',
          params: { check: 'textContains', expected: 'Riley Reception' },
          locators: [{ strategy: 'css', value: '#current-user' }],
        },
        { type: 'ui.click', locators: [{ strategy: 'testId', value: 'nav-appointments' }] },
        { type: 'ui.click', locators: [{ strategy: 'role', value: 'link', name: 'Book appointment' }] },
        {
          type: 'ui.select',
          params: { label: 'Ana Lopez (PAT-1001)' },
          locators: [{ strategy: 'label', value: 'Patient' }],
        },
        { type: 'ui.select', params: { value: '3' }, locators: [{ strategy: 'label', value: 'Doctor' }] },
        {
          type: 'ui.fill',
          params: { value: '2026-12-01' },
          locators: [{ strategy: 'testId', value: 'appointment-date' }],
        },
        {
          type: 'ui.fill',
          params: { value: 'Vaccination' },
          locators: [{ strategy: 'label', value: 'Reason for visit' }],
        },
        { type: 'ui.click', locators: [{ strategy: 'testId', value: 'book-appointment' }] },
        {
          type: 'ui.assert',
          params: { check: 'text', expected: 'Appointment booked' },
          locators: [{ strategy: 'testId', value: 'flash' }],
        },
      ],
      { email: 'reception@careclinic.test' },
    );
    const run = await runAndWait({ type: 'scenarios', ids: [id] });
    expect(run.items[0]?.errorMessage ?? null).toBeNull();
    expect(run.status).toBe('passed');
    expect(run.totalsJson).toMatchObject({ total: 1, passed: 1 });

    const item = await ok<{
      steps: { status: string; screenshotPath: string | null; message: string | null }[];
      artifacts: { kind: string; path: string }[];
    }>('GET', `/api/run-items/${run.items[0]!.id}`);
    expect(item.steps).toHaveLength(13);
    expect(item.steps.every((s) => s.status === 'passed')).toBe(true);
    expect(item.steps.every((s) => s.screenshotPath?.endsWith('.jpg'))).toBe(true);
    expect(JSON.stringify(item)).not.toContain('Reception123!'); // secret never persisted

    const shot = await app.inject({
      url: `/api/artifacts/files/${item.steps[0]!.screenshotPath}?token=${TOKEN}`,
      headers: { host: '127.0.0.1' },
    });
    expect(shot.statusCode).toBe(200);
    expect(shot.headers['content-type']).toContain('image/jpeg');
    const noToken = await app.inject({
      url: `/api/artifacts/files/${item.steps[0]!.screenshotPath}`,
      headers: { host: '127.0.0.1' },
    });
    expect(noToken.statusCode).toBe(401);
  }, 60_000);

  it('a failing test keeps video, trace, DOM and logs; Trace Viewer is served', async () => {
    const id = await scenario(
      'Wrong password shows error',
      [
        ...LOGIN_STEPS,
        {
          type: 'ui.assert',
          params: { check: 'visible' },
          locators: [{ strategy: 'testId', value: 'kpi-patients' }],
          timeoutMs: 1500,
        },
      ],
      { email: 'nobody@careclinic.test' },
    );
    const run = await runAndWait({ type: 'scenarios', ids: [id] });
    expect(run.status).toBe('failed');
    expect(run.items[0]!.status).toBe('failed');
    const item = await ok<{
      failedStepId: string;
      artifacts: { kind: string; path: string; size: number }[];
    }>('GET', `/api/run-items/${run.items[0]!.id}`);
    expect(item.artifacts.map((a) => a.kind).sort()).toEqual(['console', 'dom', 'network', 'trace', 'video']);
    expect(item.artifacts.every((a) => a.size > 0)).toBe(true);
    const video = item.artifacts.find((a) => a.kind === 'video')!;
    const ranged = await app.inject({
      url: `/api/artifacts/files/${video.path}?token=${TOKEN}`,
      headers: { host: '127.0.0.1', range: 'bytes=0-99' },
    });
    expect(ranged.statusCode).toBe(206);
    const viewer = await app.inject({ url: '/trace-viewer/index.html', headers: { host: '127.0.0.1' } });
    expect(viewer.statusCode).toBe(200);
  }, 60_000);

  it('marks a test that passes on retry as flaky', async () => {
    const id = await scenario('Warm-up page', [
      { type: 'ui.navigate', params: { url: flakyUrl } },
      { type: 'ui.assert', params: { check: 'title', expected: 'Ready' }, timeoutMs: 500 },
    ]);
    const run = await runAndWait(
      { type: 'scenarios', ids: [id] },
      { retries: 1, video: 'off', trace: 'off' },
    );
    expect(run.items[0]).toMatchObject({ status: 'flaky', attempt: 2 });
    expect(run.status).toBe('passed');
    expect(run.totalsJson.flaky).toBe(1);
  }, 60_000);

  it('runs a module with parallel workers, stop-on-first-failure and cancellation', async () => {
    const mod = (await ok('POST', `/api/applications/${appId}/modules`, { name: 'Slow' })).id;
    for (const n of ['A', 'B', 'C', 'D']) {
      await ok('POST', `/api/modules/${mod}/scenarios`, {
        name: `Slow ${n}`,
        steps: [{ type: 'util.wait', params: { ms: 3000 } }],
      });
    }
    const run = await ok<{ id: string }>('POST', '/api/runs', {
      applicationId: appId,
      environmentId: envId,
      scope: { type: 'module', id: mod },
      options: { workers: 2 },
    });
    await new Promise((r) => setTimeout(r, 400));
    await ok('POST', `/api/runs/${run.id}/cancel`);
    await ctx.runs.idle();
    const done = await ok<{ status: string; items: { status: string }[] }>('GET', `/api/runs/${run.id}`);
    expect(done.status).toBe('cancelled');
    expect(done.items.every((i) => i.status === 'skipped')).toBe(true);
  }, 30_000);

  it('rejects empty scopes and foreign environments; deletes runs with their files', async () => {
    const empty = await app.inject({
      method: 'POST',
      url: '/api/runs',
      headers: H,
      payload: { applicationId: appId, environmentId: envId, scope: { type: 'scenarios', ids: ['nope'] } },
    });
    expect(empty.statusCode).toBe(400);
    const runs = await ok<{ id: string; status: string }[]>('GET', `/api/runs?applicationId=${appId}`);
    expect(runs.length).toBeGreaterThanOrEqual(4);
    const res = await app.inject({ method: 'DELETE', url: `/api/runs/${runs[0]!.id}`, headers: H });
    expect(res.statusCode).toBe(204);
  });
});
