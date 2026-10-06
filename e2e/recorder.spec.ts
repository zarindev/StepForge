import { chromium, expect, test, type Page } from '@playwright/test';

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

test.describe.serial('recorder and scenario editor (Phase 4)', () => {
  test('records a login + booking flow on CareClinic, saves it and replays it green', async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000);
    await request.post(`${CLINIC}/api/reset`);
    await page.goto('/');
    const app = await sfApi<{ id: string }>(page, 'POST', '/api/applications', {
      name: 'Clinic Recorded',
      slug: 'clinic-recorded',
    });
    await sfApi(page, 'POST', `/api/applications/${app.id}/environments`, { name: 'Local', baseUrl: CLINIC });
    await sfApi(page, 'POST', `/api/applications/${app.id}/modules`, { name: 'Appointments' });
    await page.evaluate((id) => localStorage.setItem('stepforge.currentApp', id), app.id);

    // Start recording from the dashboard
    await page.goto('/recorder');
    await page.getByLabel('Start page').fill('/login');
    await page.getByRole('button', { name: 'Start recording' }).click();
    await expect(page.getByText('Recording', { exact: true })).toBeVisible({ timeout: 20_000 });

    // Drive the recording browser (launched by the server) over CDP, like a user would
    const browser = await chromium.connectOverCDP('http://127.0.0.1:9333');
    const rec = browser
      .contexts()
      .flatMap((c) => c.pages())
      .find((p) => p.url().includes('/login'))!;
    expect(rec).toBeTruthy();
    await rec.locator('stepforge-recorder').getByRole('button', { name: 'Stop' }).waitFor(); // toolbar injected
    await rec.getByLabel('Email').fill('reception@careclinic.test');
    await rec.getByLabel('Password').fill('Reception123!');
    await rec.getByRole('button', { name: 'Sign in' }).click();
    await rec.waitForURL(`${CLINIC}/`);
    await rec.locator('stepforge-recorder').getByRole('button', { name: 'Assert' }).click();
    await rec.locator('#current-user').click();
    await rec
      .locator('stepforge-recorder')
      .getByRole('button', { name: /^text is/ })
      .click();
    await rec.getByTestId('nav-appointments').click();
    await rec.getByTestId('new-appointment').click();
    await rec.getByLabel('Patient').selectOption({ label: 'Ben Carter (PAT-1002)' });
    await rec.getByLabel('Doctor').selectOption({ label: 'Dr. Omar Haddad · Cardiology' });
    await rec.getByLabel('Date').fill('2026-12-20');
    await rec.getByLabel('Reason for visit').fill('Follow-up');
    await rec.getByTestId('book-appointment').click();
    await rec.waitForURL(/flash=/);
    await rec.locator('stepforge-recorder').getByRole('button', { name: 'Assert' }).click();
    await rec.getByTestId('flash').click();
    await rec
      .locator('stepforge-recorder')
      .getByRole('button', { name: /^text is/ })
      .click();

    // The dashboard follows live
    const live = page.getByRole('list', { name: 'Recorded steps' });
    await expect(live.getByRole('listitem')).toHaveCount(13, { timeout: 10_000 });
    await expect(page.getByText('{{secret.password}}').first()).toBeVisible();
    await expect(page.getByText(/API call\(s\) captured/)).toContainText(/[1-9]/);
    await shot(page, 'recorder-live');
    await page.getByRole('button', { name: 'Stop & review' }).click();
    await browser.close().catch(() => {});

    // Review and save
    await expect(page.getByText('Review 13 recorded steps')).toBeVisible();
    await page.getByLabel('Scenario name').fill('Receptionist books an appointment (recorded)');
    await shot(page, 'recorder-review');
    await page.getByRole('button', { name: 'Save scenario' }).click();
    await expect(page).toHaveURL(/\/explorer\?scenario=/);
    await expect(
      page.getByRole('heading', { name: 'Receptionist books an appointment (recorded)' }),
    ).toBeVisible();

    // Plain English and flow views
    await page.getByRole('tab', { name: 'Plain English' }).click();
    const plain = page.getByRole('list', { name: 'Plain English steps' });
    await expect(plain).toContainText('Type "{{secret.password}}" into');
    await expect(plain).toContainText('Click the "Sign in" button');
    await expect(plain).toContainText('Check that "Riley Reception" is shown');
    await expect(plain).toContainText(
      'Check that the "Appointment booked" status message reads "Appointment booked"',
    );
    await page.getByRole('tab', { name: 'Flow' }).click();
    await expect(page.getByTestId('flow-view').locator('.react-flow__node')).toHaveCount(13);
    await shot(page, 'editor-flow');
    await page.getByRole('tab', { name: 'List' }).click();
    await page
      .getByRole('list', { name: 'Steps' })
      .getByRole('button', { name: /login-submit|Sign in/ })
      .first()
      .click();
    await expect(page.getByRole('group', { name: 'Locators' })).toBeVisible();
    await shot(page, 'editor-step-form');

    // Replay on fresh demo data
    await request.post(`${CLINIC}/api/reset`);
    await page.getByTitle('Run this scenario').click();
    await page.getByRole('dialog', { name: 'Run tests' }).getByRole('button', { name: 'Start run' }).click();
    await expect(page.getByText('Passed', { exact: true }).first()).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole('list', { name: 'Step timeline' }).getByRole('listitem')).toHaveCount(13);
  });

  test('generate variants, blocks with useBlock, and move a module', async ({ page }) => {
    test.setTimeout(60_000);
    await page.goto('/');
    const app = await sfApi<{ id: string }>(page, 'POST', '/api/applications', {
      name: 'Editor Lab',
      slug: 'editor-lab',
    });
    const parent = await sfApi<{ id: string }>(page, 'POST', `/api/applications/${app.id}/modules`, {
      name: 'Accounts',
    });
    await sfApi(page, 'POST', `/api/applications/${app.id}/modules`, { name: 'Signup' });
    const s = await sfApi<{ id: string }>(page, 'POST', `/api/modules/${parent.id}/scenarios`, {
      name: 'Sign up',
      steps: [{ type: 'util.log', params: { message: 'hi' } }],
    });
    await sfApi(page, 'POST', `/api/scenarios/${s.id}/test-cases`, {
      title: 'Valid',
      data: { email: 'ana@example.test', age: 30 },
    });
    await page.evaluate((id) => localStorage.setItem('stepforge.currentApp', id), app.id);

    // Variants
    await page.goto(`/explorer?scenario=${s.id}&tab=testCases`);
    await page.getByRole('button', { name: 'Generate variants' }).click();
    const dialog = page.getByRole('dialog', { name: 'Generate variants' });
    await expect(dialog.getByRole('list', { name: 'Variants' })).toContainText('email: missing @');
    const count = await dialog.getByRole('list', { name: 'Variants' }).getByRole('listitem').count();
    await dialog.getByRole('button', { name: /Create \d+ test case/ }).click();
    await expect(page.getByText(`Created ${count} test case(s)`)).toBeVisible();
    await expect(page.getByRole('tab', { name: /Test cases/ })).toContainText(String(count + 1));

    // Move "Signup" under "Accounts" without drag and drop
    await page.getByRole('button', { name: 'Actions for Signup' }).click();
    await page.getByRole('menuitem', { name: 'Move to…' }).click();
    await page.getByLabel('New parent').selectOption({ label: 'Accounts' });
    await page.getByRole('button', { name: 'Move', exact: true }).click();
    await expect(page.getByText('Module moved')).toBeVisible();
    await expect(
      page.getByRole('treeitem', { name: 'Accounts' }).getByRole('treeitem', { name: 'Signup' }),
    ).toBeVisible();

    // Blocks tab + util.useBlock in a loop, edited in the typed form
    await page.goto(`/applications/${app.id}`);
    await page.getByRole('tab', { name: 'Blocks' }).click();
    await page.getByRole('button', { name: 'New block' }).click();
    await page.getByPlaceholder('Login as Admin').fill('Say hello');
    await page.getByRole('button', { name: 'Create', exact: true }).click();
    await page.getByLabel('New step type').selectOption('util.log');
    await page.getByRole('button', { name: 'Add step' }).click();
    await page.getByLabel('Message').fill('hello from block');
    await page.getByRole('button', { name: 'Save block' }).click();
    await expect(page.getByText('Block saved')).toBeVisible();

    await page.goto(`/explorer?scenario=${s.id}`);
    await page.getByLabel('New step type').selectOption('util.loop');
    await page.getByRole('button', { name: 'Add step' }).click();
    await page.getByLabel('Repeat N times').fill('2');
    await page.getByLabel('Nested step type').first().selectOption('util.useBlock');
    await page.getByRole('button', { name: 'Add nested step' }).first().click();
    await page.getByLabel('Block').selectOption({ label: 'Say hello (1 steps)' });
    await page.getByRole('button', { name: 'Save steps' }).click();
    await expect(page.getByText('Saved steps · v2')).toBeVisible();
    await page.getByRole('tab', { name: 'Plain English' }).click();
    await expect(page.getByRole('list', { name: 'Plain English steps' })).toContainText(
      /2\.1\.\s*Run a reusable block/,
    );
  });
});
