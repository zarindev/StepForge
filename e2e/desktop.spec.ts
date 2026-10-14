import { expect, test, type Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';

const shots = process.env.STEPFORGE_SHOTS;
const shot = async (page: Page, name: string) => {
  if (shots) await page.screenshot({ path: `${shots}/${name}.png` });
};
const DEMO = fileURLToPath(new URL('../demo/desktop-app', import.meta.url));

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

test('desktop apps: an Electron app, its launch settings, and a test run in it', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/applications');
  await page
    .getByRole('button', { name: /New application|Create your first application/ })
    .first()
    .click();
  const name = `Notes ${Date.now().toString(36)}`; // unique: a CI retry must not collide
  await page.getByPlaceholder('e.g. CareClinic').fill(name);
  await page.getByLabel('Platform').selectOption('electron');
  await page.getByRole('button', { name: 'Create application' }).click();
  await expect(page.getByRole('heading', { name, level: 1 })).toBeVisible();

  await page.getByRole('button', { name: 'Add environment' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Add environment' });
  await dialog.getByPlaceholder('Staging').fill('Local build');
  await expect(dialog.getByText('Set the app executable or the app project folder.')).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Save' })).toBeDisabled();
  await dialog.getByLabel('App project folder').fill(DEMO);
  await shot(page, 'desktop-environment');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('desktop app')).toBeVisible();

  const app = (
    await sfApi<{ id: string; name: string; platform: string }[]>(page, 'GET', '/api/applications')
  ).find((a) => a.name === name)!;
  expect(app.platform).toBe('electron');
  const [env] = await sfApi<{ id: string; browserDefaultsJson: { electron: { appPath: string } } }[]>(
    page,
    'GET',
    `/api/applications/${app.id}/environments`,
  );
  expect(env!.browserDefaultsJson.electron.appPath).toBe(DEMO);
  const mod = await sfApi<{ id: string }>(page, 'POST', `/api/applications/${app.id}/modules`, {
    name: 'Notes',
  });
  const scenario = await sfApi<{ id: string }>(page, 'POST', `/api/modules/${mod.id}/scenarios`, {
    name: 'Add a note',
    steps: [
      {
        type: 'ui.fill',
        params: { value: 'Buy milk' },
        locators: [{ strategy: 'placeholder', value: 'Write a note' }],
      },
      { type: 'ui.click', locators: [{ strategy: 'testId', value: 'add-note' }] },
      {
        type: 'ui.assert',
        params: { check: 'text', expected: '1 note' },
        locators: [{ strategy: 'role', value: 'status' }],
      },
    ],
  });
  const run = await sfApi<{ id: string }>(page, 'POST', '/api/runs', {
    applicationId: app.id,
    environmentId: env!.id,
    scope: { type: 'scenarios', ids: [scenario.id] },
  });
  await expect
    .poll(async () => (await sfApi<{ status: string }>(page, 'GET', `/api/runs/${run.id}`)).status, {
      timeout: 60_000,
    })
    .toBe('passed');
});
