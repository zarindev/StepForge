import { expect, test, type Page } from '@playwright/test';

const CLINIC = 'http://127.0.0.1:8191';
const shots = process.env.STEPFORGE_SHOTS;
const shot = async (page: Page, name: string) => {
  if (shots) await page.screenshot({ path: `${shots}/${name}.png` });
};

async function sfApi<T>(page: Page, method: string, url: string, body?: unknown): Promise<T> {
  return page.evaluate(
    async ([m, u, b]) => {
      const res = await fetch(u as string, {
        method: m as string,
        headers: {
          'x-stepforge-token': (globalThis as unknown as { __STEPFORGE__: { token: string } }).__STEPFORGE__
            .token,
          'content-type': 'application/json',
        },
        body: b ? JSON.stringify(b) : undefined,
      });
      if (!res.ok) throw new Error(`${m} ${u} → ${res.status} ${await res.text()}`);
      return res.status === 204 ? null : res.json();
    },
    [method, url, body] as const,
  ) as Promise<T>;
}

/** Waits for a run and returns its item statuses in order. */
async function runAndWait(page: Page, body: unknown) {
  const run = await sfApi<{ id: string }>(page, 'POST', '/api/runs', body);
  for (;;) {
    const r = await sfApi<{ status: string; items: { status: string }[] }>(
      page,
      'GET',
      `/api/runs/${run.id}`,
    );
    if (!['queued', 'running'].includes(r.status))
      return { id: run.id, statuses: r.items.map((i) => i.status) };
    await page.waitForTimeout(500);
  }
}

test('elements: save a step’s locators as an element, reuse it, and fix it once for every step', async ({
  page,
  request,
}) => {
  test.setTimeout(150_000);
  await request.post(`${CLINIC}/api/reset`);
  await page.goto('/');
  const app = await sfApi<{ id: string }>(page, 'POST', '/api/applications', {
    name: 'Clinic Elements',
    slug: `clinic-elements-${Date.now().toString(36)}`, // unique: a CI retry must not collide
  });
  const env = await sfApi<{ id: string }>(page, 'POST', `/api/applications/${app.id}/environments`, {
    name: 'Local',
    baseUrl: CLINIC,
  });
  await sfApi(page, 'PUT', `/api/environments/${env.id}/secrets`, {
    key: 'password',
    value: 'Reception123!',
  });
  const mod = await sfApi<{ id: string }>(page, 'POST', `/api/applications/${app.id}/modules`, {
    name: 'Patients',
  });
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
    { type: 'ui.navigate', params: { url: '/patients/new' } },
  ];
  // Recorded when the save button had another test id and label: it fails today.
  const a = await sfApi<{ id: string }>(page, 'POST', `/api/modules/${mod.id}/scenarios`, {
    name: 'Save from the form',
    steps: [
      ...signIn,
      {
        type: 'ui.click',
        label: 'Press save',
        timeoutMs: 2000,
        locators: [
          { strategy: 'testId', value: 'store-patient-btn' },
          { strategy: 'role', value: 'button', name: 'Store patient' },
        ],
      },
    ],
  });
  await page.evaluate((id) => localStorage.setItem('stepforge.currentApp', id), app.id);

  // The step's locators become a saved element.
  await page.goto(`/explorer?scenario=${a.id}`);
  await page.getByRole('button', { name: /^Press save/ }).click();
  await page.getByRole('button', { name: 'Save as element' }).click();
  const dialog = page.getByRole('dialog', { name: 'Save as element' });
  await dialog.getByLabel('Element name').fill('Save patient button');
  await dialog.getByLabel('Element page').fill('New patient');
  await dialog.getByRole('button', { name: 'Save element' }).click();
  await expect(page.getByTestId('element-info')).toContainText('Save patient button');
  await page.getByRole('button', { name: 'Save steps' }).click();
  await expect(page.getByText(/Saved steps · v2/)).toBeVisible();

  // A second scenario uses the same element.
  const elements = await sfApi<{ id: string; name: string }[]>(
    page,
    'GET',
    `/api/applications/${app.id}/elements`,
  );
  const save = elements.find((e) => e.name === 'Save patient button')!;
  const b = await sfApi<{ id: string }>(page, 'POST', `/api/modules/${mod.id}/scenarios`, {
    name: 'Save again',
    steps: [
      ...signIn,
      { type: 'ui.click', timeoutMs: 2000, locators: [{ strategy: 'element', value: save.id }] },
    ],
  });
  await page.goto(`/applications/${app.id}?tab=elements&element=${save.id}`);
  await expect(page.getByTestId('element-affected')).toHaveText(
    'Used by 2 steps — a change here applies to all of them',
  );
  await shot(page, 'elements-tab');

  // Both fail; one fix in the element repairs both.
  await request.post(`${CLINIC}/api/reset`);
  const first = await runAndWait(page, {
    applicationId: app.id,
    environmentId: env.id,
    scope: { type: 'scenarios', ids: [a.id, b.id] },
  });
  expect(first.statuses).toEqual(['failed', 'failed']);
  await page.goto(`/runs/${first.id}`);
  await page.getByText('Save from the form', { exact: true }).first().click();
  await expect(page.getByTestId('failed-element')).toContainText('Uses saved element Save patient button');
  await expect(page.getByTestId('failed-element')).toContainText('used by 2 steps');
  await page
    .getByRole('button', { name: /^Fix element "Save patient button": use testId=save-patient/ })
    .click();
  await expect(
    page.getByText(/Element "Save patient button" updated to use testId=save-patient — that fixes 2 steps/),
  ).toBeVisible();

  await request.post(`${CLINIC}/api/reset`);
  const again = await runAndWait(page, {
    applicationId: app.id,
    environmentId: env.id,
    scope: { type: 'scenarios', ids: [a.id, b.id] },
  });
  expect(again.statuses).toEqual(['passed', 'passed']);
});
