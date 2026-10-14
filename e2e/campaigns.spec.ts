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

test('campaigns: one test set across environments × screen sizes, combined report, rerun failed', async ({
  page,
}) => {
  test.setTimeout(150_000);
  await page.goto('/');
  const app = await sfApi<{ id: string }>(page, 'POST', '/api/applications', {
    name: 'Clinic Campaigns',
    slug: `clinic-campaigns-${Date.now().toString(36)}`, // unique: a CI retry must not collide
  });
  await sfApi(page, 'POST', `/api/applications/${app.id}/environments`, {
    name: 'Local',
    baseUrl: CLINIC,
    variables: { healthPath: '/api/health' },
  });
  // "Staging" sends the health check to a page that does not exist: that test fails only there.
  await sfApi(page, 'POST', `/api/applications/${app.id}/environments`, {
    name: 'Staging',
    baseUrl: CLINIC,
    variables: { healthPath: '/api/missing' },
  });
  const mod = await sfApi<{ id: string }>(page, 'POST', `/api/applications/${app.id}/modules`, {
    name: 'Smoke',
  });
  for (const [name, url] of [
    ['Health answers', '{{env.healthPath}}'],
    ['API spec is served', '/api/openapi.json'],
  ])
    await sfApi(page, 'POST', `/api/modules/${mod.id}/scenarios`, {
      name,
      steps: [
        {
          type: 'api.request',
          params: { url },
          assertions: [{ target: 'status', operator: 'equals', expected: 200 }],
        },
      ],
    });
  await page.evaluate((id) => localStorage.setItem('stepforge.currentApp', id), app.id);

  await page.goto('/campaigns');
  await page.getByRole('button', { name: 'New campaign' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'New campaign' });
  await dialog.getByLabel('Campaign name').fill('Release check');
  const envs = dialog.getByRole('group', { name: 'Environments' });
  await envs.getByLabel('Local').check();
  await envs.getByLabel('Staging').check();
  await dialog.getByRole('group', { name: 'Screen sizes' }).getByLabel('Mobile').check();
  await expect(dialog.getByTestId('campaign-combos')).toHaveText('= 4 runs per campaign run');
  await dialog.getByRole('button', { name: 'Create campaign' }).click();
  await expect(page.getByTestId('campaign-card')).toContainText('= 4 runs');

  await page.getByRole('button', { name: 'Run Release check' }).click();
  await expect(page).toHaveURL(/\/campaign-runs\//);
  await expect(page.getByTestId('campaign-cell')).toHaveCount(4);
  await expect(page.getByRole('button', { name: 'Rerun failed' })).toBeVisible({ timeout: 60_000 });
  const grid = page.getByRole('table', { name: 'Results per test and combination' });
  await expect(grid.getByLabel('Health answers — Staging · chromium · desktop: failed')).toBeVisible();
  await expect(grid.getByLabel('Health answers — Local · chromium · mobile: passed')).toBeVisible();
  await expect(grid.getByLabel('API spec is served — Staging · chromium · mobile: passed')).toBeVisible();
  await shot(page, 'campaign-run');

  // Rerun failed: only the failing test, only on Staging (desktop and mobile).
  await page.getByRole('button', { name: 'Rerun failed' }).click();
  await expect(page.getByText('rerun of failed')).toBeVisible();
  await expect(page.getByTestId('campaign-cell')).toHaveCount(2);
  await expect(page.getByTestId('campaign-cell').first()).toContainText('Staging');
  await expect(grid.getByRole('row')).toHaveCount(2); // header + "Health answers"
});
