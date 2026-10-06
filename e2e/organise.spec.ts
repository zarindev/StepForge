import { expect, test, type Page } from '@playwright/test';

const shots = process.env.STEPFORGE_SHOTS;
const shot = async (page: Page, name: string) => {
  if (shots) await page.screenshot({ path: `${shots}/${name}.png` });
};

test.describe.serial('organise a test tree (Phase 2)', () => {
  test('applications, environments, secrets, tags, modules, scenarios, steps, test cases, history', async ({ page }) => {
    // ── create the application ──
    await page.goto('/applications');
    await page.getByRole('button', { name: /New application|Create your first application/ }).first().click();
    await page.getByPlaceholder('e.g. CareClinic').fill('CareClinic');
    await expect(page.locator('input.font-mono').first()).toHaveValue('careclinic'); // auto slug
    await page.getByRole('button', { name: 'Create application' }).click();
    await expect(page.getByRole('heading', { name: 'CareClinic', level: 1 })).toBeVisible();

    // ── environments ──
    await page.getByRole('button', { name: 'Add environment' }).first().click();
    await page.getByPlaceholder('Staging').fill('Local');
    const dialog = page.getByRole('dialog', { name: 'Add environment' });
    await dialog.locator('input.font-mono').fill('http://localhost:8101');
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('http://localhost:8101')).toBeVisible();

    await page.getByRole('button', { name: 'Add environment' }).click();
    await page.getByPlaceholder('Staging').fill('Production');
    const d2 = page.getByRole('dialog', { name: 'Add environment' });
    await d2.locator('input.font-mono').fill('https://clinic.example.com');
    await d2.getByRole('switch', { name: 'Production environment' }).click();
    await d2.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'production environment' })).toBeVisible();
    await shot(page, 'app-detail');

    // ── secrets ──
    await page.getByRole('tab', { name: 'Secrets' }).click();
    await page.getByRole('button', { name: 'Add secret' }).click();
    await page.getByLabel('Key').fill('adminPassword');
    await page.getByLabel('Value').fill('Sup3r-Secret!');
    await page.getByRole('button', { name: 'Save secret' }).click();
    await expect(page.getByText('{{secret.adminPassword}}')).toBeVisible();
    await expect(page.getByText('Sup3r-Secret!')).toHaveCount(0);

    // ── tags ──
    await page.getByRole('tab', { name: 'Tags' }).click();
    await page.getByLabel('Tag name').fill('smoke');
    await page.getByRole('button', { name: 'Add tag' }).click();
    await expect(page.getByText('#smoke')).toBeVisible();

    // ── Test Explorer: modules ──
    await page.getByRole('button', { name: 'Open test tree' }).click();
    await page.getByRole('button', { name: 'Create the first module' }).click();
    await page.getByPlaceholder('e.g. Patients').fill('Patients');
    await page.getByRole('button', { name: 'Create', exact: true }).click();
    const patients = page.getByRole('treeitem', { name: 'Patients' });
    await expect(patients).toBeVisible();

    await page.getByRole('button', { name: 'Actions for Patients' }).click();
    await page.getByRole('menuitem', { name: 'New sub-module' }).click();
    await page.getByPlaceholder('e.g. Patients').fill('Registration');
    await page.getByRole('button', { name: 'Create', exact: true }).click();
    await expect(page.getByRole('treeitem', { name: 'Registration' })).toBeVisible();

    await page.getByRole('button', { name: 'Module', exact: true }).click();
    await page.getByPlaceholder('e.g. Patients').fill('Appointments');
    await page.getByRole('button', { name: 'Create', exact: true }).click();

    // ── scenario + steps ──
    await page.getByRole('button', { name: 'Actions for Registration' }).click();
    await page.getByRole('menuitem', { name: 'New scenario' }).click();
    await page.getByPlaceholder('e.g. Register a new patient').fill('Register a new patient');
    await page.getByRole('button', { name: 'Create', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Register a new patient' })).toBeVisible();

    await page.getByLabel('New step type').selectOption('ui.navigate');
    await page.getByRole('button', { name: 'Add step' }).click();
    await page.getByLabel('New step type').selectOption('ui.fill');
    await page.getByRole('button', { name: 'Add step' }).click();
    await page.getByLabel('Label').fill('Type the patient name');
    await page.getByLabel('New step type').selectOption('db.query');
    await page.getByRole('button', { name: 'Add step' }).click();
    await page.getByRole('button', { name: 'Save steps' }).click();
    await expect(page.getByText('Saved steps · v2')).toBeVisible();
    await expect(page.getByText('hybrid', { exact: true })).toBeVisible();
    await shot(page, 'explorer-steps');

    // ── test case ──
    await page.getByRole('tab', { name: /Test cases/ }).click();
    await page.getByRole('button', { name: 'Add test case' }).first().click();
    await page.getByPlaceholder('Valid registration').fill('Valid patient');
    await page.getByLabel('Data (JSON object)').fill('{ "name": "Ana Lopez" }');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByRole('cell', { name: 'TC-REG-001', exact: true })).toBeVisible();

    // ── details + tags ──
    await page.getByRole('tab', { name: 'Details' }).click();
    await page.getByLabel('Priority').selectOption('P1');
    await page.getByRole('button', { name: 'Save details' }).click();
    await expect(page.getByText('Saved · v3')).toBeVisible();
    await page.getByRole('button', { name: '#smoke' }).click();
    await expect(page.getByRole('button', { name: '#smoke' })).toHaveAttribute('aria-pressed', 'true');

    // ── history: diff + restore ──
    await page.getByRole('tab', { name: 'History' }).click();
    await expect(page.getByText('Changes from v2 to v3')).toBeVisible();
    await page.getByRole('button', { name: /^v1/ }).click();
    await page.getByRole('button', { name: 'Restore v1' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Restore' }).click();
    await expect(page.getByText('Restored as v4')).toBeVisible();
    await expect(page.getByRole('tab', { name: /Steps/ })).toContainText('0');
    await shot(page, 'explorer-history');
  });

  test('search, drag-and-drop, bulk actions, filters and typed delete', async ({ page }) => {
    await page.goto('/explorer');
    // second scenario in Appointments
    await page.getByRole('button', { name: 'Actions for Appointments' }).click();
    await page.getByRole('menuitem', { name: 'New scenario' }).click();
    await page.getByPlaceholder('e.g. Register a new patient').fill('Book appointment');
    await page.getByRole('button', { name: 'Create', exact: true }).click();

    // Ctrl+K finds scenarios and test cases
    await page.keyboard.press('Control+k');
    await page.keyboard.type('TC-REG');
    await expect(page.getByRole('option', { name: /TC-REG-001/ })).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { name: 'Register a new patient' })).toBeVisible();
    await expect(page).toHaveURL(/tab=testCases/);

    // drag "Book appointment" into Patients
    await page.getByRole('treeitem', { name: 'Book appointment' }).locator('div').first().dragTo(
      page.getByRole('treeitem', { name: 'Patients' }).locator('div').first(),
    );
    await expect(page.getByText('Scenario moved')).toBeVisible();

    // bulk: select both, add tag
    await page.getByLabel('Select Register a new patient').check();
    await page.getByLabel('Select Book appointment').check();
    await expect(page.getByRole('toolbar', { name: 'Bulk actions' })).toContainText('2 selected');
    await page.getByLabel('Add tag to selected').selectOption({ label: '#smoke' });
    await expect(page.getByText('Tagged 2 scenario(s)')).toBeVisible();

    // tree search matches test-case codes; the layer filter hides non-matching scenarios
    await page.getByLabel('Search the test tree').fill('TC-REG');
    await expect(page.getByRole('treeitem', { name: 'Register a new patient' })).toBeVisible();
    await expect(page.getByRole('treeitem', { name: 'Book appointment' })).toHaveCount(0);
    await page.getByLabel('Search the test tree').fill('');
    await page.getByRole('button', { name: 'Filters' }).click();
    await page.getByLabel('Filter by layer').selectOption('api');
    await expect(page.getByText('Nothing matches these filters.')).toBeVisible();
    await page.getByRole('button', { name: 'Clear filters' }).click();
    await expect(page.getByRole('treeitem', { name: 'Book appointment' })).toBeVisible();
    await shot(page, 'explorer-tree');

    // delete application requires typing its name
    await page.goto('/applications');
    await page.getByRole('link', { name: /CareClinic/ }).click();
    await page.getByRole('tab', { name: 'Settings' }).click();
    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    const confirm = page.getByRole('dialog', { name: 'Delete CareClinic?' });
    await expect(confirm.getByRole('button', { name: 'Delete' })).toBeDisabled();
    await confirm.getByLabel('Confirmation text').fill('CareClinic');
    await confirm.getByRole('button', { name: 'Delete' }).click();
    await expect(page.getByText('No applications yet')).toBeVisible();
  });
});
