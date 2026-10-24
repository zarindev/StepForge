import { parseElements, type NativeManualSession } from '@stepforge/executor-native';
import type { FastifyInstance } from 'fastify';
import { copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AppContext } from '../src/context.ts';
import { H, testServer } from './helpers.ts';

/** Android apps: environments say which app and device; UI steps run through a local Appium server. */
let app: FastifyInstance;
let ctx: AppContext;
let appId = '';
let envId = '';
let moduleId = '';
const APK = fileURLToPath(new URL('../../../demo/android-app/careclinic.apk', import.meta.url));
const TOOLS = fileURLToPath(new URL('../../../data/tools', import.meta.url));
const AVD = process.env.STEPFORGE_TEST_ANDROID;

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

beforeAll(async () => {
  ({ app, ctx } = await testServer({ toolsDir: TOOLS }));
  appId = (
    await ok('POST', '/api/applications', {
      name: 'CareClinic mobile',
      slug: 'careclinic-mobile',
      platform: 'android',
    })
  ).id;
  envId = (
    await ok('POST', `/api/applications/${appId}/environments`, {
      name: 'Emulator',
      baseUrl: 'app://careclinic',
      variables: { apk: APK },
      browserDefaults: { android: { app: '{{env.apk}}', ...(AVD && AVD !== '1' && { avd: AVD }) } },
    })
  ).id;
  moduleId = (await ok('POST', `/api/applications/${appId}/modules`, { name: 'Patients' })).id;
});
afterAll(async () => {
  await app.close();
});

describe('Android apps', () => {
  it('an environment needs the app file or package; the platform is exported and imported', async () => {
    const bad = await call('POST', `/api/applications/${appId}/environments`, {
      name: 'Broken',
      baseUrl: 'app://x',
      browserDefaults: { android: { avd: 'Pixel' } },
    });
    expect(bad.statusCode).toBe(400);
    const exported = await ok<Record<string, unknown>>('GET', `/api/applications/${appId}/export`);
    const imported = await ok<{ applicationId: string }>(
      'POST',
      '/api/applications/import?slug=cc-copy',
      exported,
    );
    expect(
      (await ok<{ platform: string }>('GET', `/api/applications/${imported.applicationId}`)).platform,
    ).toBe('android');
  });

  it('a manual test can be marked on the run page without opening the app', async () => {
    const s = await ok('POST', `/api/modules/${moduleId}/scenarios`, {
      name: 'Check the list by hand',
      execution: 'manual',
      steps: [{ type: 'util.manual', params: { instruction: 'Add a patient', expected: 'It is listed' } }],
    });
    const run = await ok<{ id: string }>('POST', '/api/runs', {
      applicationId: appId,
      environmentId: envId,
      mode: 'manual',
      scope: { type: 'scenarios', ids: [s.id] },
    });
    const itemId = (await ok<{ items: { id: string }[] }>('GET', `/api/runs/${run.id}`)).items[0]!.id;
    // The checklist itself works: the tester marks the step on the run page (the run ends with its last test).
    await ok('PUT', `/api/run-items/${itemId}/manual`, {
      results: [{ number: '1', status: 'passed' }],
      done: true,
    });
    expect((await ok<{ status: string }>('GET', `/api/runs/${run.id}`)).status).toBe('passed');
  });

  it('a campaign runs a phone app once per environment (one per device), not per browser and screen size', async () => {
    const phone = await ok('POST', `/api/applications/${appId}/environments`, {
      name: 'Second phone',
      baseUrl: 'app://careclinic',
      browserDefaults: { android: { app: APK, udid: 'R58N12ABCDE' } },
    });
    const c = await ok<{ id: string }>('POST', `/api/applications/${appId}/campaigns`, {
      name: 'Devices',
      environmentIds: [envId, phone.id],
      browsers: ['chromium', 'firefox'],
      viewports: ['desktop', 'mobile'],
    });
    const got = await ok<{ matrix: { environmentId: string }[] }>('GET', `/api/campaigns/${c.id}`);
    expect(got.matrix.map((m) => m.environmentId)).toEqual([envId, phone.id]);
  });

  it("exports to Appium and Maestro with the environment's launch settings, never a secret value", async () => {
    await ok('PUT', `/api/environments/${envId}/secrets`, { key: 'nursePassword', value: 'N0t-In-Exports' });
    const s = await ok('POST', `/api/modules/${moduleId}/scenarios`, { name: 'Sign in (export)' });
    await ok('PUT', `/api/scenarios/${s.id}/steps`, {
      steps: [
        {
          type: 'ui.fill',
          params: { value: '{{secret.nursePassword}}' },
          locators: [{ strategy: 'testId', value: 'password' }],
        },
        { type: 'ui.swipe', params: { direction: 'up' } },
      ],
    });
    const scope = { type: 'scenarios', ids: [s.id] };
    const py = await ok<{ files: { path: string; content?: string }[]; run: string }>(
      'POST',
      `/api/applications/${appId}/codegen/preview`,
      { target: 'appium-py', environmentId: envId, scope },
    );
    const config = py.files.find((f) => f.path === 'support/config.py')!.content!;
    // The app file comes from {{env.apk}}: the environment variable, read at run time.
    expect(config).toContain('"appium:app": env["apk"]');
    expect(config).toContain('"appium:automationName": "UiAutomator2"');
    const test = py.files.find((f) => f.path.endsWith('test_sign_in_export.py'))!.content!;
    expect(test).toContain(
      'app.fill([("id", "password"), ("accessibility id", "password")], secret("NURSE_PASSWORD"))',
    );
    expect(test).toContain('app.swipe("up", 0.75)');
    const maestro = await ok<{ files: { path: string; content?: string }[] }>(
      'POST',
      `/api/applications/${appId}/codegen/preview`,
      { target: 'maestro', environmentId: envId, scope },
    );
    expect(maestro.files.map((f) => f.path)).toContain('flows/patients-sign-in-export.yaml');
    for (const f of [...py.files, ...maestro.files])
      expect(f.content ?? '', f.path).not.toContain('N0t-In-Exports');
  });

  it('reports what this computer has for Android testing', async () => {
    type Checks = { ready: boolean; checks: { name: string; ok: boolean; fix?: string }[] };
    const status = await ok<{ android: Checks; ios: Checks & { supported: boolean } }>(
      'GET',
      '/api/native/status',
    );
    expect(status.android.checks.map((c) => c.name)).toEqual(
      expect.arrayContaining(['Java 17 or newer', 'Android SDK', 'Appium and the Android driver']),
    );
    expect(status.android.checks.every((c) => c.ok || c.fix)).toBe(true);
    expect(status.ios.supported).toBe(process.platform === 'darwin');
    expect(status.ios.checks.every((c) => c.ok || c.fix)).toBe(true);
  });

  it.skipIf(!AVD)(
    'runs a test in the app on the emulator; the planted bug fails with the text it showed',
    async () => {
      const s = await ok('POST', `/api/modules/${moduleId}/scenarios`, {
        name: 'Add a patient with a long name',
        steps: [
          {
            type: 'ui.fill',
            params: { value: 'nurse@careclinic.test' },
            locators: [{ strategy: 'placeholder', value: 'Email' }],
          },
          {
            type: 'ui.fill',
            params: { value: 'CareClinic1' },
            locators: [{ strategy: 'testId', value: 'password' }],
          },
          { type: 'ui.click', locators: [{ strategy: 'text', value: 'Sign in' }] },
          {
            type: 'ui.fill',
            params: { value: 'Alexandra Johnson' },
            locators: [{ strategy: 'placeholder', value: 'Patient name' }],
          },
          { type: 'ui.click', locators: [{ strategy: 'testId', value: 'add_patient' }] },
          {
            type: 'ui.assert',
            params: { check: 'text', expected: '1 patient' },
            locators: [{ strategy: 'testId', value: 'patient_count' }],
          },
          {
            type: 'ui.assert',
            params: { check: 'text', expected: 'Alexandra Johnson' },
            locators: [
              {
                strategy: 'xpath',
                value: "//*[contains(@resource-id,'patient_list')]/android.widget.TextView[1]",
              },
            ],
            timeoutMs: 5000,
          },
        ],
      });
      const r = await ok<{ id: string }>('POST', '/api/runs', {
        applicationId: appId,
        environmentId: envId,
        scope: { type: 'scenarios', ids: [s.id] },
        options: { video: 'always' },
      });
      await ctx.runs.idle();
      const run = await ok<{
        status: string;
        items: { id: string; errorMessage: string | null; videoPath?: string | null }[];
      }>('GET', `/api/runs/${r.id}`);
      expect(run.status).toBe('failed');
      expect(run.items[0]!.errorMessage).toContain('but got "Alexandra Jo"');
      const item = await ok<{ steps: { status: string }[]; artifacts?: { kind: string; path: string }[] }>(
        'GET',
        `/api/run-items/${run.items[0]!.id}`,
      );
      expect(item.steps.filter((x) => x.status === 'passed')).toHaveLength(6);
      expect(JSON.stringify(item)).toContain('video.mp4');
    },
    600_000,
  );

  it.skipIf(!AVD)(
    'records the app from its screen: taps, typing (a password becomes a secret), a check; then saves the scenario',
    async () => {
      // The previous test's recorder refusal does not apply any more: phone apps can be recorded.
      const started = await call('POST', '/api/recorder/start', {
        applicationId: appId,
        environmentId: envId,
        moduleId,
      });
      expect(started.statusCode, started.body).toBe(201);
      expect(started.json().native).toEqual({ platform: 'Android' });
      const screen = await call('GET', '/api/recorder/screen');
      expect(screen.headers['content-type']).toBe('image/png');
      expect(String(screen.headers['x-screen-size'])).toMatch(/^\d+x\d+$/);
      const s = ctx.recorder.native();
      const at = async (locator: { strategy: 'testId' | 'placeholder' | 'text'; value: string }) => {
        // As a person would, wait for the screen to show it (a new screen takes a moment).
        for (let i = 0; i < 40; i++) {
          const p = await s.pointOf([locator]);
          if (p) return p;
          await new Promise((r) => setTimeout(r, 250));
        }
        throw new Error(`Not on screen: ${locator.strategy}=${locator.value}`);
      };
      const act = (body: Record<string, unknown>) => ok('POST', '/api/recorder/act', body);
      await act({ action: 'tap', ...(await at({ strategy: 'testId', value: 'email' })) });
      await act({ action: 'type', text: 'nurse@careclinic.test' });
      await act({ action: 'tap', ...(await at({ strategy: 'testId', value: 'password' })) });
      await act({ action: 'type', text: 'CareClinic1' });
      await act({ action: 'tap', ...(await at({ strategy: 'testId', value: 'sign_in' })) });
      await act({
        action: 'check',
        check: 'text',
        ...(await at({ strategy: 'testId', value: 'patient_count' })),
      });
      const nothing = await call('POST', '/api/recorder/act', { action: 'type', text: 'x' });
      expect(nothing.statusCode).toBe(422);
      const stopped = await ok<{
        state: string;
        steps: {
          type: string;
          params: Record<string, unknown>;
          locators: { strategy: string; value: string }[];
        }[];
        secretKeys: string[];
      }>('POST', '/api/recorder/stop');
      expect(stopped.state).toBe('stopped');
      expect(stopped.steps.map((x) => x.type)).toEqual(['ui.fill', 'ui.fill', 'ui.click', 'ui.assert']);
      expect(stopped.steps[0]!.locators[0]).toMatchObject({ strategy: 'testId', value: 'email' });
      expect(stopped.steps[1]!.params.value).toBe('{{secret.password}}');
      expect(stopped.secretKeys).toEqual(['password']);
      expect(stopped.steps[3]!.params).toEqual({ check: 'text', expected: 'No patients yet' });
      const saved = await ok<{ scenario: { id: string } }>('POST', '/api/recorder/save', {
        moduleId,
        name: 'Recorded sign-in',
      });
      // The recorded scenario replays.
      const r = await ok<{ id: string }>('POST', '/api/runs', {
        applicationId: appId,
        environmentId: envId,
        scope: { type: 'scenarios', ids: [saved.scenario.id] },
        options: { video: 'off' },
      });
      await ctx.runs.idle();
      const run = await ok<{ status: string; items: { errorMessage: string | null }[] }>(
        'GET',
        `/api/runs/${r.id}`,
      );
      expect(run.items[0]!.errorMessage ?? null).toBeNull();
      expect(run.status).toBe('passed');
    },
    1_200_000,
  );
  it.skipIf(!AVD)(
    'a manual test opens the app: its screen in the dashboard, a tap and typing, a screenshot and a clip from it',
    async () => {
      const s = await ok('POST', `/api/modules/${moduleId}/scenarios`, {
        name: 'Sign in by hand',
        execution: 'manual',
        steps: [
          {
            type: 'util.manual',
            params: { instruction: 'Type your email', expected: 'It shows in the field' },
          },
          { type: 'util.manual', params: { instruction: 'Sign in', expected: 'The patient list opens' } },
        ],
      });
      const run = await ok<{ id: string }>('POST', '/api/runs', {
        applicationId: appId,
        environmentId: envId,
        mode: 'manual',
        scope: { type: 'scenarios', ids: [s.id] },
      });
      const itemId = (await ok<{ items: { id: string }[] }>('GET', `/api/runs/${run.id}`)).items[0]!.id;
      await ok('POST', `/api/run-items/${itemId}/manual/browser`);
      const check = () =>
        ok<{
          app: { platform: string; recording: boolean } | null;
          results: { number: string; status: string; screenshots: string[]; clips: unknown[] }[];
          videos: string[];
          item: { status: string };
        }>('GET', `/api/run-items/${itemId}/manual`);
      expect((await check()).app).toMatchObject({ platform: 'Android', recording: true });
      const screen = await call('GET', `/api/run-items/${itemId}/manual/screen`);
      expect(screen.headers['content-type']).toBe('image/png');
      // Tap the email field where the element tree says it is (as a tester clicks its picture), then type.
      const field = await waitForField(ctx, itemId);
      await ok('POST', `/api/run-items/${itemId}/manual/act`, { action: 'tap', ...field });
      await ok('POST', `/api/run-items/${itemId}/manual/panel`, { type: 'clipStart', number: '1' });
      await ok('POST', `/api/run-items/${itemId}/manual/act`, {
        action: 'type',
        text: 'nurse@careclinic.test',
      });
      await new Promise((r) => setTimeout(r, 1500));
      await ok('POST', `/api/run-items/${itemId}/manual/panel`, { type: 'clipStop', number: '1' });
      await ok('POST', `/api/run-items/${itemId}/manual/panel`, { type: 'screenshot', number: '1' });
      await ok('POST', `/api/run-items/${itemId}/manual/panel`, {
        type: 'mark',
        number: '1',
        status: 'passed',
      });
      await ok('POST', `/api/run-items/${itemId}/manual/panel`, {
        type: 'mark',
        number: '2',
        status: 'passed',
      });
      const one = (await check()).results.find((r) => r.number === '1')!;
      expect(one.screenshots).toHaveLength(1);
      expect(one.clips).toHaveLength(1);
      if (process.env.STEPFORGE_SHOTS)
        copyFileSync(
          join(ctx.config.artifactsDir, one.screenshots[0]!),
          `${process.env.STEPFORGE_SHOTS}/android-manual-screenshot.png`,
        );
      await ok('PUT', `/api/run-items/${itemId}/manual`, { done: true });
      // Finishing closes the app; its screen recording is kept as the test's video.
      await expect.poll(async () => (await check()).videos.length, { timeout: 120_000 }).toBe(1);
      expect((await check()).item.status).toBe('passed');
    },
    900_000,
  );
});

/** Where the email field is on the app's screen, as fractions of its picture (waiting for the app to show it). */
async function waitForField(c: AppContext, itemId: string): Promise<{ x: number; y: number }> {
  const session = (
    c.manualBrowser as unknown as { sessions: Map<string, { native: NativeManualSession }> }
  ).sessions.get(itemId)!.native;
  for (let i = 0; i < 120; i++) {
    const { area } = await session.platform.view(session.driver);
    const field = parseElements(await session.driver.source()).find((e) =>
      /email/i.test(
        `${e.attrs['resource-id'] ?? ''} ${e.attrs.name ?? ''} ${e.attrs.hint ?? ''} ${e.attrs.placeholderValue ?? ''}`,
      ),
    );
    if (field)
      return {
        x: (field.rect.x + field.rect.width / 2 - area.x) / area.width,
        y: (field.rect.y + field.rect.height / 2 - area.y) / area.height,
      };
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('The email field did not show');
}
