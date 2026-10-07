import { expect, test, type Page } from '@playwright/test';

const CLINIC = 'http://127.0.0.1:8191';
const shots = process.env.STEPFORGE_SHOTS;
const shot = async (page: Page, name: string) => {
  if (shots) await page.screenshot({ path: `${shots}/${name}.png`, fullPage: true });
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

test('analytics: home dashboard, quality gate, drill-down and run comparison from real runs (Phase 10)', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.goto('/');
  const app = await sfApi<{ id: string }>(page, 'POST', '/api/applications', {
    name: 'Clinic Analytics',
    slug: `clinic-analytics-${Date.now().toString(36)}`, // unique: a CI retry must not collide
  });
  const env = await sfApi<{ id: string }>(page, 'POST', `/api/applications/${app.id}/environments`, {
    name: 'Local',
    baseUrl: CLINIC,
  });
  const mod = await sfApi<{ id: string }>(page, 'POST', `/api/applications/${app.id}/modules`, {
    name: 'API',
  });
  const create = (name: string, priority: string, url: string, expected: number) =>
    sfApi(page, 'POST', `/api/modules/${mod.id}/scenarios`, {
      name,
      priority,
      steps: [
        {
          type: 'api.request',
          params: { url },
          assertions: [{ target: 'status', operator: 'equals', expected }],
        },
      ],
    });
  await create('Health check', 'P1', '/api/health', 200);
  await create('Patients need no login', 'P2', '/api/patients', 200); // fails: the API answers 401
  await page.evaluate((id) => localStorage.setItem('stepforge.currentApp', id), app.id);

  for (let i = 0; i < 2; i++) {
    const run = await sfApi<{ id: string }>(page, 'POST', '/api/runs', {
      applicationId: app.id,
      environmentId: env.id,
      scope: { type: 'application' },
    });
    await expect
      .poll(async () => (await sfApi<{ status: string }>(page, 'GET', `/api/runs/${run.id}`)).status, {
        timeout: 30_000,
      })
      .toMatch(/passed|failed/);
  }

  // Home is populated from these runs.
  await page.goto('/');
  await expect(page.getByText('Pass/fail trend (30 days)')).toBeVisible();
  await expect(page.getByRole('img', { name: 'Pass and fail trend' })).toBeVisible();
  await expect(page.getByRole('list', { name: 'Recent runs' })).toContainText('Clinic Analytics');
  const kpis = page.getByTestId('kpis');
  await expect(kpis).toContainText('Runs this week');
  await expect(kpis).not.toContainText('Pass rate (7 days)—');
  await expect(page.getByTestId('home-gates')).toContainText('Clinic Analytics');
  await shot(page, 'home-analytics');

  // Application analytics with the recommended gate.
  await page.getByTestId('home-gates').getByRole('link', { name: 'Clinic Analytics' }).click();
  await expect(page).toHaveURL(/\/applications\/.+\/analytics$/);
  await expect(page.getByTestId('analytics-totals')).toContainText('Test results4');
  await page.getByRole('button', { name: /Add the recommended “Release readiness” gate/ }).click();
  const gates = page.getByTestId('gates');
  await expect(gates).toContainText('Release readiness');
  await expect(gates).toContainText('Pass rate of P1 tests ≥ 100%');
  await expect(gates).toContainText('Warning'); // all tests 50% < 95% is a warning; P1 passes
  await expect(page.getByRole('table', { name: 'Top failing tests' })).toContainText(
    'Patients need no login',
  );
  await expect(page.getByRole('table', { name: 'Top failing tests' })).toContainText('2/2 failed');
  await shot(page, 'app-analytics');

  // Drill down to the failing step.
  await page
    .getByRole('table', { name: 'Top failing tests' })
    .getByRole('link', { name: /Patients need no login/ })
    .click();
  await expect(page).toHaveURL(/\/runs\/.+\?item=/);
  await expect(page.getByTestId('diagnosis')).toContainText('401');

  // Compare the two runs.
  await page.goto('/runs');
  await page.getByRole('link', { name: 'Compare' }).click();
  await expect(page.getByTestId('compare-summary')).toContainText('Pass rate 50% → 50%');
  await expect(page.getByLabel('Still failing')).toContainText('Patients need no login');
});
