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

test('network: a breakdown of the page traffic on the run page, and a budget check step (Cerberus-style network traffic)', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.goto('/');
  const app = await sfApi<{ id: string }>(page, 'POST', '/api/applications', {
    name: 'Clinic Network',
    slug: `clinic-network-${Date.now().toString(36)}`, // unique: a CI retry must not collide
  });
  const env = await sfApi<{ id: string }>(page, 'POST', `/api/applications/${app.id}/environments`, {
    name: 'Local',
    baseUrl: CLINIC,
  });
  const mod = await sfApi<{ id: string }>(page, 'POST', `/api/applications/${app.id}/modules`, {
    name: 'Pages',
  });
  const s = await sfApi<{ id: string }>(page, 'POST', `/api/modules/${mod.id}/scenarios`, {
    name: 'Login page stays light',
    steps: [
      { type: 'ui.navigate', params: { url: '/login' } },
      {
        type: 'ui.networkSummary',
        label: 'Login page budget',
        params: { since: 'lastNavigation' },
        assertions: [
          { target: 'failed', operator: 'equals', expected: 0 },
          { target: 'kb', operator: 'lt', expected: 2000 },
          { target: 'requests:document', operator: 'equals', expected: 1 },
        ],
      },
    ],
  });
  await page.evaluate((id) => localStorage.setItem('stepforge.currentApp', id), app.id);
  const run = await sfApi<{ id: string }>(page, 'POST', '/api/runs', {
    applicationId: app.id,
    environmentId: env.id,
    scope: { type: 'scenarios', ids: [s.id] },
    options: { video: 'off', trace: 'off' },
  });
  await page.goto(`/runs/${run.id}`);
  await expect(page.getByRole('heading', { name: 'Evidence' })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('list', { name: 'Step timeline' })).toContainText(
    /Login page budget\s*\d+ requests?, /,
  );

  await page.getByRole('tab', { name: 'Network', exact: true }).click();
  const view = page.getByTestId('network-view');
  await expect(view).toContainText('Transferred');
  await expect(view).toContainText('By type');
  await expect(view).toContainText('document');
  await expect(view).toContainText('127.0.0.1:8191');
  await shot(page, 'network-breakdown');
  await view.getByRole('tab', { name: /^Requests/ }).click();
  await view.getByLabel('Type').selectOption('document');
  await expect(view.locator('tbody tr')).toHaveCount(1);
  await expect(view.locator('tbody')).toContainText('/login');
});
