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

// A 16×16 PNG with some detail (a red/blue checkerboard), as an uploaded picture.
const PICTURE = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAI0lEQVR4nGNgYPgPR/+ROLjFB58G4kxF4g1CDYMwWEdiPAAAker/AT60A4AAAAAASUVORK5CYII=',
  'base64',
);

test('image locators: a step gets a picture as a locator in the editor', async ({ page }) => {
  await page.goto('/');
  const app = await sfApi<{ id: string }>(page, 'POST', '/api/applications', {
    name: 'Pictures',
    slug: `pictures-${Date.now().toString(36)}`, // unique: a CI retry must not collide
  });
  const mod = await sfApi<{ id: string }>(page, 'POST', `/api/applications/${app.id}/modules`, { name: 'M' });
  const s = await sfApi<{ id: string }>(page, 'POST', `/api/modules/${mod.id}/scenarios`, {
    name: 'Click the map pin',
    steps: [{ type: 'ui.click', locators: [{ strategy: 'testId', value: 'pin' }] }],
  });
  await page.evaluate((id) => localStorage.setItem('stepforge.currentApp', id), app.id);
  await page.goto(`/explorer?scenario=${s.id}`);
  await page.getByRole('button', { name: /→ pin/ }).click();
  await page.getByRole('button', { name: 'Add locator' }).click();
  await page.getByLabel('Locator 2 strategy').selectOption('image');
  await page
    .getByLabel('Locator 2 picture file')
    .setInputFiles({ name: 'pin.png', mimeType: 'image/png', buffer: PICTURE });
  await expect(page.getByAltText('Locator 2 picture')).toBeVisible();
  await page.getByLabel('Locator 2 match').fill('85');
  await shot(page, 'image-locator');
  await page.getByRole('button', { name: 'Save steps' }).click();
  await expect(page.getByText(/Saved steps/)).toBeVisible();
  const saved = await sfApi<{
    steps: { locators: { strategy: string; value: string; threshold?: number }[] }[];
  }>(page, 'GET', `/api/scenarios/${s.id}`);
  expect(saved.steps[0]!.locators[1]).toMatchObject({ strategy: 'image', threshold: 0.85 });
  expect(saved.steps[0]!.locators[1]!.value).toMatch(/^data:image\/png;base64,/);
});
