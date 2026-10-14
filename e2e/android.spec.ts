import { expect, test, type Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';

const shots = process.env.STEPFORGE_SHOTS;
const shot = async (page: Page, name: string) => {
  if (shots) await page.screenshot({ path: `${shots}/${name}.png` });
};
const APK = fileURLToPath(new URL('../demo/android-app/careclinic.apk', import.meta.url));

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

test('Android apps: the platform, what this computer has, and the app and device per environment', async ({
  page,
}) => {
  await page.goto('/applications');
  await page
    .getByRole('button', { name: /New application|Create your first application/ })
    .first()
    .click();
  const name = `CareClinic mobile ${Date.now().toString(36)}`; // unique: a CI retry must not collide
  await page.getByPlaceholder('e.g. CareClinic').fill(name);
  await page.getByLabel('Platform').selectOption('android');
  await page.getByRole('button', { name: 'Create application' }).click();
  await expect(page.getByRole('heading', { name, level: 1 })).toBeVisible();

  // What this computer has for Android, each check with how to fix it.
  const status = page.getByRole('region', { name: 'Android on this computer' });
  await expect(status).toContainText('Android SDK');
  await expect(status).toContainText('Appium and the Android driver');

  await page.getByRole('button', { name: 'Add environment' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Add environment' });
  await dialog.getByPlaceholder('Staging').fill('Emulator');
  await expect(dialog.getByText('Set the app file or the installed app’s package.')).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Save' })).toBeDisabled();
  await dialog.getByLabel('App file').fill(APK);
  await dialog.getByLabel('Extra Appium capabilities').fill('{ "appium:language": "fr" }');
  await shot(page, 'android-environment');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText(/variables · Android app/)).toBeVisible();

  const app = (
    await sfApi<{ id: string; name: string; platform: string }[]>(page, 'GET', '/api/applications')
  ).find((a) => a.name === name)!;
  expect(app.platform).toBe('android');
  const [env] = await sfApi<{ browserDefaultsJson: { android: Record<string, unknown> } }[]>(
    page,
    'GET',
    `/api/applications/${app.id}/environments`,
  );
  expect(env!.browserDefaultsJson.android).toMatchObject({
    app: APK,
    resetApp: true,
    showEmulator: false,
    capabilities: { 'appium:language': 'fr' },
  });

  // The recorder explains that recording Android apps is not available yet.
  const mod = await sfApi<{ id: string }>(page, 'POST', `/api/applications/${app.id}/modules`, {
    name: 'Patients',
  });
  const scenario = await sfApi<{ id: string }>(page, 'POST', `/api/modules/${mod.id}/scenarios`, {
    name: 'Sign in',
  });
  await page.goto(`/recorder?scenario=${scenario.id}`);
  await expect(page.getByText('Starts the app on the emulator or phone')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start recording' })).toBeEnabled();
});
