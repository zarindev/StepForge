import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';

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

test('performance: authorize, load test with threshold verdicts, export k6, save as test, Lighthouse (Phase 8)', async ({
  page,
}) => {
  test.setTimeout(150_000);
  await page.goto('/');
  const app = await sfApi<{ id: string }>(page, 'POST', '/api/applications', {
    name: 'Clinic Perf',
    slug: 'clinic-perf',
  });
  await sfApi(page, 'POST', `/api/applications/${app.id}/environments`, { name: 'Local', baseUrl: CLINIC });
  await sfApi(page, 'POST', `/api/applications/${app.id}/modules`, { name: 'Load' });
  await page.evaluate((id) => localStorage.setItem('stepforge.currentApp', id), app.id);

  await page.goto('/performance');
  // Load tests need the authorization statement first.
  const gate = page.getByRole('alert').filter({ hasText: 'Only load-test systems you own' });
  await expect(gate).toBeVisible();
  await gate.getByRole('checkbox').check();
  await gate.getByRole('button', { name: 'Confirm for Clinic Perf' }).click();
  await expect(page.getByTestId('load-authorized')).toContainText(
    'You confirmed you own or are authorized to test Clinic Perf',
  );

  await page.getByLabel('URL').fill('/api/health');
  await page.getByLabel('Profile').selectOption('load');
  await page.getByLabel('Virtual users').fill('4');
  await page.getByLabel('Duration').fill('3');
  await page.getByLabel('Ramp-up').fill('0');
  await page.getByLabel('p95 threshold').fill('500');
  await page.getByRole('button', { name: 'Run load test' }).click();
  await expect(page.getByTestId('load-live')).toBeVisible();
  await expect(page.getByLabel('Load test timeline').first()).toBeVisible();
  const report = page.getByTestId('load-report');
  await expect(report).toContainText('Thresholds passed', { timeout: 30_000 });
  await expect(report.getByRole('list', { name: 'Thresholds' })).toContainText(
    /p95 latency [\d.]+ ms < 500 ms/,
  );
  await expect(report).toContainText('GET http://127.0.0.1:8191/api/health · load · 4 VUs');
  await shot(page, 'load-report');

  // An impossible throughput target fails, with the margin.
  await page.getByLabel('Throughput threshold').fill('1000000');
  await page.getByRole('button', { name: 'Run load test' }).click();
  await expect(report).toContainText('Thresholds failed', { timeout: 30_000 });
  await expect(report).toContainText(/Throughput [\d.]+ req\/s is below the required 1000000 req\/s/);

  // Export the same test as a k6 script.
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Export k6 script' }).click(),
  ]);
  expect(download.suggestedFilename()).toBe('clinic-perf-load-test.js');
  const script = readFileSync((await download.path())!, 'utf8');
  expect(script).toContain("import http from 'k6/http';");
  expect(script).toContain('`${BASE_URL}/api/health`');
  expect(script).toContain('"p(95)<500"');

  // Save it as a test in the tree.
  await page.getByRole('button', { name: 'Save as test' }).click();
  await page.getByRole('dialog', { name: 'Save as load test' }).getByRole('button', { name: 'Save' }).click();
  await expect(page).toHaveURL(/\/explorer\?scenario=/);
  await expect(page.getByRole('button', { name: /loadTest \/api\/health perf\.loadTest/ })).toBeVisible();

  // Lighthouse on demand.
  await page.goto('/performance');
  await page.getByRole('tab', { name: 'Lighthouse' }).click();
  await page.getByLabel('Page URL').fill('/login');
  await page.getByRole('button', { name: 'Run Lighthouse' }).click();
  const lh = page.getByTestId('lighthouse-result');
  await expect(lh).toBeVisible({ timeout: 90_000 });
  await expect(lh).toContainText('performance');
  await expect(lh.getByRole('link', { name: 'Open the full Lighthouse report' })).toBeVisible();
  await shot(page, 'lighthouse');

  await page.goto('/settings');
  await expect(page.getByTestId('k6-status')).toBeVisible();
});
