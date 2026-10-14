import { expect, test, type Page } from '@playwright/test';

const CLINIC = 'http://127.0.0.1:8191';

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

test('run queue: waiting runs in start order, "Run next" and priorities', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/');
  const app = await sfApi<{ id: string }>(page, 'POST', '/api/applications', {
    name: 'Clinic Queue',
    slug: `clinic-queue-${Date.now().toString(36)}`, // unique: a CI retry must not collide
  });
  const env = await sfApi<{ id: string }>(page, 'POST', `/api/applications/${app.id}/environments`, {
    name: 'Local',
    baseUrl: CLINIC,
  });
  const mod = await sfApi<{ id: string }>(page, 'POST', `/api/applications/${app.id}/modules`, { name: 'Q' });
  const scenario = (name: string, ms: number) =>
    sfApi<{ id: string }>(page, 'POST', `/api/modules/${mod.id}/scenarios`, {
      name,
      steps: [{ type: 'util.wait', params: { ms } }],
    });
  const slow = await scenario('Slow', 20_000);
  const quick = await scenario('Quick', 10);
  const start = (id: string, priority = 'normal') =>
    sfApi<{ id: string }>(page, 'POST', '/api/runs', {
      applicationId: app.id,
      environmentId: env.id,
      scope: { type: 'scenarios', ids: [id] },
      options: { priority },
    });
  const blocker = await start(slow.id);
  const first = await start(quick.id);
  const second = await start(quick.id, 'low');

  await page.goto('/runs');
  const queue = page.getByRole('region', { name: 'Run queue' }).or(page.getByLabel('Run queue'));
  await expect(queue).toContainText('Running');
  const rows = queue.locator('li');
  await expect(rows.nth(1)).toContainText(`#${first.id.slice(-8)}`);
  await expect(rows.nth(2)).toContainText(`#${second.id.slice(-8)}`);

  await queue.getByRole('button', { name: `Run ${second.id.slice(-8)} next` }).click();
  await expect(rows.nth(1)).toContainText(`#${second.id.slice(-8)}`);
  await expect(rows.nth(1)).toContainText('next');
  await queue.getByLabel(`Priority of run ${first.id.slice(-8)}`).selectOption('high');
  await expect(queue.getByLabel(`Priority of run ${first.id.slice(-8)}`)).toHaveValue('high');

  // Clean up: nothing keeps running after the test.
  for (const r of [second, first, blocker]) await sfApi(page, 'POST', `/api/runs/${r.id}/cancel`, {});
  await expect(queue).toHaveCount(0, { timeout: 30_000 });
});
