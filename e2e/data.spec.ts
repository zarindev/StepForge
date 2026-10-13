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

test('test data: a table from pasted CSV, preview, a useData step in the editor, and a run that reads a row (Cerberus-style data library)', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.goto('/');
  const app = await sfApi<{ id: string }>(page, 'POST', '/api/applications', {
    name: 'Clinic Data',
    slug: `clinic-data-${Date.now().toString(36)}`, // unique: a CI retry must not collide
  });
  const env = await sfApi<{ id: string }>(page, 'POST', `/api/applications/${app.id}/environments`, {
    name: 'Local',
    baseUrl: CLINIC,
  });
  const mod = await sfApi<{ id: string }>(page, 'POST', `/api/applications/${app.id}/modules`, {
    name: 'Data',
  });
  const s = await sfApi<{ id: string }>(page, 'POST', `/api/modules/${mod.id}/scenarios`, {
    name: 'Uses a reception user',
    steps: [
      {
        type: 'util.useData',
        label: 'Pick the reception user',
        params: { source: 'users', pick: 'match', column: 'role', equals: 'reception', as: 'user' },
      },
      { type: 'util.log', params: { message: 'Signing in as {{vars.user.email}}' } },
    ],
  });
  await page.evaluate((id) => localStorage.setItem('stepforge.currentApp', id), app.id);

  // Application → Test data: a table from pasted CSV, then a preview.
  await page.goto(`/applications/${app.id}?tab=data`);
  await page.getByRole('button', { name: 'New data source' }).click();
  await page.getByLabel('Data source name').fill('users');
  await page.getByRole('button', { name: 'Paste CSV' }).click();
  await page
    .getByLabel('CSV text')
    .fill('email,role\nadmin@careclinic.test,admin\nreception@careclinic.test,reception\n');
  await page.getByRole('button', { name: 'Use these rows' }).click();
  await expect(page.getByLabel('Row 2 email')).toHaveValue('reception@careclinic.test');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.getByText('Data source created')).toBeVisible();
  await page.getByRole('button', { name: 'Preview rows' }).click();
  await expect(page.getByText('2 row(s)')).toBeVisible();
  await expect(page.getByRole('table', { name: 'Preview rows' })).toContainText('reception@careclinic.test');
  await shot(page, 'test-data');

  // The step form knows the source and shows the fields of the chosen pick.
  await page.goto(`/explorer?scenario=${s.id}`);
  await page.getByRole('button', { name: /^Pick the reception user/ }).click();
  await expect(page.getByLabel('Data source')).toHaveValue('users');
  await expect(page.getByLabel('Equals')).toHaveValue('reception');
  await page.getByLabel('Which row').selectOption('row');
  await expect(page.getByLabel('Row number')).toBeVisible();
  await expect(page.getByLabel('Equals')).toHaveCount(0);
  await page.getByRole('tab', { name: 'Plain English' }).click();
  await expect(page.getByRole('list', { name: 'Plain English steps' })).toContainText(
    'Take row 1 of the test data "users" as user',
  );

  // A run reads the matching row (the saved step still says "match").
  const run = await sfApi<{ id: string }>(page, 'POST', '/api/runs', {
    applicationId: app.id,
    environmentId: env.id,
    scope: { type: 'scenarios', ids: [s.id] },
  });
  await page.goto(`/runs/${run.id}`);
  await expect(page.getByText('Signing in as reception@careclinic.test')).toBeVisible({ timeout: 30_000 });
});
