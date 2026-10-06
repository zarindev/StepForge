import { expect, test, type Page } from '@playwright/test';

const CLINIC = 'http://127.0.0.1:8191';
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

const SIGNUP_STEPS = [
  { type: 'util.setVariable', params: { name: 'email', value: 'e2e.signup+{{run.id}}@example.test' } },
  { type: 'ui.navigate', params: { url: '/signup' } },
  { type: 'ui.fill', params: { value: 'Erin Email' }, locators: [{ strategy: 'label', value: 'Full name' }] },
  { type: 'ui.fill', params: { value: '{{vars.email}}' }, locators: [{ strategy: 'label', value: 'Email' }] },
  { type: 'ui.fill', params: { value: 'Welcome123!' }, locators: [{ strategy: 'label', value: 'Password' }] },
  { type: 'ui.click', locators: [{ strategy: 'role', value: 'button', name: 'Create account' }] },
  { type: 'email.waitForEmail', params: { to: '{{vars.email}}', subject: 'Verify', timeoutMs: 20000 } },
  { type: 'email.extractFromEmail', params: { kind: 'otp' }, captureAs: 'otp' },
  {
    type: 'ui.fill',
    params: { value: '{{vars.otp}}' },
    locators: [{ strategy: 'label', value: 'Verification code' }],
  },
  { type: 'ui.click', locators: [{ strategy: 'role', value: 'button', name: 'Verify email' }] },
  {
    type: 'ui.assert',
    params: { check: 'textContains', expected: 'Email verified' },
    locators: [{ strategy: 'testId', value: 'flash' }],
  },
];

test('email: start Mailpit, run a sign-up with OTP, preview the email and browse the inbox (Phase 7)', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.goto('/settings');
  const status = page.getByTestId('mailpit-status');
  await expect(status).toContainText(/Stopped|Running/);
  if ((await status.textContent())?.includes('Stopped'))
    await page.getByRole('button', { name: 'Start' }).click();
  await expect(status).toContainText('Running v1.31.4');
  await shot(page, 'email-settings');

  const app = await sfApi<{ id: string }>(page, 'POST', '/api/applications', {
    name: 'Clinic Mail',
    slug: 'clinic-mail',
  });
  await sfApi(page, 'POST', `/api/applications/${app.id}/environments`, { name: 'Local', baseUrl: CLINIC });
  const mod = await sfApi<{ id: string }>(page, 'POST', `/api/applications/${app.id}/modules`, {
    name: 'Accounts',
  });
  const scenario = await sfApi<{ id: string }>(page, 'POST', `/api/modules/${mod.id}/scenarios`, {
    name: 'Sign up with email OTP',
    steps: SIGNUP_STEPS,
  });
  await page.evaluate((id) => localStorage.setItem('stepforge.currentApp', id), app.id);

  // The editor shows the email steps in plain words and typed forms.
  await page.goto(`/explorer?scenario=${scenario.id}`);
  await expect(page.getByRole('button', { name: /waitForEmail/ })).toBeVisible();

  await page.getByTitle('Run this scenario').click();
  await page.getByRole('dialog', { name: 'Run tests' }).getByRole('button', { name: 'Start run' }).click();
  await expect(page).toHaveURL(/\/runs\/[0-9A-Z]{26}$/);
  await expect(page.getByText('Passed', { exact: true }).first()).toBeVisible({ timeout: 60_000 });
  const timeline = page.getByRole('list', { name: 'Step timeline' });
  const wait = timeline
    .getByRole('listitem')
    .filter({ hasText: 'Received "Verify your CareClinic account"' });
  await wait.getByRole('button').first().click();
  const preview = wait.getByTestId('email-preview');
  await expect(preview).toContainText('Verify your CareClinic account');
  await expect(preview.locator('iframe')).toHaveAttribute('sandbox', '');
  await expect(preview.frameLocator('iframe').getByText(/Your verification code is/)).toBeVisible();
  await expect(timeline.getByText(/Extracted code \d{6}/)).toBeVisible();
  await shot(page, 'email-run-preview');

  // The Inboxes tab falls back to the local Mailpit and can browse it.
  await page.goto(`/applications/${app.id}`);
  await page.getByRole('tab', { name: 'Inboxes' }).click();
  await expect(page.getByText('Local Mailpit', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Open', exact: true }).click();
  const viewer = page.getByRole('dialog', { name: 'Local inbox (Mailpit)' });
  await expect(viewer.getByRole('list', { name: 'Messages' })).toContainText(
    'Verify your CareClinic account',
  );
  await shot(page, 'email-inbox-viewer');
  await viewer.getByRole('tab', { name: 'Links' }).click();
  await expect(viewer.getByText(/\/verify\?email=.*&code=\d{6}/)).toBeVisible();
  await viewer.getByRole('button', { name: 'Clear inbox' }).click();
  await expect(viewer.getByText('No emails yet')).toBeVisible();
  await viewer.getByRole('button', { name: 'Close' }).click();

  // Add an IMAP inbox and test it: a wrong host is reported, not a crash.
  await page.getByRole('button', { name: 'Add inbox' }).click();
  const dlg = page.getByRole('dialog', { name: 'New inbox' });
  await dlg.getByLabel('Name').fill('Team Gmail');
  await dlg.getByLabel('Type').selectOption('imap');
  await dlg.getByLabel('IMAP host').fill('127.0.0.1');
  await dlg.getByLabel('Port').fill('1');
  await dlg.getByLabel('User').fill('qa@example.test');
  await dlg.getByLabel('Password').fill('app-password');
  await dlg.getByRole('button', { name: 'Test' }).click();
  await expect(dlg.getByRole('status')).toContainText('Cannot connect to IMAP 127.0.0.1:1');
  await dlg.getByRole('button', { name: 'Save inbox' }).click();
  await expect(page.getByText('qa@example.test@127.0.0.1:1/INBOX')).toBeVisible();

  await page.goto('/settings');
  await page.getByRole('button', { name: 'Stop' }).click();
  await expect(status).toContainText('Stopped');
});
