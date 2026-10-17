import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

const CLINIC = 'http://127.0.0.1:8191';

/** Calls the StepForge API from inside the page (the session token lives in the page). */
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

/** An application with one environment and one module of API scenarios against the CareClinic health check. */
async function makeApp(page: Page, name: string, scenarios: { name: string; status: number }[]) {
  const app = await sfApi<{ id: string }>(page, 'POST', '/api/applications', {
    name,
    slug: `${name.toLowerCase().replace(/\W+/g, '-')}-${Date.now().toString(36)}`, // a CI retry must not collide
  });
  const env = await sfApi<{ id: string }>(page, 'POST', `/api/applications/${app.id}/environments`, {
    name: `${name} env`,
    baseUrl: CLINIC,
  });
  const mod = await sfApi<{ id: string }>(page, 'POST', `/api/applications/${app.id}/modules`, {
    name: 'Health',
  });
  const ids: string[] = [];
  for (const s of scenarios) {
    const created = await sfApi<{ id: string }>(page, 'POST', `/api/modules/${mod.id}/scenarios`, {
      name: s.name,
      steps: [
        {
          type: 'api.request',
          params: { method: 'GET', url: '/api/health' },
          assertions: [{ target: 'status', operator: 'equals', expected: s.status }],
        },
      ],
    });
    ids.push(created.id);
  }
  return { id: app.id, envId: env.id, scenarioIds: ids };
}

async function switchApp(page: Page, name: string) {
  await page.getByRole('button', { name: 'Switch application' }).click();
  await page.getByRole('option', { name: new RegExp(name) }).click();
  await expect(page.getByRole('button', { name: 'Switch application' })).toContainText(name);
}

test('switching application drops the previous app’s state (Explorer, API Client)', async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto('/');
  const alpha = await makeApp(page, 'Switch Alpha', [{ name: 'Alpha health check', status: 200 }]);
  const beta = await makeApp(page, 'Switch Beta', [{ name: 'Beta health check', status: 200 }]);
  await page.evaluate((id) => localStorage.setItem('stepforge.currentApp', id), alpha.id);

  // Explorer: the old app's ?scenario must not pull the switcher back to the old app.
  await page.goto(`/explorer?scenario=${alpha.scenarioIds[0]}`);
  await expect(page.getByRole('button', { name: 'Switch application' })).toContainText('Switch Alpha');
  await expect(page.getByText('Alpha health check').first()).toBeVisible();
  await switchApp(page, 'Switch Beta');
  await expect(page.getByText('Beta health check').first()).toBeVisible();
  await expect(page).not.toHaveURL(/scenario=/);
  await page.waitForTimeout(1000); // the old deep link used to switch back once the scenario loaded
  await expect(page.getByRole('button', { name: 'Switch application' })).toContainText('Switch Beta');

  // API Client: the environment and the loaded scenario follow the application.
  await switchApp(page, 'Switch Alpha');
  await page.goto('/api-client');
  await expect(page.getByLabel('Environment')).toHaveValue(alpha.envId);
  await page
    .getByRole('list', { name: 'API scenarios' })
    .getByRole('button', { name: /Alpha health check/ })
    .click();
  await expect(page.getByText('Editing step of')).toBeVisible();
  await switchApp(page, 'Switch Beta');
  await expect(page.getByLabel('Environment')).toHaveValue(beta.envId);
  await expect(page.getByText('Editing step of')).toBeHidden();
  const sent = page.waitForRequest((r) => r.url().endsWith('/api/api-client/send'));
  await page.getByRole('button', { name: 'Send' }).click();
  expect((await sent).postDataJSON().environmentId).toBe(beta.envId);
});

test('Run again starts clean, and the bug export follows the visible list', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/');
  const app = await makeApp(page, 'Switch Runs', [
    { name: 'Health answers', status: 200 },
    { name: 'Health is a teapot', status: 418 },
    { name: 'Health is missing', status: 404 },
  ]);
  await page.evaluate((id) => localStorage.setItem('stepforge.currentApp', id), app.id);

  await page.goto('/runs');
  await page.getByRole('button', { name: 'New run' }).click();
  await page.getByRole('dialog', { name: 'Run tests' }).getByRole('button', { name: 'Start run' }).click();
  await expect(page).toHaveURL(/\/runs\/[^/?]+/);
  const firstRun = page.url();
  const again = page.getByRole('button', { name: 'Run again' });
  await expect(again).toBeVisible({ timeout: 60_000 });

  // A filter chosen on this run must not carry over to the next one.
  const filters = page.getByRole('tablist', { name: 'Filter tests' });
  await filters.getByRole('tab', { name: 'passed' }).click();
  await expect(page.getByRole('list', { name: 'Tests in this run' })).not.toContainText('Health is missing');
  await again.click();
  await page.getByRole('dialog', { name: 'Run tests' }).getByRole('button', { name: 'Start run' }).click();
  await expect(page).not.toHaveURL(firstRun);
  await expect(filters.getByRole('tab', { name: 'all' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('list', { name: 'Tests in this run' })).toContainText('Health is missing');
  await expect(again).toBeVisible({ timeout: 60_000 });

  // Two bugs filed; mark one minor, filter on severity and export: only that one is in the file.
  await expect
    .poll(async () => (await sfApi<unknown[]>(page, 'GET', `/api/applications/${app.id}/bugs`)).length)
    .toBe(2);
  const bugs = await sfApi<{ id: string; title: string }[]>(page, 'GET', `/api/applications/${app.id}/bugs`);
  const teapot = bugs.find((b) => b.title.includes('teapot'))!;
  const missing = bugs.find((b) => b.title.includes('missing'))!;
  await sfApi(page, 'PATCH', `/api/bugs/${teapot.id}`, { severity: 'minor' });
  await sfApi(page, 'PATCH', `/api/bugs/${missing.id}`, { severity: 'major' });

  await page.goto('/bugs');
  await page.getByLabel('Severity filter').selectOption('minor');
  const list = page.getByRole('list', { name: 'Bug list' });
  await expect(list).toContainText('teapot');
  await expect(list).not.toContainText('missing');
  const [md] = await Promise.all([
    page.waitForEvent('download'),
    (async () => {
      await page.getByRole('button', { name: 'Export list' }).click();
      await page.getByRole('menuitem', { name: 'Markdown' }).click();
    })(),
  ]);
  const text = readFileSync((await md.path())!, 'utf8');
  expect(text).toContain('Health is a teapot');
  expect(text).not.toContain('Health is missing');
});
