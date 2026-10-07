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

test('API client, OpenAPI import and the generated suite against CareClinic (Phase 5)', async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  await request.post(`${CLINIC}/api/reset`);
  await page.goto('/');
  const app = await sfApi<{ id: string }>(page, 'POST', '/api/applications', {
    name: 'Clinic API',
    slug: 'clinic-api',
  });
  const env = await sfApi<{ id: string }>(page, 'POST', `/api/applications/${app.id}/environments`, {
    name: 'Local',
    baseUrl: CLINIC,
  });
  await sfApi(page, 'PUT', `/api/environments/${env.id}/secrets`, { key: 'apiPassword', value: 'Admin123!' });
  await page.evaluate((id) => localStorage.setItem('stepforge.currentApp', id), app.id);

  // Import the OpenAPI spec from its URL through the dialog
  await page.goto('/api-client');
  await page.getByRole('button', { name: 'Import' }).click();
  const dialog = page.getByRole('dialog', { name: 'Import API tests' });
  await dialog.getByLabel('Spec URL').fill('/api/openapi.json');
  await dialog.getByRole('button', { name: 'Import', exact: true }).click();
  await expect(dialog.getByRole('status')).toContainText(
    /Created \d+ scenario\(s\) in 8 module\(s\) and 1 block/,
  );
  await expect(dialog).toContainText('apiPassword');
  await shot(page, 'import-result');
  await dialog.getByRole('button', { name: 'Close', exact: true }).last().click();
  await expect(page.getByText('CareClinic API').first()).toBeVisible();

  // Send a request: login with a secret, then hit the buggy doctors endpoint → contract violation
  await page.getByLabel('Method').selectOption('POST');
  await page.getByLabel('Request URL').fill('{{env.baseUrl}}/api/auth/login');
  await page.getByRole('tab', { name: 'Body' }).click();
  await page.getByLabel('Body type').selectOption('json');
  await page.getByTestId('code-Request body').click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.insertText('{"email":"admin@careclinic.test","password":"{{secret.apiPassword}}"}');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByTestId('response-status')).toHaveText('200 OK');
  await expect(page.getByTestId('contract-badge')).toHaveText(/contract ok/);
  await expect(page.getByLabel('Response body')).toContainText('"token"');

  await page
    .getByRole('list', { name: 'API scenarios' })
    .getByRole('button', { name: 'GET /api/doctors — happy path' })
    .click();
  await expect(page.getByText('Editing step of')).toBeVisible();
  await page.getByRole('button', { name: 'Send' }).click();
  // {{vars.auth.token}} is set by the Authenticate block inside runs; outside a run the client explains that
  await expect(
    page.getByRole('alert').filter({ hasText: 'Cannot resolve {{vars.auth.token}}' }),
  ).toBeVisible();
  await page.getByRole('tab', { name: 'Auth' }).click();
  await page.getByLabel('Auth type').selectOption('bearer');
  await page.getByRole('tab', { name: 'Headers' }).click();
  await page.getByRole('button', { name: 'Remove row' }).first().click(); // drop the {{vars.auth.token}} header
  await page.getByRole('tab', { name: 'Auth' }).click();
  const login = await request.post(`${CLINIC}/api/auth/login`, {
    data: { email: 'admin@careclinic.test', password: 'Admin123!' },
  });
  await page.getByLabel('Token').fill((await login.json()).token);
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByTestId('response-status')).toHaveText('200 OK');
  await expect(page.getByTestId('contract-badge')).toHaveText(/contract violated/);
  await expect(page.getByText('0.fee should be number')).toBeVisible();
  await shot(page, 'api-client');

  // Run the generated suite: everything passes except the API's real contract breaks
  await request.post(`${CLINIC}/api/reset`);
  await page.goto('/explorer');
  await page.getByRole('button', { name: 'Actions for CareClinic API (OpenAPI)' }).click();
  await page.getByRole('menuitem', { name: 'Run module' }).click();
  await page.getByRole('dialog', { name: 'Run tests' }).getByLabel('Workers').selectOption('4');
  await page.getByRole('dialog', { name: 'Run tests' }).getByRole('button', { name: 'Start run' }).click();
  await expect(page.getByText('Failed', { exact: true }).first()).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText('3 failed')).toBeVisible();
  await page.getByRole('tab', { name: 'failed' }).click();
  const failed = page.getByRole('list', { name: 'Tests in this run' });
  await expect(failed.getByRole('listitem')).toHaveCount(3);
  await expect(failed).toContainText('GET /api/doctors — happy path');
  await expect(failed).toContainText('GET /api/appointments — unauthorized');
  await expect(failed).toContainText('DELETE /api/patients/{id} — not found');
  await failed.getByRole('button', { name: /GET \/api\/doctors — happy path/ }).click();
  await expect(page.getByRole('alert').first()).toContainText('fee should be number');
  await page
    .getByRole('list', { name: 'Step timeline' })
    .getByRole('button', { name: /api\.request/ })
    .click();
  await expect(
    page.getByRole('list', { name: 'Step timeline' }).getByText('Request', { exact: true }),
  ).toBeVisible();
  // The failure is also diagnosed as a schema mismatch owned by the application.
  await expect(page.getByTestId('diagnosis')).toContainText('Application bug');
  await expect(page.getByTestId('diagnosis')).toContainText('fee should be number');
  await shot(page, 'api-run');
});
