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

test('hooks: a module’s before/after-each-test blocks run around its tests, also after a failure', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.goto('/');
  const app = await sfApi<{ id: string }>(page, 'POST', '/api/applications', {
    name: 'Clinic Hooks',
    slug: `clinic-hooks-${Date.now().toString(36)}`, // unique: a CI retry must not collide
  });
  const env = await sfApi<{ id: string }>(page, 'POST', `/api/applications/${app.id}/environments`, {
    name: 'Local',
    baseUrl: CLINIC,
  });
  const mod = await sfApi<{ id: string }>(page, 'POST', `/api/applications/${app.id}/modules`, {
    name: 'Patients',
  });
  for (const name of ['Sign in', 'Sign out'])
    await sfApi(page, 'POST', `/api/applications/${app.id}/blocks`, {
      name,
      steps: [{ type: 'util.log', params: { message: `${name} (hook)` } }],
    });
  const s = await sfApi<{ id: string }>(page, 'POST', `/api/modules/${mod.id}/scenarios`, {
    name: 'Health check fails',
    steps: [
      {
        type: 'api.request',
        params: { url: '/api/missing' },
        assertions: [{ target: 'status', operator: 'equals', expected: 200 }],
      },
    ],
  });
  await page.evaluate((id) => localStorage.setItem('stepforge.currentApp', id), app.id);

  // Module menu → Before/after each test…
  await page.goto('/explorer');
  await page.getByRole('button', { name: 'Actions for Patients' }).click();
  await page.getByRole('menuitem', { name: 'Before/after each test…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Hooks of Patients' });
  await dialog.getByLabel('Before each test').selectOption({ label: 'Sign in' });
  await dialog.getByLabel('After each test').selectOption({ label: 'Sign out' });
  await dialog.getByRole('button', { name: 'Save hooks' }).click();
  await expect(page.getByText('Hooks of Patients saved — they apply to 1 test')).toBeVisible();
  await expect(page.getByLabel('Patients has hooks')).toBeVisible();

  // The scenario's Details tab lists what it inherits.
  await page.goto(`/explorer?scenario=${s.id}&tab=overview`);
  await expect(page.getByTestId('inherited-hooks')).toContainText(
    'From module Patients: before — Sign in · after — Sign out',
  );

  // A run: the hook steps surround the test, and "after" runs although the test failed.
  const run = await sfApi<{ id: string }>(page, 'POST', '/api/runs', {
    applicationId: app.id,
    environmentId: env.id,
    scope: { type: 'scenarios', ids: [s.id] },
  });
  await page.goto(`/runs/${run.id}`);
  const timeline = page.getByRole('list', { name: 'Step timeline' });
  await expect(timeline).toContainText('Before each test: Sign in (module Patients)', { timeout: 30_000 });
  await expect(timeline).toContainText('After each test: Sign out (module Patients)');
  await expect(page.getByText('Sign out (hook)')).toBeVisible();
  await shot(page, 'hooks-run');
});
