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

test('page conditions: "if the element is visible" picks a branch from what the page shows (Cerberus-style conditions)', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.goto('/');
  const app = await sfApi<{ id: string }>(page, 'POST', '/api/applications', {
    name: 'Clinic Conditions',
    slug: `clinic-conditions-${Date.now().toString(36)}`, // unique: a CI retry must not collide
  });
  const env = await sfApi<{ id: string }>(page, 'POST', `/api/applications/${app.id}/environments`, {
    name: 'Local',
    baseUrl: CLINIC,
  });
  const mod = await sfApi<{ id: string }>(page, 'POST', `/api/applications/${app.id}/modules`, {
    name: 'Login',
  });
  const signInButton = [{ strategy: 'role', value: 'button', name: 'Sign in' }];
  const s = await sfApi<{ id: string }>(page, 'POST', `/api/modules/${mod.id}/scenarios`, {
    name: 'Branch on the login form',
    steps: [
      { type: 'ui.navigate', params: { url: '/login' } },
      {
        type: 'util.if',
        locators: signInButton,
        params: {
          condition: { type: 'element', check: 'visible' },
          steps: [{ type: 'util.log', params: { message: 'The login form is shown' } }],
          else: [{ type: 'util.log', params: { message: 'Already signed in' } }],
        },
      },
      {
        type: 'util.if',
        locators: [{ strategy: 'text', value: 'Invalid email or password' }],
        params: {
          condition: { type: 'element', check: 'present', timeoutMs: 300 },
          steps: [{ type: 'util.log', params: { message: 'An error is shown' } }],
          else: [{ type: 'util.log', params: { message: 'No error yet' } }],
        },
      },
    ],
  });
  await page.evaluate((id) => localStorage.setItem('stepforge.currentApp', id), app.id);

  // The editor shows the page-check fields with the element.
  await page.goto(`/explorer?scenario=${s.id}`);
  await page.getByRole('button', { name: /^if → Sign in/ }).click();
  await expect(page.getByLabel('If — compare')).toHaveValue('element');
  await expect(page.getByLabel('Element is')).toHaveValue('visible');
  await expect(page.getByLabel('Operator')).toHaveCount(0);
  await expect(page.getByRole('group', { name: 'Element' })).toBeVisible();
  await shot(page, 'conditions-editor');

  // A run takes the "then" branch of the first and the "else" branch of the second.
  const run = await sfApi<{ id: string }>(page, 'POST', '/api/runs', {
    applicationId: app.id,
    environmentId: env.id,
    scope: { type: 'scenarios', ids: [s.id] },
  });
  await page.goto(`/runs/${run.id}`);
  const timeline = page.getByRole('list', { name: 'Step timeline' });
  await expect(timeline).toContainText('Condition false (present check: 0 found) → else', {
    timeout: 30_000,
  });
  await expect(timeline).toContainText('Condition true (visible check: visible) → then');
  await expect(timeline).toContainText('The login form is shown');
  await expect(timeline).toContainText('No error yet');
  await expect(timeline).not.toContainText('Already signed in');
  await expect(timeline).not.toContainText('An error is shown');
  await shot(page, 'conditions-run');
});

test('web apps: environment browser settings in the form, and a visual checkpoint with "Accept as new baseline"', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.goto('/');
  const app = await sfApi<{ id: string }>(page, 'POST', '/api/applications', {
    name: 'Clinic Visual',
    slug: `clinic-visual-${Date.now().toString(36)}`, // unique: a CI retry must not collide
  });
  const env = await sfApi<{ id: string }>(page, 'POST', `/api/applications/${app.id}/environments`, {
    name: 'Local',
    baseUrl: CLINIC,
  });
  await page.evaluate((id) => localStorage.setItem('stepforge.currentApp', id), app.id);

  // Browser settings are part of the environment form.
  await page.goto(`/applications/${app.id}?tab=environments`);
  await page.getByRole('button', { name: 'Actions for Local' }).click();
  await page.getByRole('menuitem', { name: 'Edit' }).click();
  await page.getByRole('button', { name: /^Browser settings/ }).click();
  await page.getByLabel('Language').fill('de-DE');
  await page.getByLabel('Time zone').fill('Europe/Berlin');
  await page.getByLabel('Colour scheme').selectOption('dark');
  await shot(page, 'browser-settings');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Environment saved')).toBeVisible();
  const envs = await sfApi<{ id: string; browserDefaultsJson: { settings?: Record<string, unknown> } }[]>(
    page,
    'GET',
    `/api/applications/${app.id}/environments`,
  );
  expect(envs.find((e) => e.id === env.id)!.browserDefaultsJson.settings).toEqual({
    locale: 'de-DE',
    timezoneId: 'Europe/Berlin',
    colorScheme: 'dark',
  });

  const mod = await sfApi<{ id: string }>(page, 'POST', `/api/applications/${app.id}/modules`, {
    name: 'Login',
  });
  const baselineName = `login-button-${Date.now().toString(36)}`; // baselines outlive the app: unique per attempt
  const s = await sfApi<{ id: string }>(page, 'POST', `/api/modules/${mod.id}/scenarios`, {
    name: 'Login page looks right',
    steps: [
      { type: 'ui.navigate', params: { url: '/login' } },
      {
        type: 'ui.visualCheckpoint',
        params: { name: baselineName },
        label: 'Sign-in button',
        locators: [{ strategy: 'role', value: 'button', name: 'Sign in' }],
      },
    ],
  });
  const runOnce = async () => {
    const run = await sfApi<{ id: string }>(page, 'POST', '/api/runs', {
      applicationId: app.id,
      environmentId: env.id,
      scope: { type: 'scenarios', ids: [s.id] },
    });
    await page.goto(`/runs/${run.id}`);
    // Finished: the Evidence section appears and steps can be opened.
    await expect(page.getByRole('heading', { name: 'Evidence' })).toBeVisible({ timeout: 30_000 });
    return run.id;
  };
  await runOnce();
  await page.getByRole('button', { name: /Sign-in button/ }).click();
  await expect(page.getByTestId('visual-panel')).toContainText('Screenshot (saved as the baseline)');

  // The page "changes": a mock answers the login page with a different button, so the checkpoint fails.
  await sfApi(page, 'PUT', `/api/scenarios/${s.id}/steps`, {
    steps: [
      {
        type: 'ui.mockRoute',
        params: {
          url: '/login',
          body: '<button style="font-size:30px;padding:20px">Sign in</button>',
          contentType: 'text/html',
        },
      },
      { type: 'ui.navigate', params: { url: '/login' } },
      {
        type: 'ui.visualCheckpoint',
        params: { name: baselineName },
        label: 'Sign-in button',
        locators: [{ strategy: 'role', value: 'button', name: 'Sign in' }],
      },
    ],
  });
  await runOnce();
  await page.getByRole('button', { name: /Sign-in button/ }).click();
  const panel = page.getByTestId('visual-panel');
  await expect(page.getByRole('region', { name: 'Diagnosis' })).toContainText(
    'The page looks different from the approved screenshot',
  );
  await expect(panel.getByRole('img', { name: 'Approved baseline' })).toBeVisible();
  await panel.getByRole('button', { name: 'Accept as new baseline' }).click();
  await expect(panel).toContainText('Accepted: the next run compares with this screenshot.');
  await shot(page, 'visual-accept');
});
