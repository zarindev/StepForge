import type { FastifyInstance } from 'fastify';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AppContext } from '../src/context.ts';
import { startFakeAppium, type FakeAppium } from './fake-appium.ts';
import { H, testServer } from './helpers.ts';

/**
 * Manual tests and recording in phone and desktop apps, against a fake Appium server (the same routes run on a real
 * device: see android-apps.test.ts and ios-apps.test.ts, and the desktop CI jobs).
 */
let app: FastifyInstance;
let ctx: AppContext;
let appium: FakeAppium;

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

/** An application of a platform, with an environment, a module and a manual scenario. */
async function setUp(platform: string, launch: Record<string, unknown>) {
  const slug = `${platform}-${Date.now().toString(36)}`;
  const appId = (await ok('POST', '/api/applications', { name: slug, slug, platform })).id;
  const envId = (
    await ok('POST', `/api/applications/${appId}/environments`, {
      name: 'Device',
      baseUrl: 'app://careclinic',
      browserDefaults: { [platform]: launch },
    })
  ).id;
  const moduleId = (await ok('POST', `/api/applications/${appId}/modules`, { name: 'Sign in' })).id;
  const scenario = await ok('POST', `/api/modules/${moduleId}/scenarios`, {
    name: 'Sign in by hand',
    execution: 'manual',
    steps: [
      { type: 'util.manual', params: { instruction: 'Type your email', expected: 'It shows in the field' } },
      { type: 'util.manual', params: { instruction: 'Press Sign in', expected: 'The patient list opens' } },
    ],
  });
  return { appId, envId, moduleId, scenarioId: scenario.id };
}

type Checklist = {
  item: { status: string };
  browserOpen: boolean;
  app: { platform: string; kind: string; recording: boolean; clip: boolean; current: string | null } | null;
  results: {
    number: string;
    status: string;
    screenshots: string[];
    clips: { startMs: number; endMs: number; video?: string }[];
    bug?: { code: string };
  }[];
  videos: string[];
};

beforeAll(async () => {
  ({ app, ctx } = await testServer());
  appium = await startFakeAppium();
  const fake = { url: async () => appium.url, hasDriver: () => true } as never;
  ctx.manualBrowser.appium = fake;
  ctx.recorder.appium = fake;
});
afterAll(async () => {
  await app.close();
  await appium.close();
});

describe('manual tests in a phone app: its screen in the dashboard, next to the checklist', () => {
  it('opens the app, passes taps and typing on, keeps screenshots and clips from it, files a bug, closes on finish', async () => {
    const { appId, envId, scenarioId } = await setUp('android', { appPackage: 'com.stepforge.careclinic' });
    const run = await ok<{ id: string }>('POST', '/api/runs', {
      applicationId: appId,
      environmentId: envId,
      mode: 'manual',
      scope: { type: 'scenarios', ids: [scenarioId] },
    });
    const itemId = (await ok<{ items: { id: string }[] }>('GET', `/api/runs/${run.id}`)).items[0]!.id;
    // Not open yet: no screen.
    expect((await call('GET', `/api/run-items/${itemId}/manual/screen`)).statusCode).toBe(409);
    await ok('POST', `/api/run-items/${itemId}/manual/browser`);
    let check = await ok<Checklist>('GET', `/api/run-items/${itemId}/manual`);
    expect(check.browserOpen).toBe(true);
    expect(check.app).toMatchObject({ platform: 'Android', kind: 'phone', recording: true, current: '1' });

    const screen = await call('GET', `/api/run-items/${itemId}/manual/screen`);
    expect(screen.headers['content-type']).toBe('image/png');
    expect(screen.headers['x-screen-size']).toBe('1080x1920');
    // A tap on the email field (fractions of the picture) reaches the device at its pixels, and typing fills it.
    await ok('POST', `/api/run-items/${itemId}/manual/act`, { action: 'tap', x: 0.5, y: 250 / 1920 });
    const tap = appium.calls.filter((c) => c.path.endsWith('/actions')).at(-1)!;
    expect(JSON.stringify(tap.body)).toContain('"x":540,"y":250');
    await ok('POST', `/api/run-items/${itemId}/manual/act`, {
      action: 'type',
      text: 'nurse@careclinic.test',
    });
    expect(appium.typed.email).toBe('nurse@careclinic.test');
    const bad = await call('POST', `/api/run-items/${itemId}/manual/act`, { action: 'tap', x: 2, y: 0 });
    expect(bad.statusCode).toBe(400);

    // The panel's actions, as in the browser's panel: a screenshot from the device, a clip of its recording.
    await ok('POST', `/api/run-items/${itemId}/manual/panel`, { type: 'screenshot', number: '1' });
    await ok('POST', `/api/run-items/${itemId}/manual/panel`, { type: 'clipStart', number: '1' });
    expect((await ok<Checklist>('GET', `/api/run-items/${itemId}/manual`)).app?.clip).toBe(true);
    await ok('POST', `/api/run-items/${itemId}/manual/panel`, { type: 'clipStop', number: '1' });
    // Marked in the panel (a dashboard save sends the whole line, screenshots included).
    await ok('POST', `/api/run-items/${itemId}/manual/panel`, {
      type: 'mark',
      number: '1',
      status: 'passed',
    });
    check = await ok<Checklist>('GET', `/api/run-items/${itemId}/manual`);
    const one = check.results.find((r) => r.number === '1')!;
    expect(one.status).toBe('passed');
    expect(one.screenshots).toHaveLength(1);
    const shot = join(ctx.config.artifactsDir, one.screenshots[0]!);
    expect(readFileSync(shot).subarray(1, 4).toString()).toBe('PNG');
    expect(one.clips).toHaveLength(1);
    expect(one.clips[0]!.video).toMatch(/manual-video\/app-\d+\.mp4$/);
    // The next step is current now.
    expect(check.app?.current).toBe('2');

    await ok('POST', `/api/run-items/${itemId}/manual/panel`, {
      type: 'mark',
      number: '2',
      status: 'failed',
      note: 'Nothing happens',
    });
    await ok('POST', `/api/run-items/${itemId}/manual/panel`, { type: 'screenshot', number: '2' });
    const bug = await ok<{ code: string }>('POST', `/api/run-items/${itemId}/manual/bug`, {
      number: '2',
      title: 'Sign in does nothing',
    });
    expect(bug.code).toMatch(/^BUG-/);

    const quits = appium.quits;
    await ok('PUT', `/api/run-items/${itemId}/manual`, { done: true });
    await expect.poll(() => ctx.manualBrowser.isOpen(itemId)).toBe(false);
    // The app closes, and its screen recording is kept.
    await expect.poll(() => appium.quits).toBe(quits + 1);
    await expect
      .poll(async () => (await ok<Checklist>('GET', `/api/run-items/${itemId}/manual`)).videos.length)
      .toBe(1);
    check = await ok<Checklist>('GET', `/api/run-items/${itemId}/manual`);
    expect(check.item.status).toBe('failed');
    // The session's screen recording is the test's video.
    expect(existsSync(join(ctx.config.artifactsDir, one.clips[0]!.video!))).toBe(true);
  });

  it('explains a missing launch setting, and a closed session', async () => {
    const { appId, envId, scenarioId } = await setUp('ios', { app: '/nonexistent/CareClinic.app' });
    const run = await ok<{ id: string }>('POST', '/api/runs', {
      applicationId: appId,
      environmentId: envId,
      mode: 'manual',
      scope: { type: 'scenarios', ids: [scenarioId] },
    });
    const itemId = (await ok<{ items: { id: string }[] }>('GET', `/api/runs/${run.id}`)).items[0]!.id;
    const open = await call('POST', `/api/run-items/${itemId}/manual/browser`);
    expect(open.statusCode).toBe(400);
    expect(open.json().message).toContain('The app file was not found');
    const act = await call('POST', `/api/run-items/${itemId}/manual/act`, { action: 'back' });
    expect(act.statusCode).toBe(409);
  });
});

describe('recording a desktop app from its picture (macOS, fake Mac2)', () => {
  it('a click on the window picture becomes a step with the element’s locators; typing fills the field', async () => {
    const { appId, envId, moduleId } = await setUp('macos', { bundleId: 'com.stepforge.careclinic' });
    const started = await call('POST', '/api/recorder/start', {
      applicationId: appId,
      environmentId: envId,
      moduleId,
    });
    expect(started.statusCode, started.body).toBe(201);
    expect(started.json().native).toEqual({ platform: 'macOS' });
    // The picture is the app's window (400×300 points; the fake screenshot is the 1440×900 display).
    const screen = await call('GET', '/api/recorder/screen');
    expect(screen.headers['x-screen-size']).toBe('400x300');
    const at = (x: number, y: number) => ({ x: (x - 200) / 400, y: (y - 100) / 300 });
    const field = await ok<{ field: boolean }>('POST', '/api/recorder/act', {
      action: 'click',
      ...at(300, 140),
    });
    expect(field.field).toBe(true);
    await ok('POST', '/api/recorder/act', { action: 'type', text: 'nurse@careclinic.test' });
    await ok('POST', '/api/recorder/act', { action: 'click', ...at(250, 215) });
    await ok('POST', '/api/recorder/act', { action: 'key', key: 'Meta+S' });
    const stopped = await ok<{ steps: { type: string; locators: { strategy: string; value: string }[] }[] }>(
      'POST',
      '/api/recorder/stop',
    );
    expect(stopped.steps.map((s) => s.type)).toEqual(['ui.fill', 'ui.click', 'ui.press']);
    expect(stopped.steps[0]!.locators[0]).toMatchObject({ strategy: 'testId', value: 'email' });
    expect(stopped.steps[1]!.locators[0]).toMatchObject({ strategy: 'role', value: 'button' });
    expect(appium.typed.email).toBe('nurse@careclinic.test');
    await ok('POST', '/api/recorder/discard');
  });
});
