import { expect, test, type Page } from '@playwright/test';
import { PNG } from 'pngjs';

const CLINIC = 'http://127.0.0.1:8191';
const shots = process.env.STEPFORGE_SHOTS;
const shot = async (page: Page, name: string) => {
  if (shots) await page.screenshot({ path: `${shots}/${name}.png` });
};
// A 320×200 light-grey image as a screenshot to attach and mark up.
const IMAGE = (() => {
  const png = new PNG({ width: 320, height: 200 });
  png.data.fill(230);
  return PNG.sync.write(png);
})();

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

test('manual testing: a manual test is pending until run; Run manually opens the browser; results, marked-up screenshots and a bug report', async ({
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
  const s = await sfApi<{ id: string }>(page, 'POST', `/api/modules/${mod.id}/scenarios`, {
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

  // Make it a manual test: it is pending, and only "Run manually" is offered.
  await page.goto(`/explorer?scenario=${s.id}&tab=overview`);
  await page.getByLabel('How it is tested').selectOption('manual');
  await page.getByRole('button', { name: 'Save details' }).click();
  await expect(page.getByText('manual · pending')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Run', exact: true }).nth(1)).toHaveCount(0);

  await page.getByRole('button', { name: 'Run manually' }).click();
  const dialog = page.getByRole('dialog', { name: 'Run tests' });
  await expect(dialog.getByLabel('How', { exact: true })).toHaveValue('manual');
  await expect(dialog.getByLabel('Browser', { exact: true })).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Start manual run' }).click();

  const checklist = page
    .getByRole('region', { name: 'Manual checklist' })
    .or(page.getByLabel('Manual checklist'));
  await expect(checklist).toContainText('Open /login');
  await expect(checklist).toContainText('Print the visit summary — expect: The clinic logo is on the page');
  await expect(checklist).toContainText('Browser open · recording', { timeout: 30_000 });
  await expect(page.getByText('Manual run', { exact: true })).toBeVisible();

  await checklist.getByRole('button', { name: 'Step 1: Passed' }).click();
  await checklist.getByRole('button', { name: 'Step 2: Failed' }).click();
  await checklist.getByLabel('Step 2: note').fill('The logo is missing on the printout');
  await checklist.getByText('Do each step and record what happened').click(); // leaving the note saves it
  const chooser = page.waitForEvent('filechooser');
  await checklist.getByRole('button', { name: 'Step 2: attach a screenshot' }).click();
  await (await chooser).setFiles({ name: 'printout.png', mimeType: 'image/png', buffer: IMAGE });
  await expect(checklist.getByRole('img', { name: 'Screenshot 1 for step 2' })).toBeVisible();
  await expect(checklist).toContainText('2 of 2 steps recorded');

  // Mark up the screenshot with a red box.
  await checklist.getByRole('button', { name: 'Mark up screenshot 1 of step 2' }).click();
  const annotator = page.getByTestId('annotator');
  await annotator.getByRole('button', { name: 'Box' }).click();
  const canvas = annotator.getByLabel('Screenshot to mark up');
  const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.6, { steps: 5 });
  await page.mouse.up();
  await shot(page, 'manual-annotate');
  await page.getByRole('button', { name: 'Save marked-up copy' }).click();
  await expect(page.getByText('Marked-up screenshot saved')).toBeVisible();

  // Report the bug: how it should behave, how it behaves.
  await checklist.getByRole('button', { name: 'Report a bug' }).click();
  const bug = page.getByRole('dialog', { name: 'Report a bug — step 2' });
  await expect(bug.getByLabel('Expected behaviour')).toHaveValue('The clinic logo is on the page');
  await expect(bug.getByLabel('Actual behaviour')).toHaveValue('The logo is missing on the printout');
  await bug.getByLabel('Severity').selectOption('critical');
  await bug.getByRole('button', { name: 'File the bug' }).click();
  await expect(page.getByText('BUG-001 filed')).toBeVisible();
  await expect(checklist.getByRole('link', { name: 'BUG-001' })).toBeVisible();
  await shot(page, 'manual-checklist');

  await checklist.getByRole('button', { name: 'Finish test' }).click();
  // The only test is done, so the run is finished: failed, with the tester's note in the report.
  await expect(page.getByText('1 failed')).toBeVisible();
  const timeline = page.getByRole('list', { name: 'Step timeline' });
  await expect(timeline).toContainText('The logo is missing on the printout');
  // The browser session's recording is the test's video, and it plays (its file is named page@….webm).
  await page.getByRole('tab', { name: 'Video' }).click({ timeout: 30_000 });
  const duration = await page.getByLabel('Test video').evaluate(
    (v: HTMLVideoElement) =>
      new Promise<number>((resolve, reject) => {
        if (v.readyState >= 1) return resolve(v.duration);
        v.addEventListener('loadedmetadata', () => resolve(v.duration));
        v.addEventListener('error', () => reject(new Error(`The video did not load (${v.error?.code})`)));
      }),
  );
  expect(duration).toBeGreaterThan(0);
  await shot(page, 'manual-result');
});
