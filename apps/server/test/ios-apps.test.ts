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

  it('the recorder and the manual-test panel explain they are not available for iOS apps yet', async () => {
    const rec = await call('POST', '/api/recorder/start', { applicationId: appId, environmentId: envId });
    expect(rec.statusCode).toBe(400);
    expect(rec.json().message).toContain('Recording iOS apps');
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
            timeoutMs: 2000,
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
});
