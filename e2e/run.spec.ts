import { expect, test, type Page } from '@playwright/test';

const CLINIC = 'http://127.0.0.1:8191';
const shots = process.env.STEPFORGE_SHOTS;
const shot = async (page: Page, name: string) => {
  if (shots) await page.screenshot({ path: `${shots}/${name}.png` });
};

/** Calls the StepForge API from inside the page (the session token lives in the page). */
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

const login = [
  { type: 'ui.navigate', label: 'Open the login page', params: { url: '/login' } },
  {
    type: 'ui.fill',
    label: 'Type the email',
    params: { value: '{{data.email}}' },
    locators: [{ strategy: 'label', value: 'Email' }],
  },
  {
    type: 'ui.fill',
    label: 'Type the password',
    params: { value: '{{secret.password}}' },
    locators: [{ strategy: 'testId', value: 'password' }],
  },
  { type: 'ui.click', label: 'Sign in', locators: [{ strategy: 'role', value: 'button', name: 'Sign in' }] },
];

test.describe.serial('run scenarios with evidence (Phase 3)', () => {
  test('runs a manually built UI scenario from the Explorer and shows evidence', async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto('/');
    await sfApi(page, 'POST', `${CLINIC}/api/reset`).catch(() => null); // demo reset is cross-origin; ignore if blocked
    const app = await sfApi<{ id: string }>(page, 'POST', '/api/applications', {
      name: 'CareClinic Runs',
      slug: `careclinic-runs-${Date.now().toString(36)}`, // unique: a CI retry must not collide
    });
    const env = await sfApi<{ id: string }>(page, 'POST', `/api/applications/${app.id}/environments`, {
      name: 'Local',
      baseUrl: CLINIC,
    });
    await sfApi(page, 'PUT', `/api/environments/${env.id}/secrets`, {
      key: 'password',
      value: 'Reception123!',
    });
    const mod = await sfApi<{ id: string }>(page, 'POST', `/api/applications/${app.id}/modules`, {
      name: 'Patients',
    });
    const good = await sfApi<{ id: string }>(page, 'POST', `/api/modules/${mod.id}/scenarios`, {
      name: 'Register a patient',
      steps: [
        ...login,
        {
          type: 'ui.click',
          label: 'Open the registration form',
          locators: [{ strategy: 'testId', value: 'quick-new-patient' }],
        },
        {
          type: 'util.generateData',
          label: 'Generate a patient name',
          params: { kind: 'name' },
          captureAs: 'patient',
        },
        {
          type: 'ui.fill',
          label: 'Full name',
          params: { value: '{{vars.patient}}' },
          locators: [{ strategy: 'label', value: 'Full name' }],
        },
        {
          type: 'ui.fill',
          label: 'Date of birth',
          params: { value: '1990-05-17' },
          locators: [{ strategy: 'label', value: 'Date of birth' }],
        },
        {
          type: 'ui.fill',
          label: 'Phone',
          params: { value: '+1-555-777-1234' },
          locators: [{ strategy: 'testId', value: 'patient-phone' }],
        },
        { type: 'ui.click', label: 'Save', locators: [{ strategy: 'testId', value: 'save-patient' }] },
        {
          type: 'ui.assert',
          label: 'Patient saved',
          params: { check: 'textMatches', expected: 'Patient PAT-\\d+ registered' },
          locators: [{ strategy: 'role', value: 'status' }],
        },
      ],
    });
    await sfApi(page, 'POST', `/api/scenarios/${good.id}/test-cases`, {
      title: 'Receptionist registers',
      data: { email: 'reception@careclinic.test' },
    });
    await sfApi<{ id: string }>(page, 'POST', `/api/modules/${mod.id}/scenarios`, {
      name: 'Dashboard shows billing',
      steps: [
        ...login.map((s) =>
          s.type === 'ui.fill' && s.label === 'Type the email'
            ? { ...s, params: { value: 'reception@careclinic.test' } }
            : s,
        ),
        {
          type: 'ui.assert',
          label: 'Billing widget visible',
          params: { check: 'visible' },
          locators: [{ strategy: 'testId', value: 'kpi-billing' }],
          timeoutMs: 1500,
        },
      ],
    });

    // Run the passing scenario from the Explorer
    await page.goto(`/explorer?scenario=${good.id}`);
    await page.getByTitle('Run this scenario').click();
    const dialog = page.getByRole('dialog', { name: 'Run tests' });
    await expect(dialog.getByLabel('Environment')).toContainText('Local');
    await dialog.getByRole('button', { name: 'Start run' }).click();
    await expect(page).toHaveURL(/\/runs\/[0-9A-Z]{26}$/);
    await expect(page.getByText('Passed', { exact: true }).first()).toBeVisible({ timeout: 45_000 });
    const timeline = page.getByRole('list', { name: 'Step timeline' });
    await expect(timeline.getByRole('listitem')).toHaveCount(11);
    await expect(timeline.locator('img').first()).toBeVisible(); // per-step screenshot served with the token
    await shot(page, 'run-passed');

    // Run the whole module: one pass, one fail
    await page.goto('/runs');
    await page.getByRole('button', { name: 'New run' }).click();
    await page
      .getByRole('dialog', { name: 'Run tests' })
      .getByLabel('Scope')
      .selectOption({ label: 'Patients' });
    await page.getByRole('dialog', { name: 'Run tests' }).getByRole('button', { name: 'Start run' }).click();
    await expect(page.getByText('Failed', { exact: true }).first()).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText('1 passed')).toBeVisible();
    await expect(page.getByText('1 failed')).toBeVisible();
    await expect(page.getByRole('alert')).toContainText('Expected visible');
    await expect(page.getByRole('heading', { name: 'Evidence' })).toBeVisible();
    await expect(page.getByLabel('Test video')).toBeVisible();
    await shot(page, 'run-failed');

    // Trace Viewer opens embedded
    await page.getByRole('tab', { name: 'Trace' }).click();
    await page.getByRole('button', { name: 'Open Trace Viewer' }).click();
    const viewer = page.frameLocator('iframe[title="Trace Viewer"]');
    await expect(
      viewer.getByText('Billing widget visible').or(viewer.getByText(/getByTestId|locator/).first()),
    ).toBeVisible({ timeout: 20_000 });
    await shot(page, 'trace-viewer');
    await page.getByRole('button', { name: 'Close' }).click();

    // Console tab shows the captured browser log; Explorer shows last results
    await page.getByRole('tab', { name: 'Network' }).click();
    await expect(page.getByRole('cell', { name: '/login' }).first()).toBeVisible();
    await page.goto('/explorer');
    await expect(
      page.getByRole('treeitem', { name: 'Dashboard shows billing' }).getByLabel('Failed'),
    ).toBeVisible();
  });
});
