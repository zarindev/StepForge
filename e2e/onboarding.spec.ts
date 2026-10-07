import { expect, test, type Page } from '@playwright/test';

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

/** Onboarding needs an empty workspace (the danger-zone API, with its typed confirmation). */
async function emptyWorkspace(page: Page) {
  await page.goto('/');
  await sfApi(page, 'POST', '/api/maintenance/delete-everything', { confirm: 'DELETE EVERYTHING' });
  await page.evaluate(() => localStorage.clear());
  await page.reload();
}

test.describe.serial('first-run onboarding (Phase 13)', () => {
  test('create your first application, then the guided recorder tour', async ({ page }) => {
    await emptyWorkspace(page);
    const welcome = page.getByTestId('welcome');
    await expect(welcome).toContainText('How would you like to start?');
    await welcome.getByRole('button', { name: 'Create an application' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByPlaceholder('e.g. CareClinic').fill('My Shop');
    await dialog.getByRole('button', { name: 'Create application' }).click();

    const tour = page.getByRole('dialog', { name: 'Recorder tour' });
    await expect(tour).toContainText('1 · Point it at your app');
    await expect(page.locator('.tour-target')).toHaveAttribute('data-tour', 'environments');
    await shot(page, 'phase13-tour-1');
    await tour.getByRole('button', { name: 'Next' }).click();
    await expect(page).toHaveURL(/\/recorder$/);
    await expect(tour).toContainText('2 · Choose where to start');
    await tour.getByRole('button', { name: 'Next' }).click();
    await expect(tour).toContainText('3 · Record');
    await expect(page.locator('.tour-target')).toHaveAttribute('data-tour', 'recorder-button');
    await shot(page, 'phase13-tour-3');
    await tour.getByRole('button', { name: 'Back' }).click();
    await expect(tour).toContainText('2 · Choose where to start');
    await tour.getByRole('button', { name: 'Next' }).click();
    await tour.getByRole('button', { name: 'Next' }).click();
    await expect(tour).toContainText('4 · Save and run');
    await tour.getByRole('button', { name: 'Done' }).click();
    await expect(tour).toHaveCount(0);
    await page.reload();
    await expect(page.getByRole('dialog', { name: 'Recorder tour' })).toHaveCount(0); // finished tours stay finished
  });

  test('load the demo workspace and run it: passes and failures as expected', async ({ page }) => {
    test.setTimeout(240_000);
    await emptyWorkspace(page);
    await shot(page, 'phase13-welcome');
    await page.getByRole('button', { name: 'Load demo workspace' }).click();
    const loaded = page.getByTestId('demo-loaded');
    await expect(loaded).toContainText('CareClinic is ready at', { timeout: 60_000 });
    await expect(loaded).toContainText('ShopDesk is ready at');
    await shot(page, 'phase13-demo-loaded');
    await loaded.getByRole('button', { name: 'Run all tests' }).click();
    await expect(page).toHaveURL(/\/runs\/[0-9A-Z]{26}$/);
    const runId = page.url().split('/').pop()!;
    await expect
      .poll(async () => (await sfApi<{ status: string }>(page, 'GET', `/api/runs/${runId}`)).status, {
        timeout: 180_000,
        intervals: [2000],
      })
      .toBe('failed');
    const run = await sfApi<{
      totalsJson: { total: number; passed: number; failed: number; broken: number };
    }>(page, 'GET', `/api/runs/${runId}`);
    // CareClinic: 25 scenarios = 28 test-case runs; the 12 that check its planted defects fail (desktop size).
    expect(run.totalsJson).toMatchObject({ total: 28, passed: 16, failed: 12, broken: 0 });
    await page.reload();
    await expect(page.getByText('Failed', { exact: true }).first()).toBeVisible();
    await shot(page, 'phase13-demo-run');

    // Home now shows the dashboard with the red quality gate.
    await page.goto('/');
    await expect(page.getByTestId('home-gates')).toContainText('CareClinic');
    await expect(page.getByTestId('welcome')).toHaveCount(0);

    // "Run all tests" also started a ShopDesk run: let it finish before cleaning up.
    await expect
      .poll(
        async () =>
          (await sfApi<{ status: string }[]>(page, 'GET', '/api/runs')).filter((r) =>
            ['queued', 'running'].includes(r.status),
          ).length,
        { timeout: 180_000, intervals: [2000] },
      )
      .toBe(0);
    // Leave an empty workspace for the other specs (the demo uses the "careclinic" slug); this also stops CareClinic.
    await sfApi(page, 'POST', '/api/maintenance/delete-everything', { confirm: 'DELETE EVERYTHING' });
  });
});
