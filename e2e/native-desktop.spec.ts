import { expect, test, type Page } from '@playwright/test';

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

for (const platform of ['macos', 'windows'] as const) {
  const name = platform === 'macos' ? 'macOS' : 'Windows';
  test(`${name} apps: the platform, what this computer has, and how each environment starts the app`, async ({
    page,
  }) => {
    await page.goto('/applications');
    await page
      .getByRole('button', { name: /New application|Create your first application/ })
      .first()
      .click();
    const appName = `CareClinic ${name} ${Date.now().toString(36)}`; // unique: a CI retry must not collide
    await page.getByPlaceholder('e.g. CareClinic').fill(appName);
    await page.getByLabel('Platform').selectOption(platform);
    await page.getByRole('button', { name: 'Create application' }).click();
    await expect(page.getByRole('heading', { name: appName, level: 1 })).toBeVisible();
    await expect(page.getByRole('region', { name: `${name} on this computer` })).toBeVisible();

    await page.getByRole('button', { name: 'Add environment' }).first().click();
    const dialog = page.getByRole('dialog', { name: 'Add environment' });
    await dialog.getByPlaceholder('Staging').fill('This computer');
    await expect(dialog.getByRole('button', { name: 'Save' })).toBeDisabled();
    if (platform === 'macos') {
      await dialog.getByLabel('Bundle id').fill('com.stepforge.careclinic.mac');
      await dialog.getByLabel('Arguments').fill('-demo\n-fast');
    } else {
      await dialog.getByLabel('App file').fill('C:\\Apps\\CareClinic.exe');
      await dialog.getByLabel('Arguments').fill('/demo');
    }
    await shot(page, `${platform}-environment`);
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText(new RegExp(`variables · ${name} app`))).toBeVisible();

    const app = (
      await sfApi<{ id: string; name: string; platform: string }[]>(page, 'GET', '/api/applications')
    ).find((a) => a.name === appName)!;
    expect(app.platform).toBe(platform);
    const [env] = await sfApi<{ browserDefaultsJson: Record<string, Record<string, unknown>> }[]>(
      page,
      'GET',
      `/api/applications/${app.id}/environments`,
    );
    expect(env!.browserDefaultsJson[platform]).toMatchObject(
      platform === 'macos'
        ? { bundleId: 'com.stepforge.careclinic.mac', arguments: ['-demo', '-fast'] }
        : { app: 'C:\\Apps\\CareClinic.exe', arguments: '/demo' },
    );
  });
}
