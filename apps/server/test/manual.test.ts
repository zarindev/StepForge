import type { FastifyInstance } from 'fastify';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { schema } from '@stepforge/db';
import { eq } from 'drizzle-orm';
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
  results: { number: string; status: string; note: string; screenshots: string[] }[];
  video: string | null;
  videos: string[];
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
      screenshots: [shot.path],
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

describe('manual runs keep their results safe', () => {
  const scenario = async (name: string, steps: unknown[]) =>
    (await ok('POST', `/api/modules/${moduleId}/scenarios`, { name, steps })).id;
  const manualStep = (instruction: string) => ({ type: 'util.manual', params: { instruction } });
  const firstItem = async (ids: string[]) => {
    const run = await start(ids);
    return { run, items: (await ok<RunDetail>('GET', `/api/runs/${run.id}`)).items };
  };
  const results = (c: Checklist) => Object.fromEntries(c.results.map((r) => [r.number, r.status]));

  it('keeps the checklist the test was opened with: editing or deleting the scenario moves no results', async () => {
    const id = await scenario('Snapshot', [manualStep('Open the cart'), manualStep('Pay')]);
    const { items } = await firstItem([id]);
    const itemId = items[0]!.id;
    await ok('PUT', `/api/run-items/${itemId}/manual`, { results: [{ number: '1', status: 'passed' }] });

    // A step is inserted at the top mid-run: "1" is still "Open the cart", with its result.
    await ok('PUT', `/api/scenarios/${id}/steps`, {
      steps: [manualStep('Sign in'), manualStep('Open the cart'), manualStep('Pay')],
    });
    const edited = await ok<Checklist>('PUT', `/api/run-items/${itemId}/manual`, {
      result: { number: '2', status: 'failed', note: 'Card declined' },
    });
    expect(edited.lines.map((l) => l.text)).toEqual(['Open the cart', 'Pay']);
    expect(results(edited)).toEqual({ 1: 'passed', 2: 'failed' });
    expect(
      (await ok<{ steps: { label: string }[] }>('GET', `/api/run-items/${itemId}`)).steps.map((s) => s.label),
    ).toEqual(['Open the cart', 'Pay']);

    // The scenario is deleted: saving keeps every result.
    expect((await call('DELETE', `/api/scenarios/${id}`)).statusCode).toBe(204);
    const after = await ok<Checklist>('PUT', `/api/run-items/${itemId}/manual`, {
      result: { number: '2', status: 'failed', note: 'Card declined again' },
    });
    expect(after.lines).toHaveLength(2);
    expect(results(after)).toEqual({ 1: 'passed', 2: 'failed' });
  });

  it('refuses to save a test whose scenario was deleted before it was opened (nothing is wiped)', async () => {
    const id = await scenario('Gone early', [manualStep('Look around')]);
    const { items } = await firstItem([id]);
    await ok('DELETE', `/api/scenarios/${id}`);
    const res = await call('PUT', `/api/run-items/${items[0]!.id}/manual`, {
      results: [{ number: '1', status: 'passed' }],
    });
    expect(res.statusCode).toBe(409);
    expect((await ok<Checklist>('GET', `/api/run-items/${items[0]!.id}/manual`)).lines).toEqual([]);
  });

  it('shows a deleted block or called scenario as deleted instead of failing the checklist', async () => {
    const block = await ok('POST', `/api/applications/${appId}/blocks`, {
      name: 'Temporary',
      steps: [{ type: 'util.log', params: { message: 'hi' } }],
    });
    const callee = await scenario('Callee', [manualStep('Called step')]);
    const id = await scenario('Uses deleted things', [
      { type: 'util.useBlock', params: { blockId: block.id } },
      { type: 'util.callScenario', params: { scenarioId: callee } },
      manualStep('Last'),
    ]);
    await ok('DELETE', `/api/blocks/${block.id}`);
    await ok('DELETE', `/api/scenarios/${callee}`);
    const { items } = await firstItem([id]);
    const c = await ok<Checklist>('GET', `/api/run-items/${items[0]!.id}/manual`);
    expect(c.lines.map((l) => `${l.number} ${l.text}`)).toEqual([
      '1 Run a reusable block — (deleted block)',
      '2 Run another scenario — (deleted scenario)',
      '3 Last',
    ]);
    await ok('PUT', `/api/run-items/${items[0]!.id}/manual`, { result: { number: '3', status: 'passed' } });
  });

  it('saves per line: lines not sent keep their stored result, screenshots and notes', async () => {
    const id = await scenario('Per line', [manualStep('A'), manualStep('B'), manualStep('C')]);
    const { items } = await firstItem([id]);
    const itemId = items[0]!.id;
    const shot = await ok<{ path: string }>('POST', `/api/run-items/${itemId}/manual/attachments`, {
      number: '1',
      dataUrl: PNG,
    });
    // E.g. the browser panel saved a screenshot on line 1 …
    await ok('PUT', `/api/run-items/${itemId}/manual`, {
      result: { number: '1', status: 'pending', screenshots: [shot.path] },
    });
    // … and the dashboard saves line 2 (one line) and then a list without line 1.
    await ok('PUT', `/api/run-items/${itemId}/manual`, { result: { number: '2', status: 'passed' } });
    const c = await ok<Checklist>('PUT', `/api/run-items/${itemId}/manual`, {
      results: [{ number: '3', status: 'failed', note: 'Broken' }],
    });
    expect(c.results.map((r) => [r.number, r.status, r.screenshots.length, r.note])).toEqual([
      ['1', 'pending', 1, ''],
      ['2', 'passed', 0, ''],
      ['3', 'failed', 0, 'Broken'],
    ]);
    // Finishing turns the open line into skipped.
    const done = await ok<Checklist>('PUT', `/api/run-items/${itemId}/manual`, { done: true });
    expect(results(done)).toEqual({ 1: 'skipped', 2: 'passed', 3: 'failed' });
    expect(done.item.status).toBe('failed');
  });

  it('a finished test stays finished when it is changed later (unless reopened)', async () => {
    const id = await scenario('Stays finished', [manualStep('A'), manualStep('B')]);
    const { run } = await firstItem([id, searchId]);
    const detail = await ok<{ items: { id: string; labelJson: { scenario: string } }[] }>(
      'GET',
      `/api/runs/${run.id}`,
    );
    const itemId = detail.items.find((i) => i.labelJson.scenario === 'Stays finished')!.id;
    await ok('PUT', `/api/run-items/${itemId}/manual`, {
      results: [{ number: '1', status: 'passed' }],
      done: true,
    });
    const changed = await ok<Checklist>('PUT', `/api/run-items/${itemId}/manual`, {
      result: { number: '2', status: 'failed' },
    });
    expect(changed.item.status).toBe('failed');
    expect(results(changed)).toEqual({ 1: 'passed', 2: 'failed' });
    const reopened = await ok<Checklist>('PUT', `/api/run-items/${itemId}/manual`, {
      result: { number: '2', status: 'pending' },
      reopen: true,
    });
    expect(reopened.item.status).toBe('running');
  });

  it('every bug report from a step is a new bug', async () => {
    const id = await scenario('Two bugs', [manualStep('Pay')]);
    const { items } = await firstItem([id]);
    const itemId = items[0]!.id;
    await ok('PUT', `/api/run-items/${itemId}/manual`, { result: { number: '1', status: 'failed' } });
    const first = await ok<{ id: string; code: string; title: string }>(
      'POST',
      `/api/run-items/${itemId}/manual/bug`,
      { number: '1', title: 'Pay button is grey', severity: 'minor' },
    );
    const second = await ok<{ id: string; code: string; title: string; severity: string; category: string }>(
      'POST',
      `/api/run-items/${itemId}/manual/bug`,
      { number: '1', title: 'Total is wrong', severity: 'critical' },
    );
    expect(second.id).not.toBe(first.id);
    expect(second).toMatchObject({ title: 'Total is wrong', severity: 'critical', category: 'manual' });
    expect(second.code).not.toBe(first.code);
  });

  it('finishing the run turns open steps into skipped; the latest video is shown; clips must be this test’s', async () => {
    const id = await scenario('Finish early', [manualStep('A'), manualStep('B')]);
    const { run, items } = await firstItem([id]);
    const itemId = items[0]!.id;
    const bad = await call('PUT', `/api/run-items/${itemId}/manual`, {
      result: { number: '1', status: 'passed', clips: [{ startMs: 0, endMs: 5, video: 'runs/x/y/v.webm' }] },
    });
    expect(bad.statusCode).toBe(400);
    await ok('PUT', `/api/run-items/${itemId}/manual`, {
      result: { number: '1', status: 'pending', note: 'Started' },
    });
    for (const [path, at] of [
      ['old.webm', '2026-01-01T00:00:00.000Z'],
      ['new.webm', '2026-02-01T00:00:00.000Z'],
    ] as const)
      ctx.db
        .insert(schema.artifacts)
        .values({ id: `video-${path}-${itemId}`, runItemId: itemId, kind: 'video', path, createdAt: at })
        .run();
    const c = await ok<Checklist>('GET', `/api/run-items/${itemId}/manual`);
    expect(c.video).toBe('new.webm');
    expect(c.videos).toEqual(['new.webm', 'old.webm']);

    await ok('POST', `/api/runs/${run.id}/manual/finish`);
    const rows = ctx.db
      .select()
      .from(schema.stepResults)
      .where(eq(schema.stepResults.runItemId, itemId))
      .all();
    expect(rows.map((r) => r.status)).toEqual(['skipped']);
  });
});
