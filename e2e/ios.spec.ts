import { expect, test, type Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';

const shots = process.env.STEPFORGE_SHOTS;
const shot = async (page: Page, name: string) => {
  if (shots) await page.screenshot({ path: `${shots}/${name}.png` });
};
const APP = fileURLToPath(new URL('../demo/ios-app/build/CareClinic.app', import.meta.url));

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

test('iOS apps: the platform, what this computer has, and the app and simulator per environment', async ({
  page,
}) => {
  await page.goto('/applications');
  await page
    .getByRole('button', { name: /New application|Create your first application/ })
    .first()
    .click();
  const name = `CareClinic iOS ${Date.now().toString(36)}`; // unique: a CI retry must not collide
  await page.getByPlaceholder('e.g. CareClinic').fill(name);
  await page.getByLabel('Platform').selectOption('ios');
  await page.getByRole('button', { name: 'Create application' }).click();
  await expect(page.getByRole('heading', { name, level: 1 })).toBeVisible();

  // What this computer has for iOS: Xcode and simulators on a Mac; elsewhere, that a Mac is needed.
  const status = page.getByRole('region', { name: 'iOS on this computer' });
  await expect(status).toContainText(
    process.platform === 'darwin' ? 'Xcode' : 'can only be tested from a Mac',
  );

  await page.getByRole('button', { name: 'Add environment' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Add environment' });
  await dialog.getByPlaceholder('Staging').fill('Simulator');
  await expect(dialog.getByText('Set the app or the installed app’s bundle id.')).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Save' })).toBeDisabled();
  await dialog.getByLabel('App file').fill(APP);
  await dialog.getByLabel('iOS version').fill('27.0');
  await shot(page, 'ios-environment');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText(/variables · iOS app/)).toBeVisible();

  const app = (
    await sfApi<{ id: string; name: string; platform: string }[]>(page, 'GET', '/api/applications')
  ).find((a) => a.name === name)!;
  expect(app.platform).toBe('ios');
  const [env] = await sfApi<{ browserDefaultsJson: { ios: Record<string, unknown> } }[]>(
    page,
    'GET',
    `/api/applications/${app.id}/environments`,
  );
  expect(env!.browserDefaultsJson.ios).toMatchObject({ app: APP, platformVersion: '27.0', resetApp: true });
});

test('recording an iOS app from its screen in the dashboard', async ({ page }) => {
  test.skip(!process.env.STEPFORGE_TEST_IOS, 'needs an iOS simulator (STEPFORGE_TEST_IOS)');
  test.setTimeout(600_000);
  await page.goto('/applications');
  const name = `CareClinic iOS rec ${Date.now().toString(36)}`;
  const app = await sfApi<{ id: string }>(page, 'POST', '/api/applications', {
    name,
    slug: `cc-ios-rec-${Date.now().toString(36)}`,
    platform: 'ios',
  });
  await sfApi(page, 'POST', `/api/applications/${app.id}/environments`, {
    name: 'Simulator',
    baseUrl: 'app://careclinic',
    browserDefaults: { ios: { app: APP } },
  });
  const mod = await sfApi<{ id: string }>(page, 'POST', `/api/applications/${app.id}/modules`, {
    name: 'Sign in',
  });
  const scenario = await sfApi<{ id: string }>(page, 'POST', `/api/modules/${mod.id}/scenarios`, {
    name: 'Recorded',
  });
  await page.goto(`/recorder?scenario=${scenario.id}`);
  await page.getByRole('button', { name: 'Start recording' }).click();
  const screen = page.getByRole('img', { name: "The iOS app's screen" });
  await expect(screen).toBeVisible({ timeout: 300_000 });
  // The email field is near the top of the screen: about 18 % down, in the middle.
  const box = (await screen.boundingBox())!;
  await screen.click({ position: { x: box.width / 2, y: box.height * 0.18 } });
  await expect(page.getByText(/Type into TextField "Email"/)).toBeVisible({ timeout: 30_000 });
  await page.getByLabel('Text to type').fill('nurse@careclinic.test');
  await page.getByRole('button', { name: 'Type' }).click();
  const steps = page.getByRole('list', { name: 'Recorded steps' });
  await expect(steps).toContainText('nurse@careclinic.test');
  await shot(page, 'ios-recorder');
  await page.getByRole('button', { name: /Stop/ }).click();
  await expect(page.getByText(/Review/).first()).toBeVisible({ timeout: 30_000 });
});
