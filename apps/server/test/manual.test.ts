import type { FastifyInstance } from 'fastify';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AppContext } from '../src/context.ts';
import { H, testServer } from './helpers.ts';

/** Manual runs: a person follows the steps and records each result; nothing is executed. */
let app: FastifyInstance;
let ctx: AppContext;
let appId = '';
let envId = '';
let moduleId = '';
let invoiceId = '';
let searchId = '';
// A 1×1 PNG.
const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

async function call(method: string, url: string, payload?: unknown) {
  return app.inject({
    method: method as 'GET',
    url,
    headers: H,
    ...(payload !== undefined && { payload: payload as object }),
  });
}
async function ok<T = Record<string, unknown> & { id: string }>(
  method: string,
  url: string,
  payload?: unknown,
) {
  const res = await call(method, url, payload);
  if (res.statusCode >= 300) throw new Error(`${method} ${url} → ${res.statusCode}: ${res.body}`);
  return (res.body ? res.json() : undefined) as T;
}
type Line = { number: string; text: string; depth: number; group: boolean };
type Checklist = {
  item: { status: string; errorMessage: string | null };
  lines: Line[];
  results: { number: string; status: string; note: string; screenshot?: string }[];
};
type RunDetail = {
  status: string;
  mode: string;
  totalsJson: Record<string, number>;
  items: { id: string; status: string; errorMessage: string | null }[];
};

beforeAll(async () => {
  ({ app, ctx } = await testServer());
  appId = (await ok('POST', '/api/applications', { name: 'Manual', slug: 'manual' })).id;
  envId = (
    await ok('POST', `/api/applications/${appId}/environments`, {
      name: 'Staging',
      baseUrl: 'http://staging.example.test',
      variables: { shop: 'Main street' },
    })
  ).id;
  moduleId = (await ok('POST', `/api/applications/${appId}/modules`, { name: 'Billing' })).id;
  const signIn = await ok('POST', `/api/applications/${appId}/blocks`, {
    name: 'Sign in',
    inputs: [{ name: 'user', default: 'cashier@shop.test' }],
    steps: [
      {
        type: 'ui.fill',
        params: { value: '{{vars.user}}' },
        locators: [{ strategy: 'label', value: 'Email' }],
      },
      {
        type: 'ui.fill',
        params: { value: '{{secret.password}}' },
        locators: [{ strategy: 'label', value: 'Password' }],
      },
      { type: 'ui.click', locators: [{ strategy: 'role', value: 'button', name: 'Sign in' }] },
    ],
  });
  invoiceId = (
    await ok('POST', `/api/modules/${moduleId}/scenarios`, {
      name: 'Print an invoice',
      steps: [
        { type: 'util.useBlock', params: { blockId: signIn.id } },
        { type: 'ui.navigate', params: { url: '{{env.baseUrl}}/invoices' } },
        {
          type: 'util.manual',
          params: {
            instruction: 'Print the invoice at {{env.shop}}',
            expected: 'The total is {{data.total}}',
          },
        },
      ],
    })
  ).id;
  await ok('POST', `/api/scenarios/${invoiceId}/test-cases`, {
    title: 'Big order',
    data: { total: '420.00' },
  });
  searchId = (
    await ok('POST', `/api/modules/${moduleId}/scenarios`, {
      name: 'Search',
      steps: [
        { type: 'util.manual', params: { instruction: 'Search for "lamp"', expected: 'Three results' } },
      ],
    })
  ).id;
}, 30_000);
afterAll(async () => {
  await app.close();
});

const start = (ids: string[]) =>
  ok<{ id: string; status: string; mode: string }>('POST', '/api/runs', {
    applicationId: appId,
    environmentId: envId,
    mode: 'manual',
    scope: { type: 'scenarios', ids },
  });

describe('manual runs', () => {
  it('starts without executing, and lists the steps as a checklist with blocks expanded and data filled in', async () => {
    const run = await start([invoiceId]);
    expect(run).toMatchObject({ status: 'running', mode: 'manual' });
    await ctx.runs.idle();
    const detail = await ok<RunDetail>('GET', `/api/runs/${run.id}`);
    expect(detail.items.map((i) => i.status)).toEqual(['queued']);
    const c = await ok<Checklist>('GET', `/api/run-items/${detail.items[0]!.id}/manual`);
    expect(c.lines.map((l) => `${l.number}${l.group ? ' [group]' : ''} ${l.text}`)).toEqual([
      '1 [group] Run a reusable block — Sign in',
      '1.1 Type "cashier@shop.test" into the "Email" field',
      '1.2 Type "{{secret.password}}" into the "Password" field',
      '1.3 Click the "Sign in" button',
      '2 Open http://staging.example.test/invoices',
      '3 Print the invoice at Main street — expect: The total is 420.00',
    ]);
  });

  it('records results with notes and screenshots; a failed step fails the test and the run', async () => {
    const run = await start([invoiceId]);
    const itemId = (await ok<RunDetail>('GET', `/api/runs/${run.id}`)).items[0]!.id;
    const shot = await ok<{ path: string }>('POST', `/api/run-items/${itemId}/manual/attachments`, {
      number: '3',
      dataUrl: PNG,
    });
    expect(existsSync(join(ctx.config.artifactsDir, shot.path))).toBe(true);

    // Saved part-way: the test stays open.
    const partial = await ok<Checklist>('PUT', `/api/run-items/${itemId}/manual`, {
      results: [{ number: '1.1', status: 'passed' }],
    });
    expect(partial.item.status).toBe('running');

    const done = await ok<Checklist>('PUT', `/api/run-items/${itemId}/manual`, {
      results: [
        { number: '1.1', status: 'passed' },
        { number: '1.2', status: 'passed' },
        { number: '1.3', status: 'passed' },
        { number: '2', status: 'passed' },
        { number: '3', status: 'failed', note: 'Total shows 400.00', screenshot: shot.path },
      ],
      done: true,
    });
    expect(done.item).toMatchObject({
      status: 'failed',
      errorMessage: 'Failed at step 3: Total shows 400.00',
    });
    expect(done.results.find((r) => r.number === '3')).toMatchObject({
      status: 'failed',
      screenshot: shot.path,
    });

    const detail = await ok<RunDetail>('GET', `/api/runs/${run.id}`);
    expect(detail.status).toBe('failed');
    expect(detail.totalsJson).toMatchObject({ total: 1, failed: 1 });
    // The run page shows the recorded steps like any run.
    const steps = await ok<{ steps: { label: string; status: string; message: string | null }[] }>(
      'GET',
      `/api/run-items/${itemId}`,
    );
    expect(steps.steps.at(-1)).toMatchObject({ status: 'failed', message: 'Total shows 400.00' });
    expect(
      (await call('PUT', `/api/run-items/${itemId}/manual`, { results: [], done: true })).statusCode,
    ).toBe(409);
  });

  it('blocked counts as broken; finishing the run early marks the rest "not tested"', async () => {
    const run = await start([invoiceId, searchId]);
    const items = (await ok<RunDetail>('GET', `/api/runs/${run.id}`)).items;
    const blocked = await ok<Checklist>('PUT', `/api/run-items/${items[0]!.id}/manual`, {
      results: [{ number: '1.1', status: 'blocked', note: 'Staging login is down' }],
      done: true,
    });
    expect(blocked.item).toMatchObject({
      status: 'broken',
      errorMessage: 'Blocked at step 1.1: Staging login is down',
    });
    expect(blocked.results[0]).toMatchObject({ status: 'blocked' });

    const finished = await ok<{ status: string }>('POST', `/api/runs/${run.id}/manual/finish`);
    expect(finished.status).toBe('failed');
    const detail = await ok<RunDetail>('GET', `/api/runs/${run.id}`);
    expect(detail.items[1]).toMatchObject({ status: 'skipped', errorMessage: 'Not tested' });
    expect(detail.totalsJson).toMatchObject({ broken: 1, skipped: 1 });
  });

  it('rejects foreign screenshots and automated runs; an automated run skips manual checks', async () => {
    const run = await start([searchId]);
    const itemId = (await ok<RunDetail>('GET', `/api/runs/${run.id}`)).items[0]!.id;
    const bad = await call('PUT', `/api/run-items/${itemId}/manual`, {
      results: [{ number: '1', status: 'passed', screenshot: '../../secret.png' }],
    });
    expect(bad.statusCode).toBe(400);
    expect(
      (
        await call('POST', `/api/run-items/${itemId}/manual/attachments`, {
          number: '1',
          dataUrl: 'data:text/html;base64,PGI+',
        })
      ).statusCode,
    ).toBe(400);
    await ok('PUT', `/api/run-items/${itemId}/manual`, {
      results: [{ number: '1', status: 'passed' }],
      done: true,
    });
    expect((await ok<RunDetail>('GET', `/api/runs/${run.id}`)).status).toBe('passed');

    const auto = await ok<{ id: string }>('POST', '/api/runs', {
      applicationId: appId,
      environmentId: envId,
      scope: { type: 'scenarios', ids: [searchId] },
    });
    await ctx.runs.idle();
    const autoDetail = await ok<RunDetail>('GET', `/api/runs/${auto.id}`);
    expect(autoDetail).toMatchObject({ status: 'passed', mode: 'auto' });
    expect((await call('GET', `/api/run-items/${autoDetail.items[0]!.id}/manual`)).statusCode).toBe(409);
  });
});
