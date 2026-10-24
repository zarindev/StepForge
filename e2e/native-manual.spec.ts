import { expect, test, type Page } from '@playwright/test';
import { startFakeAppium, type FakeAppium } from '../apps/server/test/fake-appium.ts';

/**
 * A manual test in a phone app: "Run manually" starts the app, the run page shows its screen beside the steps, and the
 * tester uses it from there. Without a device the app answers through a fake Appium server on this port
 * (STEPFORGE_APPIUM_URL in playwright.config.ts); on a device see android.spec.ts and ios.spec.ts.
 */
const FAKE_APPIUM_PORT = 4736;
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

let appium: FakeAppium | undefined;
test.beforeAll(async () => {
  if (!process.env.STEPFORGE_TEST_ANDROID && !process.env.STEPFORGE_TEST_IOS)
    appium = await startFakeAppium(FAKE_APPIUM_PORT);
});
test.afterAll(async () => {
  await appium?.close();
});

test('manual testing a phone app: Run manually starts it; its screen beside the steps; tap, type, screenshot, finish', async ({
  page,
}) => {
  test.skip(!appium, 'runs against the fake Appium server (a device run uses the real one)');
  test.setTimeout(90_000);
  await page.goto('/');
  const stamp = Date.now().toString(36); // unique: a CI retry must not collide
  const app = await sfApi<{ id: string }>(page, 'POST', '/api/applications', {
    name: `CareClinic phone manual ${stamp}`,
    slug: `cc-phone-manual-${stamp}`,
    platform: 'android',
  });
  await sfApi(page, 'POST', `/api/applications/${app.id}/environments`, {
    name: 'Emulator',
    baseUrl: 'app://careclinic',
    browserDefaults: { android: { appPackage: 'com.stepforge.careclinic' } },
  });
  const mod = await sfApi<{ id: string }>(page, 'POST', `/api/applications/${app.id}/modules`, {
    name: 'Sign in',
  });
  const s = await sfApi<{ id: string }>(page, 'POST', `/api/modules/${mod.id}/scenarios`, {
    name: 'Sign in by hand',
    execution: 'manual',
    steps: [
      { type: 'util.manual', params: { instruction: 'Type your email', expected: 'It shows in the field' } },
      { type: 'util.manual', params: { instruction: 'Press Sign in', expected: 'The patient list opens' } },
    ],
  });
  await page.evaluate((id) => localStorage.setItem('stepforge.currentApp', id), app.id);

  await page.goto(`/explorer?scenario=${s.id}&tab=overview`);
  await page.getByRole('button', { name: 'Run manually' }).click();
  const dialog = page.getByRole('dialog', { name: 'Run tests' });
  await expect(dialog.getByText('Start the app now; its screen shows on the run page')).toBeVisible();
  await dialog.getByRole('button', { name: 'Start manual run' }).click();

  const checklist = page.getByLabel('Manual checklist');
  await expect(checklist).toContainText('App open · recording', { timeout: 30_000 });
  const screen = checklist.getByRole('img', { name: "The Android app's screen" });
  await expect(screen).toBeVisible();
  // The email field is at 200–300 of the 1920-pixel-high screen: a click there taps it on the device.
  const box = (await screen.boundingBox())!;
  await screen.click({ position: { x: box.width / 2, y: (box.height * 250) / 1920 } });
  await expect.poll(() => appium!.calls.some((c) => c.path.endsWith('/actions'))).toBe(true);
  await checklist.getByLabel('Text to type').fill('nurse@careclinic.test');
  await checklist.getByRole('button', { name: 'Type', exact: true }).click();
  await expect.poll(() => appium!.typed.email).toBe('nurse@careclinic.test');

  // A screenshot from the device for the current step, a clip of the screen recording, then the results.
  await expect(checklist.getByRole('region', { name: 'The app' })).toContainText('Step 1: Type your email');
  await checklist.getByRole('button', { name: 'Record clip' }).click();
  await checklist.getByRole('button', { name: 'Stop clip' }).click();
  await checklist.getByRole('button', { name: 'Screenshot', exact: true }).click();
  await expect(checklist.getByRole('img', { name: 'Screenshot 1 for step 1' })).toBeVisible();
  await expect(checklist).toContainText('Clip 1');
  await checklist.getByRole('button', { name: 'Step 1: Passed' }).click();
  await expect(checklist.getByRole('region', { name: 'The app' })).toContainText('Step 2: Press Sign in');
  await checklist.getByRole('button', { name: 'Step 2: screenshot from the app' }).click();
  await expect(checklist.getByRole('img', { name: 'Screenshot 1 for step 2' })).toBeVisible();
  await checklist.getByRole('button', { name: 'Step 2: Failed' }).click();
  await shot(page, 'manual-phone-app');

  const quits = appium!.quits;
  await checklist.getByRole('button', { name: 'Finish test' }).click();
  await expect(page.getByText('1 failed')).toBeVisible();
  // Finishing closes the app on the device.
  await expect.poll(() => appium!.quits).toBe(quits + 1);
});
