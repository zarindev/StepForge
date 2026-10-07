import { DEFAULT_RUN_OPTIONS, newId, runTestCase } from '@stepforge/core';
import { createClinicApp } from '@stepforge/demo-clinic';
import { BrowserPool, createUiExecutor } from '@stepforge/executor-ui';
import { utilExecutor } from '@stepforge/executor-util';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { networkToApiSteps, pathTemplate, RecordingSession } from '../src/index.ts';

const clinic = createClinicApp({ dbFile: ':memory:' });
let base = '';
const pool = new BrowserPool();

beforeAll(async () => {
  await clinic.listen({ host: '127.0.0.1', port: 0 });
  base = `http://127.0.0.1:${(clinic.server.address() as { port: number }).port}`;
});
afterAll(async () => {
  await pool.closeAll();
  await clinic.close();
});

const settle = () => new Promise((r) => setTimeout(r, 350));

describe('recorder', () => {
  it('records a login + booking flow (with assert, extract, auto-masked password, network) and replays it', async () => {
    const session = await RecordingSession.start({
      startUrl: `${base}/login`,
      baseUrl: base,
      headless: true,
    });
    const page = session.page;
    try {
      await page.getByLabel('Email').fill('reception@careclinic.test');
      await page.getByLabel('Password').fill('Reception123!');
      await page.getByRole('button', { name: 'Sign in' }).click();
      await page.waitForURL(`${base}/`);
      await page.locator('#next-appointments li').first().waitFor();
      // Assert mode from the toolbar (Shadow DOM): check the signed-in user name
      await page.locator('stepforge-recorder').getByRole('button', { name: 'Assert' }).click();
      await page.locator('#current-user').click();
      await page
        .locator('stepforge-recorder')
        .getByRole('button', { name: /^text is/ })
        .click();
      await page.getByTestId('nav-appointments').click();
      await page.waitForURL(/appointments$/);
      await page.getByTestId('new-appointment').click();
      await page.waitForURL(/appointments\/new/);
      await page.getByLabel('Patient').selectOption({ label: 'Chloe Nguyen (PAT-1003)' });
      await page.getByLabel('Doctor').selectOption({ label: 'Dr. Mei Lin · Pediatrics' });
      await page.getByLabel('Date').fill('2026-12-15');
      await page.getByLabel('Time').selectOption('14:30');
      await page.getByLabel('Reason for visit').fill('Vaccination');
      await page.getByTestId('book-appointment').click();
      await page.waitForURL(/flash=/);
      // Extract mode: save the flash text
      await page.locator('stepforge-recorder').getByRole('button', { name: 'Extract' }).click();
      await page.getByTestId('flash').click();
      await page
        .locator('stepforge-recorder')
        .getByPlaceholder(/Variable name/)
        .fill('confirmation');
      await page.locator('stepforge-recorder').getByRole('button', { name: 'Save as variable' }).click();
      await settle();
    } finally {
      await session.stop();
    }

    const steps = session.snapshot().steps;
    const types = steps.map((s) => s.type);
    expect(types).toEqual([
      'ui.navigate',
      'ui.fill',
      'ui.fill',
      'ui.click',
      'ui.assert',
      'ui.click',
      'ui.click',
      'ui.select',
      'ui.select',
      'ui.fill',
      'ui.select',
      'ui.fill',
      'ui.click',
      'ui.extract',
    ]);
    expect(steps[0]!.params).toEqual({ url: '/login' });
    // Password auto-masked into a secret; value kept server-side only
    expect(steps[2]!.params).toEqual({ value: '{{secret.password}}' });
    expect(session.secrets).toEqual({ password: 'Reception123!' });
    // Locator ranking: test id first when present, then role/label
    expect(steps[3]!.locators![0]).toEqual({ strategy: 'testId', value: 'login-submit' });
    expect(steps[3]!.locators!.some((l) => l.strategy === 'role' && l.name === 'Sign in')).toBe(true);
    expect(steps[1]!.locators![0]).toMatchObject({ strategy: 'role', value: 'textbox', name: 'Email' });
    expect(steps[4]!.params).toEqual({ check: 'text', expected: 'Riley Reception' });
    expect(steps[7]!.params).toEqual({ label: 'Chloe Nguyen (PAT-1003)' });
    expect(steps[13]).toMatchObject({ captureAs: 'confirmation', params: { from: 'text' } });
    // Network capture saw the dashboard's fetch
    const net = session.snapshot().network;
    expect(
      net.some((n) => n.method === 'GET' && n.url.endsWith('/api/appointments') && n.status === 200),
    ).toBe(true);
    const api = networkToApiSteps(net, base);
    expect(api[0]).toMatchObject({
      type: 'api.request',
      params: { method: 'GET', url: '{{env.baseUrl}}/api/appointments' },
    });

    // Replay the recording with the real engine on fresh demo data: must pass
    await clinic.inject({ method: 'POST', url: '/api/reset' });
    const result = await runTestCase({
      runId: 'replay',
      steps: steps.map(({ id: _id, describe: _d, ...s }) => ({
        enabled: true,
        continueOnFail: false,
        retries: 0,
        params: {},
        locators: [],
        assertions: [],
        ...s,
        id: newId(),
      })),
      secrets: session.secrets,
      env: { baseUrl: base },
      executors: [createUiExecutor(pool), utilExecutor],
      options: {
        ...DEFAULT_RUN_OPTIONS,
        baseUrl: base,
        video: 'off',
        trace: 'off',
        screenshots: 'off',
        defaultTimeoutMs: 5000,
      },
      artifactsDir: mkdtempSync(join(tmpdir(), 'sf-replay-')),
    });
    expect(
      result.steps.filter((s) => s.status !== 'passed').map((s) => `${s.path} ${s.type}: ${s.message}`),
    ).toEqual([]);
    expect(result.vars.confirmation).toBe('Appointment booked');
  }, 90_000);

  it('records typed navigations, undo, pause and dialogs', async () => {
    const session = await RecordingSession.start({
      startUrl: `${base}/login`,
      baseUrl: base,
      headless: true,
    });
    const page = session.page;
    try {
      await page.goto(`${base}/login?from=typed`); // typed navigation (not caused by an action)
      await page.getByLabel('Email').fill('x@y.z');
      await settle();
      await page.locator('stepforge-recorder').getByRole('button', { name: 'Undo' }).click();
      await page.locator('stepforge-recorder').getByRole('button', { name: 'Pause' }).click();
      await settle();
      await page.getByLabel('Email').fill('ignored@y.z');
      await page.locator('stepforge-recorder').getByRole('button', { name: 'Resume' }).click();
      await settle();
      await page.evaluate(`(() => {
        const b = document.createElement('button');
        b.textContent = 'Confirm me';
        b.onclick = () => { if (confirm('Sure?')) b.textContent = 'Confirmed'; };
        document.body.appendChild(b);
      })()`);
      await page.getByRole('button', { name: 'Confirm me' }).click();
      await expect.poll(() => page.getByRole('button', { name: 'Confirmed' }).count()).toBe(1);
      await settle();
    } finally {
      await session.stop();
    }
    const types = session.snapshot().steps.map((s) => s.type);
    expect(types).toEqual(['ui.navigate', 'ui.navigate', 'ui.handleDialog', 'ui.click']);
    expect(session.snapshot().steps[1]!.params).toEqual({ url: '/login?from=typed' });
  }, 60_000);

  it('keeps the toolbar off the top navigation, and it can be dragged away', async () => {
    const session = await RecordingSession.start({
      startUrl: `${base}/login`,
      baseUrl: base,
      headless: true,
    });
    const page = session.page;
    try {
      await page.getByLabel('Email').fill('reception@careclinic.test');
      await page.getByLabel('Password').fill('Reception123!');
      await page.getByRole('button', { name: 'Sign in' }).click();
      await page.waitForURL(`${base}/`);
      const toolbar = page.locator('stepforge-recorder');
      const viewport = page.viewportSize()!;
      const before = (await toolbar.boundingBox())!;
      expect(before.y).toBeGreaterThan(viewport.height / 2); // docked at the bottom
      // The navigation is clickable while recording (the toolbar used to cover it at the top)
      await page.getByTestId('nav-appointments').click({ timeout: 5_000 });
      await page.waitForURL(`${base}/appointments`);

      const grip = (await toolbar.getByTitle('Drag to move the toolbar').boundingBox())!;
      await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
      await page.mouse.down();
      await page.mouse.move(40, 200, { steps: 5 });
      await page.mouse.up();
      const after = (await toolbar.boundingBox())!;
      expect(after.y).toBeLessThan(viewport.height / 2);
      expect(after.x).toBeLessThan(before.x);
      await settle();
      // Dragging is not recorded as a step
      expect(session.snapshot().steps.map((x) => x.type)).not.toContain('ui.drag');
      expect(session.snapshot().steps.at(-1)).toMatchObject({ type: 'ui.click' });
    } finally {
      await session.stop();
    }
  });

  it('templates id-like path segments for API dedupe', () => {
    expect(pathTemplate('/api/patients/42/notes')).toBe('/api/patients/{id}/notes');
    expect(pathTemplate('/api/x/3f2b8c1e-1a2b-4c3d-8e9f-0a1b2c3d4e5f')).toBe('/api/x/{id}');
    const steps = networkToApiSteps(
      [
        {
          id: 1,
          method: 'GET',
          url: 'http://a.test/api/p/1',
          status: 200,
          contentType: 'application/json',
          requestHeaders: { authorization: 'Bearer abc' },
          at: 0,
        },
        {
          id: 2,
          method: 'GET',
          url: 'http://a.test/api/p/2',
          status: 200,
          contentType: 'application/json',
          requestHeaders: {},
          at: 0,
        },
        {
          id: 3,
          method: 'POST',
          url: 'http://a.test/api/p',
          status: 201,
          contentType: '',
          requestHeaders: { 'content-type': 'application/json' },
          requestBody: { a: 1 },
          at: 0,
        },
        {
          id: 4,
          method: 'GET',
          url: 'https://www.google-analytics.com/collect',
          status: 200,
          contentType: '',
          requestHeaders: {},
          at: 0,
        },
      ],
      'http://a.test',
    );
    expect(steps.map((s) => s.label)).toEqual(['GET /api/p/{id}', 'POST /api/p']);
    expect(steps[0]!.params).toMatchObject({ headers: { authorization: 'Bearer {{secret.apiToken}}' } });
    expect(steps[1]!.params).toMatchObject({ body: { a: 1 } });
  });
});
