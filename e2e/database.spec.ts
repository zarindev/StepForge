import { expect, test, type Page } from '@playwright/test';
import { join } from 'node:path';

const CLINIC = 'http://127.0.0.1:8191';
const CLINIC_DB = join(process.env.STEPFORGE_E2E_DATA!, 'clinic-e2e.db');
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

/** Replaces the Monaco editor's content (insertText avoids auto-closing brackets/quotes). */
async function setEditor(page: Page, text: string) {
  const editor = page.getByTestId('code-SQL editor');
  await editor.click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('Delete');
  await page.keyboard.insertText(text);
}

test('SQL Workbench: connect, browse, query, guard writes, audit and save a DB test (Phase 6)', async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  await request.post(`${CLINIC}/api/reset`);
  await page.goto('/');
  const app = await sfApi<{ id: string }>(page, 'POST', '/api/applications', {
    name: 'Clinic DB',
    slug: 'clinic-db',
  });
  await sfApi(page, 'POST', `/api/applications/${app.id}/environments`, { name: 'Local', baseUrl: CLINIC });
  await sfApi(page, 'POST', `/api/applications/${app.id}/modules`, { name: 'Data integrity' });
  await page.evaluate((id) => localStorage.setItem('stepforge.currentApp', id), app.id);

  // Add the connection on the application's Databases tab, testing it first
  await page.goto(`/applications/${app.id}`);
  await page.getByRole('tab', { name: 'Databases' }).click();
  await expect(page.getByText('No database connections')).toBeVisible();
  await page.getByRole('button', { name: 'Add connection' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'New database connection' });
  await dialog.getByLabel('Name').fill('clinic');
  await dialog.getByLabel('Database file').fill(CLINIC_DB);
  await expect(dialog.getByRole('switch', { name: 'Read-only' })).toHaveAttribute('aria-checked', 'true');
  await expect(dialog.getByRole('switch', { name: 'Rollback mode' })).toHaveAttribute('aria-checked', 'true');
  await dialog.getByRole('button', { name: 'Test connection' }).click();
  await expect(dialog.getByRole('status')).toContainText('Connected to the SQLite file — 5 tables');
  await shot(page, 'db-connection');
  await dialog.getByRole('button', { name: 'Save connection' }).click();
  await expect(page.getByText('read-only', { exact: true })).toBeVisible();

  // Browse the schema and query a table
  await page.getByRole('button', { name: 'Open in workbench' }).click();
  await expect(page).toHaveURL(/\/sql\?connection=/);
  const schema = page.getByRole('list', { name: 'Schema' });
  await schema.getByRole('button', { name: 'Expand appointments' }).click();
  await expect(schema.getByText('patient_id')).toBeVisible();
  await schema.getByRole('button', { name: 'Query patients' }).click();
  await expect(page.getByTestId('code-SQL editor')).toContainText('SELECT * FROM patients LIMIT 100');
  await page.getByRole('button', { name: 'Run query' }).click();
  await expect(page.getByTestId('query-status')).toContainText('4 rows');
  await expect(page.getByTestId('results-grid')).toContainText('Ana Lopez');
  await shot(page, 'sql-workbench');

  // Writes are blocked on a read-only connection
  await setEditor(page, 'DELETE FROM appointments');
  await page.keyboard.press('ControlOrMeta+Enter');
  await expect(page.getByRole('alert').filter({ hasText: 'read-only' })).toBeVisible();

  // Save a query as a DB test with suggested assertions
  await setEditor(page, 'SELECT COUNT(*) AS n FROM appointments');
  await page.keyboard.press('ControlOrMeta+Enter');
  await expect(page.getByTestId('query-status')).toContainText('1 row');
  await page.getByRole('button', { name: 'Save as DB test' }).click();
  const save = page.getByRole('dialog', { name: 'Save as DB test' });
  await expect(save.getByLabel('Assertion 1 target')).toHaveValue('value');
  await expect(save.getByLabel('Assertion 1 expected')).toHaveValue('2');
  await save.getByLabel('Test name').fill('Two appointments are booked');
  await save.getByRole('button', { name: 'Save test' }).click();
  await expect(page).toHaveURL(/\/explorer\?scenario=/);
  await expect(
    page.getByRole('button', { name: /query SELECT COUNT\(\*\) AS n FROM appointments/ }),
  ).toBeVisible();

  // Audit: clean, then orphans appear after a patient is deleted through the API
  await page.goto('/sql');
  await page.getByRole('tab', { name: 'Data quality audit' }).click();
  await page.getByRole('button', { name: 'Run audit' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'No issues found' })).toBeVisible();
  const login = await request.post(`${CLINIC}/api/auth/login`, {
    data: { email: 'admin@careclinic.test', password: 'Admin123!' },
  });
  const { token } = (await login.json()) as { token: string };
  await request.delete(`${CLINIC}/api/patients/1`, { headers: { authorization: `Bearer ${token}` } });
  await page.getByRole('button', { name: 'Run audit' }).click();
  const finding = page.getByTestId('audit-finding');
  await expect(finding).toContainText('1 row in appointments points to a missing patients');
  await expect(finding).toContainText('inferred from the column name');
  await shot(page, 'db-audit');
  await finding.getByRole('button', { name: 'Open query' }).click();
  await expect(page.getByTestId('code-SQL editor')).toContainText('NOT EXISTS');
  await page.getByRole('button', { name: 'Run query' }).click();
  await expect(page.getByTestId('query-status')).toContainText('1 row');

  await request.post(`${CLINIC}/api/reset`);
});
