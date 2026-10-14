import type { FastifyInstance } from 'fastify';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AppContext } from '../src/context.ts';
import { H, testServer } from './helpers.ts';

/** Desktop (Electron) applications: the environment says which app to start; UI steps run in its windows. */
let app: FastifyInstance;
let ctx: AppContext;
let appId = '';
let envId = '';
let moduleId = '';
const DEMO = fileURLToPath(new URL('../../../demo/desktop-app', import.meta.url));

async function ok<T = Record<string, unknown> & { id: string }>(
  method: string,
  url: string,
  payload?: unknown,
) {
  const res = await app.inject({
    method: method as 'GET',
    url,
    headers: H,
    ...(payload !== undefined && { payload: payload as object }),
  });
  if (res.statusCode >= 300) throw new Error(`${method} ${url} → ${res.statusCode}: ${res.body}`);
  return (res.body ? res.json() : undefined) as T;
}
const addNote = (text: string) => [
  {
    type: 'ui.fill',
    params: { value: text },
    locators: [{ strategy: 'placeholder', value: 'Write a note' }],
  },
  { type: 'ui.click', locators: [{ strategy: 'testId', value: 'add-note' }] },
];
const count = (expected: string) => ({
  type: 'ui.assert',
  params: { check: 'text', expected },
  locators: [{ strategy: 'role', value: 'status' }],
});
async function runOne(scenarioId: string) {
  const r = await ok<{ id: string }>('POST', '/api/runs', {
    applicationId: appId,
    environmentId: envId,
    scope: { type: 'scenarios', ids: [scenarioId] },
    options: { video: 'off', trace: 'off' },
  });
  await ctx.runs.idle();
  return ok<{ status: string; items: { id: string; status: string; errorMessage: string | null }[] }>(
    'GET',
    `/api/runs/${r.id}`,
  );
}

beforeAll(async () => {
  ({ app, ctx } = await testServer());
  appId = (
    await ok('POST', '/api/applications', {
      name: 'Notes desktop',
      slug: 'notes-desktop',
      platform: 'electron',
    })
  ).id;
  envId = (
    await ok('POST', `/api/applications/${appId}/environments`, {
      name: 'Local build',
      baseUrl: 'app://notes',
      variables: { demo: DEMO },
      browserDefaults: { browser: 'chromium', headless: true, electron: { appPath: '{{env.demo}}' } },
    })
  ).id;
  moduleId = (await ok('POST', `/api/applications/${appId}/modules`, { name: 'Notes' })).id;
});
afterAll(async () => {
  await app.close();
});

describe('desktop (Electron) apps', () => {
  it('runs UI steps in the app started from the environment', async () => {
    const s = await ok('POST', `/api/modules/${moduleId}/scenarios`, {
      name: 'Add a note',
      steps: [...addNote('Buy milk'), count('1 note')],
    });
    const run = await runOne(s.id);
    expect(run.items[0]?.errorMessage ?? null).toBeNull();
    expect(run.status).toBe('passed');
  }, 90_000);

  it('a bug in the app fails the test with a diagnosis (the count is off from three notes on)', async () => {
    const s = await ok('POST', `/api/modules/${moduleId}/scenarios`, {
      name: 'Count three notes',
      steps: [
        ...addNote('one'),
        ...addNote('two'),
        ...addNote('three'),
        // Enough for a slow Windows runner to find the counter (it then shows the wrong count).
        { ...count('3 notes'), timeoutMs: 6000 },
      ],
    });
    const run = await runOne(s.id);
    expect(run.status).toBe('failed');
    expect(run.items[0]!.errorMessage).toContain('3 notes');
    const diagnosis = await ok<{ diagnosis: { owner?: string; ownerHint?: string; title?: string } | null }>(
      'GET',
      `/api/run-items/${run.items[0]!.id}`,
    );
    expect(JSON.stringify(diagnosis)).toContain('2 notes');
  }, 90_000);

  it('an environment without launch settings is refused; the platform is exported and imported', async () => {
    const bad = await app.inject({
      method: 'POST',
      url: `/api/applications/${appId}/environments`,
      headers: H,
      payload: { name: 'Broken', baseUrl: 'app://notes', browserDefaults: { electron: { args: [] } } },
    });
    expect(bad.statusCode).toBe(400);
    const exported = await ok<Record<string, unknown>>('GET', `/api/applications/${appId}/export`);
    const imported = await ok<{ applicationId: string }>(
      'POST',
      '/api/applications/import?slug=notes-copy',
      exported,
    );
    const copy = await ok<{ platform: string }>('GET', `/api/applications/${imported.applicationId}`);
    expect(copy.platform).toBe('electron');
  });
  it('a manual run opens the desktop app with the panel, marks steps and keeps the session video', async () => {
    const s = await ok('POST', `/api/modules/${moduleId}/scenarios`, {
      name: 'Check the About window',
      execution: 'manual',
      steps: [
        { type: 'util.manual', params: { instruction: 'Add a note', expected: 'The count shows 1 note' } },
        { type: 'util.manual', params: { instruction: 'Open About', expected: 'It names the author' } },
      ],
    });
    const run = await ok<{ id: string }>('POST', '/api/runs', {
      applicationId: appId,
      environmentId: envId,
      mode: 'manual',
      scope: { type: 'scenarios', ids: [s.id] },
    });
    const itemId = (await ok<{ items: { id: string }[] }>('GET', `/api/runs/${run.id}`)).items[0]!.id;
    const opened = await ok<{ url: string }>('POST', `/api/run-items/${itemId}/manual/browser`);
    expect(opened.url).toMatch(/index\.html$/);
    const page = ctx.manualBrowser.pageOf(itemId)!;
    expect(await page.title()).toBe('Notes');
    const panel = page.locator('stepforge-manual .panel');
    await expect.poll(() => panel.innerText()).toContain('Add a note');
    await panel.getByRole('button', { name: '✓ Pass' }).click();
    await expect.poll(() => panel.innerText()).toContain('Open About');
    await panel.getByRole('button', { name: '✓ Pass' }).click();
    await panel.getByRole('button', { name: 'Finish the test' }).click();
    type Checklist = { video: string | null; item: { status: string } };
    await expect
      .poll(async () => (await ok<Checklist>('GET', `/api/run-items/${itemId}/manual`)).video, {
        timeout: 20_000,
      })
      .toBeTruthy();
    const after = await ok<Checklist>('GET', `/api/run-items/${itemId}/manual`);
    expect(after.item.status).toBe('passed');
    expect(existsSync(join(ctx.config.artifactsDir, after.video!))).toBe(true);
  }, 90_000);
});
