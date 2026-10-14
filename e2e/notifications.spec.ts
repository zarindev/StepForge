import { expect, test, type Page } from '@playwright/test';

const shots = process.env.STEPFORGE_SHOTS;
const shot = async (page: Page, name: string) => {
  if (shots) await page.screenshot({ path: `${shots}/${name}.png` });
};

test('notifications: add Microsoft Teams and Slack channels from Settings; the webhook URL is never shown again', async ({
  page,
}) => {
  await page.goto('/settings');
  const unique = Date.now().toString(36);

  await page.getByRole('button', { name: 'Teams', exact: true }).click();
  let dialog = page.getByRole('dialog', { name: 'Add Microsoft Teams' });
  await expect(dialog).toContainText('Post to a channel when a webhook request is received');
  await dialog.getByLabel('Channel name').fill(`QA Teams ${unique}`);
  await dialog.getByLabel('Webhook URL').fill('https://example.invalid/workflows/abc?sig=SECRET-SIG');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Notification channel saved')).toBeVisible();

  await page.getByRole('button', { name: 'Slack / Mattermost' }).click();
  dialog = page.getByRole('dialog', { name: 'Add Slack, Mattermost or Rocket.Chat' });
  await dialog.getByLabel('Channel name').fill(`QA Mattermost ${unique}`);
  await dialog.getByLabel('Chat app').selectOption('mattermost');
  await dialog.getByLabel('Mention on failure').fill('@channel');
  await dialog.getByLabel('Webhook URL').fill('https://example.invalid/hooks/SECRET-HOOK');
  await dialog.getByRole('button', { name: 'Save' }).click();

  const list = page.getByTestId('notify-channels');
  await expect(list).toContainText(`QA Teams ${unique}`);
  await expect(list).toContainText('Microsoft Teams workflow');
  await expect(list).toContainText('Mattermost webhook');
  await expect(page.locator('body')).not.toContainText('SECRET-SIG');
  await shot(page, 'notifications');

  // Editing keeps the stored URL when the field is left empty.
  await page.getByRole('button', { name: `Edit QA Mattermost ${unique}` }).click();
  dialog = page.getByRole('dialog', { name: `Edit QA Mattermost ${unique}` });
  await expect(dialog.getByLabel('Webhook URL')).toHaveValue('');
  await expect(dialog.getByLabel('Chat app')).toHaveValue('mattermost');
  await expect(dialog.getByRole('button', { name: 'Save' })).toBeEnabled();
});
