import { createClinicApp } from '@stepforge/demo-clinic';
import * as repo from '@stepforge/db/repos';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AppContext } from '../src/context.ts';
import { H, testServer } from './helpers.ts';

/** The element repository: saved elements shared by steps — fix a locator once, every step follows. */
let app: FastifyInstance;
let ctx: AppContext;
let clinic: ReturnType<typeof createClinicApp>;
let clinicUrl = '';
let appId = '';
let envId = '';
let moduleId = '';

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
): Promise<T> {
  const res = await call(method, url, payload);
  if (res.statusCode >= 300) throw new Error(`${method} ${url} → ${res.statusCode}: ${res.body}`);
  return (res.body ? res.json() : undefined) as T;
}
type Item = { id: string; status: string; errorMessage: string | null; labelJson: { scenario: string } };
async function run(ids: string[]) {
  await fetch(`${clinicUrl}/api/reset`, { method: 'POST' });
  const r = await ok<{ id: string }>('POST', '/api/runs', {
    applicationId: appId,
    environmentId: envId,
    scope: { type: 'scenarios', ids },
    options: { video: 'off', trace: 'off' },
  });
  await ctx.runs.idle();
  return ok<{ id: string; items: Item[] }>('GET', `/api/runs/${r.id}`);
}

const ref = (id: string) => [{ strategy: 'element', value: id }];
const signIn = [
  { type: 'ui.navigate', params: { url: '/login' } },
  {
    type: 'ui.fill',
    params: { value: 'reception@careclinic.test' },
    locators: [{ strategy: 'label', value: 'Email' }],
  },
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
  appId = (await ok('POST', '/api/applications', { name: 'CareClinic', slug: 'careclinic-el' })).id;
  envId = (await ok('POST', `/api/applications/${appId}/environments`, { name: 'Local', baseUrl: clinicUrl }))
    .id;
  await ok('PUT', `/api/environments/${envId}/secrets`, { key: 'password', value: 'Reception123!' });
  moduleId = (await ok('POST', `/api/applications/${appId}/modules`, { name: 'Patients' })).id;
}, 30_000);
afterAll(async () => {
  await app.close();
  await clinic.close();
});

describe('element repository', () => {
  it('validates elements: unique names, at least one locator, no element inside an element', async () => {
    const e = await ok<{ id: string }>('POST', `/api/applications/${appId}/elements`, {
      name: 'Email field',
      page: 'Login',
      locators: [{ strategy: 'label', value: 'Email' }],
    });
    expect(
      (
        await call('POST', `/api/applications/${appId}/elements`, {
          name: 'Email field',
          locators: [{ strategy: 'css', value: '#e' }],
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (await call('POST', `/api/applications/${appId}/elements`, { name: 'Nothing', locators: [] }))
        .statusCode,
    ).toBe(400);
    expect(
      (await call('POST', `/api/applications/${appId}/elements`, { name: 'Loop', locators: ref(e.id) }))
        .statusCode,
    ).toBe(400);
    expect((await call('PATCH', `/api/elements/${e.id}`, { name: '' })).statusCode).toBe(400);
  });

  it('fixes a changed locator once in the element, and every scenario using it passes again', async () => {
    // Saved when the button had another test id and label.
    const save = await ok<{ id: string }>('POST', `/api/applications/${appId}/elements`, {
      name: 'Save patient button',
      page: 'New patient',
      locators: [
        { strategy: 'testId', value: 'store-patient-btn' },
        { strategy: 'role', value: 'button', name: 'Store patient' },
      ],
    });
    const block = await ok<{ id: string }>('POST', `/api/applications/${appId}/blocks`, {
      name: 'Press save',
      steps: [{ type: 'ui.click', timeoutMs: 2000, locators: ref(save.id) }],
    });
    const a = await ok<{ id: string }>('POST', `/api/modules/${moduleId}/scenarios`, {
      name: 'Saves through the element',
      steps: [
        ...signIn,
        { type: 'ui.navigate', params: { url: '/patients/new' } },
        { type: 'ui.click', timeoutMs: 2000, locators: ref(save.id) },
      ],
    });
    const b = await ok<{ id: string }>('POST', `/api/modules/${moduleId}/scenarios`, {
      name: 'Saves through a block',
      steps: [
        ...signIn,
        { type: 'ui.navigate', params: { url: '/patients/new' } },
        { type: 'util.useBlock', params: { blockId: block.id } },
      ],
    });

    const usage = await ok<{
      scenarios: { name: string; steps: number }[];
      blocks: { name: string }[];
      steps: number;
    }>('GET', `/api/elements/${save.id}/usage`);
    expect(usage.scenarios).toEqual([
      expect.objectContaining({ name: 'Saves through the element', steps: 1 }),
    ]);
    expect(usage.blocks).toEqual([expect.objectContaining({ name: 'Press save' })]);
    expect(usage.steps).toBe(2);
    const list = await ok<{ name: string; usedBy: number; usedBySteps: number }[]>(
      'GET',
      `/api/applications/${appId}/elements`,
    );
    expect(list.find((x) => x.name === 'Save patient button')).toMatchObject({ usedBy: 2, usedBySteps: 2 });

    const r = await run([a.id, b.id]);
    expect(r.items.map((i) => i.status)).toEqual(['failed', 'failed']);
    const item = r.items.find((i) => i.labelJson.scenario === 'Saves through the element')!;
    const detail = await ok<{
      diagnosisJson: { category: string; suggestedLocator: unknown };
      failedStepId: string;
    }>('GET', `/api/run-items/${item.id}`);
    expect(detail.diagnosisJson.category).toBe('locator_changed');
    expect(detail.diagnosisJson.suggestedLocator).toEqual({ strategy: 'testId', value: 'save-patient' });
    const failed = { stepId: detail.failedStepId };
    const owner = await ok<{ kind: string; element: { name: string; steps: number } }>(
      'GET',
      `/api/run-items/${item.id}/step-owner?stepId=${encodeURIComponent(failed.stepId)}`,
    );
    expect(owner.element).toMatchObject({ name: 'Save patient button', steps: 2 });

    const fixed = await ok<{ element: { locatorsJson: unknown[] } }>(
      'POST',
      `/api/run-items/${item.id}/accept-locator`,
      {
        stepId: failed.stepId,
        locator: detail.diagnosisJson.suggestedLocator,
      },
    );
    expect(fixed.element.locatorsJson[0]).toEqual({ strategy: 'testId', value: 'save-patient' });
    expect(fixed.element.locatorsJson).toHaveLength(3); // the old ones stay as fallbacks
    // The scenario itself still points at the element (nothing was copied into it).
    expect(
      (await ok<{ steps: { locators: unknown[] }[] }>('GET', `/api/scenarios/${a.id}`)).steps.at(-1)!
        .locators,
    ).toEqual(ref(save.id));

    const again = await run([a.id, b.id]);
    expect(again.items.map((i) => i.status)).toEqual(['passed', 'passed']);

    // Exported code uses the element's real locators.
    const preview = await ok<{ files: { path: string; content?: string }[] }>(
      'POST',
      `/api/applications/${appId}/codegen/preview`,
      { target: 'playwright-ts', scope: { type: 'scenarios', ids: [a.id] } },
    );
    const spec = preview.files.find((f) => f.path.endsWith('saves-through-the-element.spec.ts'))!.content!;
    expect(spec).toContain("getByTestId('save-patient')");
    expect(spec).not.toMatch(/strategy.*element|element=/); // no unexpanded references
  }, 120_000);

  it('a step whose element was deleted stops with a clear message', async () => {
    const tmp = await ok<{ id: string }>('POST', `/api/applications/${appId}/elements`, {
      name: 'Temporary',
      locators: [{ strategy: 'css', value: 'body' }],
    });
    const s = await ok<{ id: string }>('POST', `/api/modules/${moduleId}/scenarios`, {
      name: 'Uses a deleted element',
      steps: [
        { type: 'ui.navigate', params: { url: '/login' } },
        { type: 'ui.click', locators: ref(tmp.id) },
      ],
    });
    await ok('DELETE', `/api/elements/${tmp.id}`);
    const r = await run([s.id]);
    expect(r.items[0]!.status).toBe('broken');
    expect(r.items[0]!.errorMessage).toMatch(/saved element this step uses was deleted/);
  }, 60_000);

  it('links recorded steps to saved elements whose best locator matches', () => {
    const email = repo.listElements(ctx.db, appId).find((e) => e.name === 'Email field')!;
    const linked = repo.linkKnownElements(ctx.db, appId, [
      {
        type: 'ui.fill',
        params: { value: 'x' },
        locators: [
          { strategy: 'label', value: 'Email' },
          { strategy: 'css', value: '#email' },
        ],
      },
      { type: 'ui.click', locators: [{ strategy: 'label', value: 'Password' }] },
      {
        type: 'util.if',
        params: { steps: [{ type: 'ui.fill', locators: [{ strategy: 'label', value: 'Email' }] }] },
      },
    ]);
    expect(linked[0]!.locators).toEqual(ref(email.id));
    expect(linked[1]!.locators).toEqual([{ strategy: 'label', value: 'Password' }]);
    expect((linked[2]!.params!.steps as { locators: unknown }[])[0]!.locators).toEqual(ref(email.id));
  });

  it('exports and imports elements (steps point at the new copies) and block inputs', async () => {
    const exported = await ok<
      Record<string, unknown> & { elements: { name: string }[]; blocks: { inputs: unknown[] }[] }
    >('GET', `/api/applications/${appId}/export`);
    expect(exported.elements.map((e) => e.name)).toEqual(
      expect.arrayContaining(['Email field', 'Save patient button']),
    );
    await ok('POST', `/api/applications/${appId}/blocks`, {
      name: 'With input',
      inputs: [{ name: 'who', default: 'Ana' }],
    });
    const again = await ok<Record<string, unknown>>('GET', `/api/applications/${appId}/export`);
    const imported = await ok<{ applicationId: string; counts: { elements: number } }>(
      'POST',
      '/api/applications/import?slug=careclinic-el-copy',
      again,
    );
    expect(imported.counts.elements).toBe(2);
    const newElements = repo.listElements(ctx.db, imported.applicationId);
    const saveCopy = newElements.find((e) => e.name === 'Save patient button')!;
    expect(saveCopy.usedBy).toBe(2); // the copied scenario and block point at the copy, not the original
    expect(
      repo.listBlocks(ctx.db, imported.applicationId).find((b) => b.name === 'With input')!.inputsJson,
    ).toEqual([{ name: 'who', default: 'Ana' }]);
  });
});
