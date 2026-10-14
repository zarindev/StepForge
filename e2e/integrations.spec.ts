import { expect, test, type Page } from '@playwright/test';

const shots = process.env.STEPFORGE_SHOTS;
const shot = async (page: Page, name: string) => {
  if (shots) await page.screenshot({ path: `${shots}/${name}.png` });
};

const CLINIC = 'http://127.0.0.1:8191';

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

test('SOAP, Kafka and FTP steps: plain English and their fields in the editor', async ({ page }) => {
  await page.goto('/');
  const app = await sfApi<{ id: string }>(page, 'POST', '/api/applications', {
    name: 'Clinic Integrations',
    slug: `clinic-integrations-${Date.now().toString(36)}`, // unique: a CI retry must not collide
  });
  await sfApi(page, 'POST', `/api/applications/${app.id}/environments`, { name: 'Local', baseUrl: CLINIC });
  const mod = await sfApi<{ id: string }>(page, 'POST', `/api/applications/${app.id}/modules`, {
    name: 'Billing',
  });
  const s = await sfApi<{ id: string }>(page, 'POST', `/api/modules/${mod.id}/scenarios`, {
    name: 'Invoice flows through every system',
    steps: [
      {
        type: 'api.soap',
        params: { url: '/ws/prices', action: 'http://example.test/GetPrice', body: '<m:GetPrice/>' },
      },
      {
        type: 'api.kafkaConsume',
        params: { brokers: '{{env.kafkaBrokers}}', topic: 'invoices', path: '$.status', equals: 'sent' },
      },
      {
        type: 'api.ftp',
        params: {
          protocol: 'sftp',
          host: 'files.test',
          action: 'download',
          remotePath: '/outbox/invoice.pdf',
        },
      },
    ],
  });
  await page.evaluate((id) => localStorage.setItem('stepforge.currentApp', id), app.id);
  await page.goto(`/explorer?scenario=${s.id}`);
  await page.getByRole('tab', { name: 'Plain English' }).click();
  const plain = page.getByRole('list', { name: 'Plain English steps' });
  await expect(plain).toContainText('Call the SOAP service /ws/prices (GetPrice)');
  await expect(plain).toContainText('Wait for a Kafka message on invoices where $.status is "sent"');
  await expect(plain).toContainText('Download /outbox/invoice.pdf on SFTP files.test');
  await shot(page, 'integrations');

  await page.getByRole('tab', { name: 'List' }).click();
  await page.getByRole('button', { name: /^ftp/ }).click();
  await expect(page.getByLabel('Protocol')).toHaveValue('sftp');
  await expect(page.getByLabel('Local file')).toBeVisible(); // shown for download
  await page.getByLabel('Do', { exact: true }).selectOption('list');
  await expect(page.getByLabel('Local file')).toHaveCount(0);
});
