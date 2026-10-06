import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';

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

test('diagnosis, bugs and exports (Phase 9)', async ({ page, request }) => {
  test.setTimeout(150_000);
  await request.post(`${CLINIC}/api/reset`);
  await page.goto('/');
  const app = await sfApi<{ id: string }>(page, 'POST', '/api/applications', {
    name: 'Clinic Bugs',
    slug: 'clinic-bugs',
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
  await sfApi(page, 'POST', `/api/modules/${mod.id}/scenarios`, {
    name: 'Duplicate patients are refused',
    priority: 'P1',
    steps: [
      {
        type: 'api.request',
        params: {
          method: 'POST',
          url: '/api/auth/login',
          body: { email: 'reception@careclinic.test', password: '{{secret.password}}' },
        },
      },
      { type: 'api.extract', params: { path: '$.token' }, captureAs: 'token' },
      {
        type: 'api.request',
        params: {
          method: 'POST',
          url: '/api/patients',
          auth: { type: 'bearer', token: '{{vars.token}}' },
          body: { full_name: 'Ana Lopez', dob: '1988-04-12', phone: '+1-555-201-0001' },
        },
        assertions: [{ target: 'status', operator: 'equals', expected: 409 }],
      },
    ],
  });
  const ui = await sfApi<{ id: string }>(page, 'POST', `/api/modules/${mod.id}/scenarios`, {
    name: 'Save a new patient',
    steps: [
      { type: 'ui.navigate', params: { url: '/login' } },
      {
        type: 'ui.fill',
        params: { value: 'reception@careclinic.test' },
        locators: [{ strategy: 'label', value: 'Email' }],
      },
      {
        type: 'ui.fill',
        params: { value: '{{secret.password}}' },
        locators: [{ strategy: 'testId', value: 'password' }],
      },
      { type: 'ui.click', locators: [{ strategy: 'role', value: 'button', name: 'Sign in' }] },
      { type: 'ui.navigate', params: { url: '/patients/new' } },
      {
        type: 'ui.click',
        timeoutMs: 2000,
        locators: [
          { strategy: 'testId', value: 'store-patient-btn' },
          { strategy: 'role', value: 'button', name: 'Store patient' },
        ],
      },
    ],
  });
  await page.evaluate((id) => localStorage.setItem('stepforge.currentApp', id), app.id);

  // Run the module from the Runs page.
  await page.goto('/runs');
  await page.getByRole('button', { name: 'New run' }).click();
  await page.getByRole('dialog', { name: 'Run tests' }).getByRole('button', { name: 'Start run' }).click();
  await expect(page.getByText('Failed', { exact: true }).first()).toBeVisible({ timeout: 60_000 });

  // API bug: the diagnosis panel explains it.
  await page
    .getByRole('button', { name: /Duplicate patients are refused/ })
    .first()
    .click();
  const diag = page.getByTestId('diagnosis');
  await expect(diag).toContainText('Application bug');
  await expect(diag).toContainText('The API accepted a duplicate (201 instead of 409 Conflict)');
  await expect(diag).toContainText('Check for an existing record');
  await expect(diag.getByRole('link', { name: /BUG-00\d/ })).toBeVisible();
  await shot(page, 'diagnosis');

  // Run report export carries the author.
  const [report] = await Promise.all([
    page.waitForEvent('download'),
    (async () => {
      await page.getByRole('button', { name: 'Export' }).click();
      await page.getByRole('menuitem', { name: 'HTML report (self-contained)' }).click();
    })(),
  ]);
  const html = readFileSync((await report.path())!, 'utf8');
  expect(html).toContain('Prepared by Md Zarin Tasnim');
  expect(html).toContain('StepForge by Md Zarin Tasnim');

  // UI failure: locator changed, fixed in one click.
  await page
    .getByRole('button', { name: /Save a new patient/ })
    .first()
    .click();
  await expect(diag).toContainText('Test needs updating');
  await diag.getByRole('button', { name: 'Use testId=save-patient' }).click();
  await expect(diag.getByRole('button', { name: 'Locator updated' })).toBeVisible();
  const fixed = await sfApi<{ steps: { locators: { strategy: string; value: string }[] }[] }>(
    page,
    'GET',
    `/api/scenarios/${ui.id}`,
  );
  expect(fixed.steps[5]!.locators[0]).toEqual({ strategy: 'testId', value: 'save-patient' });

  // The bug page.
  await diag.getByRole('link', { name: /BUG-00\d/ }).click();
  await expect(page).toHaveURL(/\/bugs\?bug=/);
  const detail = page.getByTestId('bug-detail');
  await expect(detail).toContainText('Save a new patient: The element changed');
  await expect(page.getByRole('list', { name: 'Bug list' })).toContainText('Duplicate patients are refused');
  await page
    .getByRole('list', { name: 'Bug list' })
    .getByRole('button', { name: /Duplicate patients are refused/ })
    .click();
  await expect(detail.getByTestId('steps-to-reproduce')).toContainText(
    '3. Send POST /api/patients  ← fails here',
  );
  await expect(detail).toContainText('critical');
  await detail.getByLabel('Status').selectOption('in_progress');
  await expect(page.getByRole('list', { name: 'Bug list' })).toContainText('in progress');
  await shot(page, 'bugs');

  const [pdf] = await Promise.all([
    page.waitForEvent('download'),
    (async () => {
      await detail.getByRole('button', { name: 'Export' }).click();
      await page.getByRole('menuitem', { name: 'PDF' }).click();
    })(),
  ]);
  expect(pdf.suggestedFilename()).toMatch(/^BUG-00\d-.*\.pdf$/);
  expect(
    readFileSync((await pdf.path())!)
      .subarray(0, 5)
      .toString(),
  ).toBe('%PDF-');

  const [csv] = await Promise.all([
    page.waitForEvent('download'),
    (async () => {
      await page.getByRole('button', { name: 'Export list' }).click();
      await page.getByRole('menuitem', { name: 'Jira CSV' }).click();
    })(),
  ]);
  expect(readFileSync((await csv.path())!, 'utf8')).toContain('Summary,Issue Type,Priority,Description');

  await page.goto('/settings');
  await expect(page.getByLabel('Report author')).toHaveValue('Md Zarin Tasnim');
});
