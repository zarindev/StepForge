import { expect, test } from '@playwright/test';

test.describe('dashboard shell', () => {
  test('loads the empty home dashboard', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Home', exact: true })).toBeVisible();
    // A fresh workspace shows the welcome panel; once runs exist, the dashboard (other specs may have run first).
    await expect(
      page.getByText('Welcome to StepForge').or(page.getByText('Pass/fail trend (30 days)')),
    ).toBeVisible();
    await expect(page.getByText('Applications', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('Local', { exact: true })).toBeVisible(); // live WebSocket connected
    await expect(page.getByText(/^v\d+\.\d+\.\d+$/)).toBeVisible(); // system info loaded
    await page.waitForTimeout(400); // let the KPI entrance animation finish before capturing
    if (process.env.STEPFORGE_SHOTS)
      await page.screenshot({ path: `${process.env.STEPFORGE_SHOTS}/home-dark.png` });
    expect(errors).toEqual([]);
  });

  test('rail navigation and placeholder pages', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('link', { name: 'Schedules' }).click();
    await expect(page).toHaveURL(/\/schedules$/);
    await expect(page.getByText('Schedules is coming in Phase 11')).toBeVisible();
    // deep links work through the SPA fallback
    await page.goto('/bugs');
    await expect(page.getByRole('heading', { name: 'Bugs', exact: true })).toBeVisible();
  });

  test('Ctrl+K command palette navigates', async ({ page }) => {
    await page.goto('/');
    await page.keyboard.press('Control+k');
    const dialog = page.getByRole('dialog', { name: 'Command palette' });
    await expect(dialog).toBeVisible();
    await page.keyboard.type('sql');
    if (process.env.STEPFORGE_SHOTS)
      await page.screenshot({ path: `${process.env.STEPFORGE_SHOTS}/palette.png` });
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/sql$/);
    await expect(dialog).toBeHidden();
  });

  test('? opens the shortcuts overlay', async ({ page }) => {
    await page.goto('/');
    await page.keyboard.press('Shift+?');
    await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeHidden();
  });

  test('theme setting persists across reloads', async ({ page }) => {
    await page.goto('/settings');
    await page.getByRole('radio', { name: 'Light' }).click();
    await expect(page.locator('html')).not.toHaveClass(/dark/);
    await page.reload();
    await expect(page.getByRole('radio', { name: 'Light' })).toHaveAttribute('aria-checked', 'true');
    await expect(page.locator('html')).not.toHaveClass(/dark/);
    if (process.env.STEPFORGE_SHOTS)
      await page.screenshot({ path: `${process.env.STEPFORGE_SHOTS}/settings-light.png` });
    await page.getByRole('radio', { name: 'Dark' }).click();
    await expect(page.locator('html')).toHaveClass(/dark/);
  });
});
