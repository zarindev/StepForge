import { expect, test, type Page } from '@playwright/test';

const CLINIC = 'http://127.0.0.1:8191';
const shots = process.env.STEPFORGE_SHOTS;
const shot = async (page: Page, name: string) => {
  if (shots) await page.screenshot({ path: `${shots}/${name}.png` });
};
// A 1×1 PNG as a file to attach.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

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

test('manual run: a tester follows the steps, records passed / failed with a note and a screenshot', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.goto('/');
  const app = await sfApi<{ id: string }>(page, 'POST', '/api/applications', {
    name: 'Clinic Manual',
    slug: `clinic-manual-${Date.now().toString(36)}`, // unique: a CI retry must not collide
  });
  await sfApi(page, 'POST', `/api/applications/${app.id}/environments`, { name: 'Local', baseUrl: CLINIC });
  const mod = await sfApi<{ id: string }>(page, 'POST', `/api/applications/${app.id}/modules`, {
    name: 'Front desk',
  });
  await sfApi(page, 'POST', `/api/modules/${mod.id}/scenarios`, {
    name: 'Print a visit summary',
    steps: [
      { type: 'ui.navigate', params: { url: '/login' } },
      {
        type: 'util.manual',
        params: { instruction: 'Print the visit summary', expected: 'The clinic logo is on the page' },
      },
    ],
  });
  await page.evaluate((id) => localStorage.setItem('stepforge.currentApp', id), app.id);
  await page.reload();

  await page.getByRole('button', { name: 'Run', exact: true }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Run tests' });
  await dialog.getByLabel('How', { exact: true }).selectOption('manual');
  await expect(dialog.getByLabel('Browser', { exact: true })).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Start manual run' }).click();

  const checklist = page
    .getByRole('region', { name: 'Manual checklist' })
    .or(page.getByLabel('Manual checklist'));
  await expect(checklist).toContainText('Open /login');
  await expect(checklist).toContainText('Print the visit summary — expect: The clinic logo is on the page');
  await expect(page.getByText('Manual run', { exact: true })).toBeVisible();

  await checklist.getByRole('button', { name: 'Step 1: Passed' }).click();
  await checklist.getByRole('button', { name: 'Step 2: Failed' }).click();
  await checklist.getByLabel('Step 2: note').fill('The logo is missing on the printout');
  const chooser = page.waitForEvent('filechooser');
  await checklist.getByRole('button', { name: 'Step 2: attach a screenshot' }).click();
  await (await chooser).setFiles({ name: 'printout.png', mimeType: 'image/png', buffer: PNG });
  await expect(checklist.getByRole('img', { name: 'Screenshot for step 2' })).toBeVisible();
  await expect(checklist).toContainText('2 of 2 steps recorded');
  await shot(page, 'manual-checklist');
  await checklist.getByRole('button', { name: 'Finish test' }).click();

  // The only test is done, so the run is finished: failed, with the tester's note in the report.
  await expect(page.getByText('1 failed')).toBeVisible();
  const timeline = page.getByRole('list', { name: 'Step timeline' });
  await expect(timeline).toContainText('The logo is missing on the printout');
  await shot(page, 'manual-result');
});
