import type { FastifyInstance } from 'fastify';
import { existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AppContext } from '../src/context.ts';
import { H, testServer } from './helpers.ts';

/**
 * Manual tests: a test can be manual (left out of automated runs, pending until a person runs it); the tester's
 * browser shows the StepForge panel, and every action there is saved to the test's results.
 */
process.env.STEPFORGE_MANUAL_HEADLESS = '1';
let app: FastifyInstance;
let ctx: AppContext;
let site: Server;
let appId = '';
let envId = '';
let manualId = '';
let autoId = '';

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
type Checklist = {
  item: { status: string; errorMessage: string | null };
  results: {
    number: string;
    status: string;
    note: string;
    screenshots: string[];
    clips: { startMs: number; endMs: number; video?: string }[];
    bug?: { code: string };
  }[];
  video: string | null;
  browserOpen: boolean;
};

beforeAll(async () => {
  ({ app, ctx } = await testServer());
  site = createServer((_req, res) =>
    res
      .writeHead(200, { 'content-type': 'text/html' })
      .end('<title>Shop</title><h1>Checkout</h1><button>Pay</button>'),
  );
  await new Promise<void>((r) => site.listen(0, '127.0.0.1', r));
  appId = (await ok('POST', '/api/applications', { name: 'Manual browser', slug: 'manual-browser' })).id;
  envId = (
    await ok('POST', `/api/applications/${appId}/environments`, {
      name: 'Local',
      baseUrl: `http://127.0.0.1:${(site.address() as { port: number }).port}`,
    })
  ).id;
  const mod = (await ok('POST', `/api/applications/${appId}/modules`, { name: 'Checkout' })).id;
  manualId = (
    await ok('POST', `/api/modules/${mod}/scenarios`, {
      name: 'Pay with a card',
      execution: 'manual',
      steps: [
        { type: 'ui.navigate', params: { url: '/checkout' } },
        { type: 'util.manual', params: { instruction: 'Press Pay', expected: 'A receipt appears' } },
      ],
    })
  ).id;
  autoId = (
    await ok('POST', `/api/modules/${mod}/scenarios`, {
      name: 'Health',
      steps: [{ type: 'util.log', params: { message: 'ok' } }],
    })
  ).id;
}, 30_000);
afterAll(async () => {
  await app.close();
  site.close();
});

describe('manual tests and the tester’s browser', () => {
  it('automated runs leave manual tests out; a manual run takes them', async () => {
    const auto = await ok<{ id: string }>('POST', '/api/runs', {
      applicationId: appId,
      environmentId: envId,
      scope: { type: 'application' },
    });
    await ctx.runs.idle();
    const detail = await ok<{ items: { labelJson: { scenario: string } }[] }>('GET', `/api/runs/${auto.id}`);
    expect(detail.items.map((i) => i.labelJson.scenario)).toEqual(['Health']);
    const onlyManual = await call('POST', '/api/runs', {
      applicationId: appId,
      environmentId: envId,
      scope: { type: 'scenarios', ids: [manualId] },
    });
    expect(onlyManual.statusCode).toBe(400);
    expect(onlyManual.json().message).toContain('manual ones run in a manual run');
    void autoId;
  });

  it('the panel marks steps, takes screenshots and clips, and finishing keeps the session video; a bug can be filed', async () => {
    const run = await ok<{ id: string }>('POST', '/api/runs', {
      applicationId: appId,
      environmentId: envId,
      mode: 'manual',
      scope: { type: 'scenarios', ids: [manualId] },
    });
    const itemId = (await ok<{ items: { id: string }[] }>('GET', `/api/runs/${run.id}`)).items[0]!.id;
    const opened = await ok<{ url: string }>('POST', `/api/run-items/${itemId}/manual/browser`);
    expect(opened.url).toMatch(/\/checkout$/);
    const page = ctx.manualBrowser.pageOf(itemId)!;
    const panel = page.locator('stepforge-manual .panel'); // inside the panel's shadow root
    await expect.poll(() => panel.innerText()).toContain('Open /checkout');
    expect(await panel.innerText()).toContain('Next: Press Pay');

    if (process.env.STEPFORGE_SHOTS)
      await page.screenshot({ path: `${process.env.STEPFORGE_SHOTS}/manual-panel.png` });
    await panel.getByRole('button', { name: '✓ Pass' }).click();
    await expect.poll(() => panel.innerText()).toContain('Expect: A receipt appears');
    await panel.getByRole('button', { name: 'Take a screenshot' }).click();
    await expect.poll(() => panel.innerText()).toContain('Screenshot (1)');
    await panel.getByRole('button', { name: 'Record a clip' }).click();
    await page.waitForTimeout(300);
    await panel.getByRole('button', { name: 'Stop the clip' }).click();
    await panel.locator('textarea').fill('Nothing happens after Pay');
    await panel.getByRole('button', { name: '✗ Fail' }).click();
    await expect
      .poll(async () => (await ok<Checklist>('GET', `/api/run-items/${itemId}/manual`)).results.length)
      .toBe(2);

    const mid = await ok<Checklist>('GET', `/api/run-items/${itemId}/manual`);
    expect(mid.browserOpen).toBe(true);
    const step2 = mid.results.find((r) => r.number === '2')!;
    expect(step2).toMatchObject({ status: 'failed', note: 'Nothing happens after Pay' });
    expect(step2.screenshots).toHaveLength(1);
    expect(existsSync(join(ctx.config.artifactsDir, step2.screenshots[0]!))).toBe(true);
    expect(step2.clips).toHaveLength(1);
    expect(step2.clips[0]!.endMs).toBeGreaterThan(step2.clips[0]!.startMs);

    await panel.getByRole('button', { name: 'Finish the test' }).click();
    await expect
      .poll(async () => (await ok<Checklist>('GET', `/api/run-items/${itemId}/manual`)).video, {
        timeout: 15_000,
      })
      .toBeTruthy();
    const after = await ok<Checklist>('GET', `/api/run-items/${itemId}/manual`);
    expect(after.item).toMatchObject({
      status: 'failed',
      errorMessage: 'Failed at step 2: Nothing happens after Pay',
    });
    expect(after.browserOpen).toBe(false);
    expect(after.results.find((r) => r.number === '2')!.clips[0]!.video).toBe(after.video);
    expect(existsSync(join(ctx.config.artifactsDir, after.video!))).toBe(true);

    const bug = await ok<{ code: string; stepsToReproduceJson: string[]; expected: string; actual: string }>(
      'POST',
      `/api/run-items/${itemId}/manual/bug`,
      {
        number: '2',
        title: 'Pay does nothing',
        expected: 'A receipt appears',
        actual: 'Nothing happens',
        severity: 'critical',
      },
    );
    expect(bug).toMatchObject({ code: 'BUG-001', expected: 'A receipt appears', actual: 'Nothing happens' });
    expect(bug.stepsToReproduceJson).toEqual([
      '1. Open /checkout',
      '2. Press Pay — expect: A receipt appears',
    ]);
    const linked = await ok<Checklist>('GET', `/api/run-items/${itemId}/manual`);
    expect(linked.results.find((r) => r.number === '2')!.bug?.code).toBe('BUG-001');
  }, 60_000);

  const manualRun = async () => {
    const run = await ok<{ id: string }>('POST', '/api/runs', {
      applicationId: appId,
      environmentId: envId,
      mode: 'manual',
      scope: { type: 'scenarios', ids: [manualId] },
    });
    return (await ok<{ items: { id: string }[] }>('GET', `/api/runs/${run.id}`)).items[0]!.id;
  };

  it('opening twice at once starts one browser; finishing in the dashboard closes it', async () => {
    const itemId = await manualRun();
    const opened: unknown[] = [];
    const listen = (e: { type: string; itemId?: string; open?: boolean }) => {
      if (e.type === 'manual.browser' && e.itemId === itemId && e.open) opened.push(e);
    };
    ctx.bus.on('event', listen);
    try {
      const [a, b] = await Promise.all([
        ok<{ url: string }>('POST', `/api/run-items/${itemId}/manual/browser`),
        ok<{ url: string }>('POST', `/api/run-items/${itemId}/manual/browser`),
      ]);
      expect(a.url).toBe(b.url);
      expect(opened).toHaveLength(1);
    } finally {
      ctx.bus.off('event', listen);
    }
    const page = ctx.manualBrowser.pageOf(itemId)!;
    const panel = page.locator('stepforge-manual .panel');
    await expect.poll(() => panel.innerText()).toContain('Open /checkout');

    // Step 1 marked in the dashboard: the panel moves on to step 2 (the current step is not stuck).
    await ok('PUT', `/api/run-items/${itemId}/manual`, { result: { number: '1', status: 'passed' } });
    await expect.poll(() => panel.innerText()).toContain('Expect: A receipt appears');
    // Going back to step 1 keeps it current until it gets a new result.
    await panel.locator('select').selectOption('1');
    await expect.poll(() => panel.innerText()).toContain('Step 1');
    await panel.getByRole('button', { name: '✗ Fail' }).click();
    await expect.poll(() => panel.innerText()).toContain('Step 2');

    // A note typed before a screenshot is saved once, also when the step is then marked.
    await panel.locator('textarea').fill('Spinner forever');
    await panel.getByRole('button', { name: 'Take a screenshot' }).click();
    await expect.poll(() => panel.innerText()).toContain('Screenshot (1)');
    expect(await panel.locator('textarea').inputValue()).toBe('');
    await panel.getByRole('button', { name: '✗ Fail' }).click();
    await expect
      .poll(
        async () =>
          (await ok<Checklist>('GET', `/api/run-items/${itemId}/manual`)).results.find(
            (r) => r.number === '2',
          )?.status,
      )
      .toBe('failed');
    const step2 = (await ok<Checklist>('GET', `/api/run-items/${itemId}/manual`)).results.find(
      (r) => r.number === '2',
    )!;
    expect(step2.note).toBe('Spinner forever');

    // Finished from the dashboard: the browser closes and the test stays finished.
    await ok('PUT', `/api/run-items/${itemId}/manual`, { done: true });
    await expect.poll(() => ctx.manualBrowser.isOpen(itemId), { timeout: 15_000 }).toBe(false);
    const after = await ok<Checklist>('GET', `/api/run-items/${itemId}/manual`);
    expect(after.item.status).toBe('failed');
    expect(after.browserOpen).toBe(false);
    expect((await call('POST', `/api/run-items/${itemId}/manual/browser`)).statusCode).toBe(409);
  }, 60_000);
});
