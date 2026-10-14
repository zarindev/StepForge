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

test('blocks: make blocks from steps, reuse them, and fix a shared failure once', async ({
  page,
  request,
}) => {
  test.setTimeout(150_000);
  await request.post(`${CLINIC}/api/reset`);
  await page.goto('/');
  const app = await sfApi<{ id: string }>(page, 'POST', '/api/applications', {
    name: 'Clinic Blocks',
    slug: `clinic-blocks-${Date.now().toString(36)}`, // unique: a CI retry must not collide
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
  // Recorded when the save button had another test id and label: it fails today.
  const a = await sfApi<{ id: string }>(page, 'POST', `/api/modules/${mod.id}/scenarios`, {
    name: 'Reception saves a patient',
    steps: [
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
      {
        type: 'ui.click',
        timeoutMs: 2000,
        locators: [
          { strategy: 'testId', value: 'store-patient-btn' },
          { strategy: 'role', value: 'button', name: 'Store patient' },
        ],
      },
    ],
  });
  await page.evaluate((id) => localStorage.setItem('stepforge.currentApp', id), app.id);

  // Select steps 1–4 → Make a block "Sign in"; then steps 2–3 (now the save part) → "Save the patient form".
  await page.goto(`/explorer?scenario=${a.id}`);
  for (const n of [1, 2, 3, 4]) await page.getByLabel(`Select step ${n}`).check();
  await page.getByRole('button', { name: 'Make a block from 4 steps' }).click();
  await page.getByRole('dialog', { name: 'Make a block' }).getByLabel('Block name').fill('Sign in');
  await page.getByRole('button', { name: 'Make block' }).click();
  await expect(page.getByText(/Block "Sign in" created; this scenario now uses it/)).toBeVisible();
  const steps = page.getByRole('list', { name: 'Steps' }).first();
  await expect(steps.getByRole('listitem')).toHaveCount(3);
  for (const n of [2, 3]) await page.getByLabel(`Select step ${n}`).check();
  await page.getByRole('button', { name: 'Make a block from 2 steps' }).click();
  await page
    .getByRole('dialog', { name: 'Make a block' })
    .getByLabel('Block name')
    .fill('Save the patient form');
  await page.getByRole('button', { name: 'Make block' }).click();
  await expect(steps.getByRole('listitem')).toHaveCount(2);
  await shot(page, 'blocks-made');

  // A second scenario reuses both blocks.
  const blocks = await sfApi<{ id: string; name: string }[]>(
    page,
    'GET',
    `/api/applications/${app.id}/blocks`,
  );
  const id = (n: string) => blocks.find((b) => b.name === n)!.id;
  const b = await sfApi<{ id: string }>(page, 'POST', `/api/modules/${mod.id}/scenarios`, {
    name: 'Reception saves another patient',
    steps: [
      { type: 'util.useBlock', params: { blockId: id('Sign in') } },
      { type: 'util.useBlock', params: { blockId: id('Save the patient form') } },
    ],
  });

  // Blocks tab: usage and an input with a default (used as {{vars.email}} by nobody yet, but shown on each use).
  await page.goto(`/applications/${app.id}?tab=blocks&block=${id('Save the patient form')}`);
  await expect(page.getByTestId('block-affected')).toHaveText('A change here affects 2 scenarios');
  await page.getByRole('button', { name: /^Sign in \d+ used by 2$/ }).click();
  await page.getByRole('button', { name: 'Add input' }).click();
  await page.getByLabel('Input 1 name').fill('email');
  await page.getByLabel('Input 1 default').fill('reception@careclinic.test');
  await page.getByRole('button', { name: 'Save inputs' }).click();
  await expect(page.getByText('Inputs saved')).toBeVisible();
  await page.goto(`/explorer?scenario=${b.id}`);
  await page.getByRole('button', { name: /^Use block "Sign in"/ }).click(); // unlabeled steps show the block's name
  await expect(page.getByLabel('Input email')).toHaveAttribute('placeholder', 'reception@careclinic.test');
  await expect(page.getByTestId('block-usage-hint')).toContainText('Used by 2');

  // Both fail at the same block step: the run says so, and one fix in the block repairs both.
  await request.post(`${CLINIC}/api/reset`);
  const first = await runAndWait(page, {
    applicationId: app.id,
    environmentId: env.id,
    scope: { type: 'scenarios', ids: [a.id, b.id] },
  });
  expect(first.statuses).toEqual(['failed', 'failed']);
  await page.goto(`/runs/${first.id}`);
  const banner = page.getByLabel('Failures inside blocks');
  await expect(banner).toContainText('2 failed tests stop at step 2 of block Save the patient form');
  await expect(banner).toContainText('used by 2 scenarios');
  await banner.getByRole('button', { name: 'Show the failure' }).click();
  await expect(page.getByTestId('failed-in-block')).toContainText('Inside block Save the patient form');
  await shot(page, 'blocks-failure');
  await page
    .getByRole('button', { name: /^Fix block "Save the patient form": use testId=save-patient/ })
    .click();
  await expect(page.getByText(/updated to use testId=save-patient — that fixes 2 scenarios/)).toBeVisible();

  await request.post(`${CLINIC}/api/reset`);
  const again = await runAndWait(page, {
    applicationId: app.id,
    environmentId: env.id,
    scope: { type: 'scenarios', ids: [a.id, b.id] },
  });
  expect(again.statuses).toEqual(['passed', 'passed']);
});
