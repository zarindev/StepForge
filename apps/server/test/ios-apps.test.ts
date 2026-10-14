import type { FastifyInstance } from 'fastify';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildIosDemo, IOS_DEMO_APP } from '../../../scripts/build-ios-demo.ts';
import type { AppContext } from '../src/context.ts';
import { H, testServer } from './helpers.ts';

/** iOS apps: environments say which app and simulator; UI steps run through a local Appium server (XCUITest). */
let app: FastifyInstance;
let ctx: AppContext;
let appId = '';
let envId = '';
let moduleId = '';
const TOOLS = fileURLToPath(new URL('../../../data/tools', import.meta.url));
const SIM = process.env.STEPFORGE_TEST_IOS;

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
  if (SIM && !existsSync(IOS_DEMO_APP)) buildIosDemo(() => {});
  ({ app, ctx } = await testServer({ toolsDir: TOOLS }));
  appId = (
    await ok('POST', '/api/applications', { name: 'CareClinic iOS', slug: 'careclinic-ios', platform: 'ios' })
  ).id;
  envId = (
    await ok('POST', `/api/applications/${appId}/environments`, {
      name: 'Simulator',
      baseUrl: 'app://careclinic',
      variables: { app: IOS_DEMO_APP },
      browserDefaults: { ios: { app: '{{env.app}}', ...(SIM && SIM !== '1' && { simulator: SIM }) } },
    })
  ).id;
  moduleId = (await ok('POST', `/api/applications/${appId}/modules`, { name: 'Patients' })).id;
});
afterAll(async () => {
  await app.close();
});

describe('iOS apps', () => {
  it('an environment needs the app or a bundle id; the platform is exported and imported', async () => {
    const bad = await call('POST', `/api/applications/${appId}/environments`, {
      name: 'Broken',
      baseUrl: 'app://x',
      browserDefaults: { ios: { simulator: 'iPhone 17' } },
    });
    expect(bad.statusCode).toBe(400);
    const exported = await ok<Record<string, unknown>>('GET', `/api/applications/${appId}/export`);
    const imported = await ok<{ applicationId: string }>(
      'POST',
      '/api/applications/import?slug=ios-copy',
      exported,
    );
    expect(
      (await ok<{ platform: string }>('GET', `/api/applications/${imported.applicationId}`)).platform,
    ).toBe('ios');
  });

  it('the manual-test panel explains it is not available for iOS apps yet', async () => {
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
    const open = await call('POST', `/api/run-items/${itemId}/manual/browser`);
    expect(open.statusCode).toBe(400);
    expect(open.json().message).toContain('an iOS app');
    await ok('PUT', `/api/run-items/${itemId}/manual`, {
      results: [{ number: '1', status: 'passed' }],
      done: true,
    });
    expect((await ok<{ status: string }>('GET', `/api/runs/${run.id}`)).status).toBe('passed');
  });

  it.skipIf(!SIM)(
    'runs a test in the app on the simulator; the planted bug fails with the text it showed',
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
            locators: [{ strategy: 'text', value: 'Alexandra' }],
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
      const run = await ok<{ status: string; items: { id: string; errorMessage: string | null }[] }>(
        'GET',
        `/api/runs/${r.id}`,
      );
      expect(run.status).toBe('failed');
      expect(run.items[0]!.errorMessage).toContain('but got "Alexandra Jo"');
      const item = await ok<{ steps: { status: string }[] }>('GET', `/api/run-items/${run.items[0]!.id}`);
      expect(item.steps.filter((x) => x.status === 'passed')).toHaveLength(6);
      expect(JSON.stringify(item)).toContain('video.mp4');
    },
    1_200_000,
  );

  it.skipIf(!SIM)(
    'records the app from its screen: taps, typing (a password becomes a secret), a check; then saves the scenario',
    async () => {
      // The previous test's recorder refusal does not apply any more: phone apps can be recorded.
      const started = await call('POST', '/api/recorder/start', {
        applicationId: appId,
        environmentId: envId,
        moduleId,
      });
      expect(started.statusCode, started.body).toBe(201);
      expect(started.json().native).toEqual({ platform: 'iOS' });
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
});
