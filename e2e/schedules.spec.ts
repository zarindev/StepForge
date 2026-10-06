import { expect, test, type Page } from '@playwright/test';

const CLINIC = 'http://127.0.0.1:8191';
const MAILPIT = 'http://127.0.0.1:8196';
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

test('schedules: email channel, cron preview, Run now sends the summary (Phase 11)', async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  await page.goto('/');
  await sfApi(page, 'POST', '/api/email/mailpit/start', {});
  const app = await sfApi<{ id: string }>(page, 'POST', '/api/applications', {
    name: 'Clinic Nightly',
    slug: 'clinic-nightly',
  });
  await sfApi(page, 'POST', `/api/applications/${app.id}/environments`, { name: 'Local', baseUrl: CLINIC });
  const mod = await sfApi<{ id: string }>(page, 'POST', `/api/applications/${app.id}/modules`, {
    name: 'API',
  });
  for (const [name, url] of [
    ['Health check', '/api/health'],
    ['Patients need no login', '/api/patients'], // fails: the API answers 401
  ])
    await sfApi(page, 'POST', `/api/modules/${mod.id}/scenarios`, {
      name,
      steps: [
        {
          type: 'api.request',
          params: { url },
          assertions: [{ target: 'status', operator: 'equals', expected: 200 }],
        },
      ],
    });

  // Settings → Notifications: add an email channel (the local Mailpit's SMTP port).
  await page.goto('/settings');
  await page.getByRole('button', { name: 'Email', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Channel name').fill('QA inbox');
  await dialog.getByLabel('SMTP server').fill('127.0.0.1');
  await dialog.getByLabel('SMTP port').fill('1196');
  await dialog.getByLabel('From address').fill('StepForge <qa@stepforge.test>');
  await dialog.getByLabel('To addresses').fill('nightly@team.test');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByTestId('notify-channels')).toContainText('nightly@team.test via 127.0.0.1');
  await page.getByRole('button', { name: 'Send a test to QA inbox' }).click();
  await expect(page.getByText('Test message sent to QA inbox')).toBeVisible();

  // Schedules: create one with a preset, check the preview, then switch to a custom expression.
  await page.goto('/schedules');
  await page.getByRole('button', { name: 'New schedule' }).first().click();
  const editor = page.getByRole('dialog');
  await editor.getByLabel('Schedule name').fill('Nightly API');
  await editor.getByLabel('Application').selectOption({ label: 'Clinic Nightly' });
  await expect(editor.getByLabel('Environment')).toHaveValue(/.+/);
  await editor.getByLabel('Schedule preset').selectOption({ label: 'Weekdays at 06:00' });
  await expect(editor.getByTestId('cron-preview').locator('li')).toHaveCount(5);
  await editor.getByLabel('Schedule preset').selectOption('custom');
  await editor.getByLabel('Cron expression').fill('99 * * * *');
  await expect(editor.getByTestId('cron-preview')).toContainText(/Invalid schedule/);
  await editor.getByLabel('Cron expression').fill('30 1 * * *');
  await expect(editor.getByTestId('cron-preview').locator('li').first()).toContainText(/1:30/);
  await editor.getByLabel('QA inbox').check();
  await shot(page, 'phase11-schedule-editor');
  await editor.getByRole('button', { name: 'Create schedule' }).click();

  const row = page.getByTestId('schedule-row').filter({ hasText: 'Nightly API' });
  await expect(row).toContainText('30 1 * * *');
  await expect(row).toContainText('Never');
  await row.getByRole('button', { name: 'Run Nightly API now' }).click();
  await expect(row).toContainText(/\d/, { timeout: 30_000 });
  await row.getByRole('button', { name: 'Show history' }).click();
  await expect(page.getByText('QA inbox: sent')).toBeVisible({ timeout: 30_000 });
  await shot(page, 'phase11-schedules');

  // The summary really arrived by email, with the failure and its diagnosis.
  const list = await (
    await request.get(
      `${MAILPIT}/api/v1/search?query=${encodeURIComponent('to:nightly@team.test subject:FAILED')}`,
    )
  ).json();
  expect(list.messages.length).toBeGreaterThan(0);
  const msg = await (await request.get(`${MAILPIT}/api/v1/message/${list.messages[0].ID}`)).json();
  expect(msg.Subject).toBe('[StepForge] Clinic Nightly · Local: FAILED (1/2)');
  expect(msg.Text).toContain('Schedule "Nightly API"');
  expect(msg.Text).toContain('• Patients need no login');
  expect(msg.Text).toContain('Sent by StepForge — by Md Zarin Tasnim');

  // Turning it off clears the next run; Home lists only enabled schedules.
  await row.getByRole('switch', { name: 'Enable Nightly API' }).click();
  await expect(row).toContainText('Off');
  await page.goto('/');
  await expect(page.getByTestId('upcoming-schedules')).toHaveCount(0);
});
