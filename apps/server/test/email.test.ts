import { createClinicApp } from '@stepforge/demo-clinic';
import { schema } from '@stepforge/db';
import { mailpitBinary } from '@stepforge/email';
import type { FastifyInstance } from 'fastify';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AppContext } from '../src/context.ts';
import { H, testServer } from './helpers.ts';

// Mailpit comes from `npm run mailpit:install` (setup/CI); without it this suite is skipped.
const BIN_DIR = resolve(import.meta.dirname, '../../../data/bin');
const hasMailpit = existsSync(mailpitBinary(BIN_DIR));

const freePort = () =>
  new Promise<number>((r) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => r(port));
    });
  });

let app: FastifyInstance;
let ctx: AppContext;
let clinic: ReturnType<typeof createClinicApp>;
let appId = '';
let envId = '';
let moduleId = '';

async function call(method: string, url: string, payload?: unknown) {
  return app.inject({
    method: method as 'GET',
    url,
    headers: H,
    ...(payload !== undefined && { payload: payload as object }),
  });
}
async function ok<T = Record<string, unknown> & { id: string }>(
  method: string,
  url: string,
  payload?: unknown,
): Promise<T> {
  const res = await call(method, url, payload);
  if (res.statusCode >= 300) throw new Error(`${method} ${url} → ${res.statusCode}: ${res.body}`);
  return (res.body ? res.json() : undefined) as T;
}

describe.skipIf(!hasMailpit)('email testing with Mailpit', () => {
  beforeAll(async () => {
    const mailpit = { httpPort: await freePort(), smtpPort: await freePort() };
    ({ app, ctx } = await testServer({ binDir: BIN_DIR, mailpit }));
    clinic = createClinicApp({ dbFile: ':memory:', smtp: { host: '127.0.0.1', port: mailpit.smtpPort } });
    await clinic.listen({ host: '127.0.0.1', port: 0 });
    const clinicUrl = `http://127.0.0.1:${(clinic.server.address() as { port: number }).port}`;
    appId = (await ok('POST', '/api/applications', { name: 'CareClinic', slug: 'careclinic' })).id;
    envId = (
      await ok('POST', `/api/applications/${appId}/environments`, { name: 'Local', baseUrl: clinicUrl })
    ).id;
    moduleId = (await ok('POST', `/api/applications/${appId}/modules`, { name: 'Accounts' })).id;
  }, 30_000);
  afterAll(async () => {
    await app.close(); // also stops Mailpit
    await clinic.close();
  });

  it('controls the local Mailpit from the API', async () => {
    expect(await ok('GET', '/api/email/mailpit')).toMatchObject({
      installed: true,
      running: false,
      autostart: false,
    });
    const started = await ok<{ running: boolean; version: string; url: string }>(
      'POST',
      '/api/email/mailpit/start',
    );
    expect(started).toMatchObject({ running: true, version: 'v1.31.4' });
    expect(await ok('PUT', '/api/email/mailpit/autostart', { enabled: true })).toEqual({ autostart: true });
    expect((await ok('GET', '/api/email/mailpit')).autostart).toBe(true);
    expect(await ok('GET', '/api/inboxes/local/messages')).toEqual([]);
  });

  it('manages inboxes without ever returning the IMAP password', async () => {
    const local = await ok('POST', `/api/applications/${appId}/inboxes`, {
      name: 'Local mail',
      kind: 'mailpit',
    });
    expect(await ok('POST', `/api/inboxes/${local.id}/test`)).toMatchObject({
      ok: true,
      message: expect.stringMatching(/^Mailpit v1\.31\.4/),
    });

    const gmail = await ok<Record<string, unknown> & { id: string }>(
      'POST',
      `/api/applications/${appId}/inboxes`,
      {
        name: 'Gmail',
        kind: 'imap',
        config: { host: '127.0.0.1', port: await freePort(), secure: false, user: 'qa@gmail.test' },
        password: 'app-password-123',
      },
    );
    expect(gmail).toMatchObject({ hasPassword: true, config: { user: 'qa@gmail.test' } });
    expect(JSON.stringify(await ok('GET', `/api/applications/${appId}/inboxes`))).not.toContain(
      'app-password-123',
    );
    expect(JSON.stringify(ctx.db.select().from(schema.secrets).all())).not.toContain('app-password-123');
    const unreachable = await ok<{ ok: boolean; message: string }>('POST', `/api/inboxes/${gmail.id}/test`);
    expect(unreachable.ok).toBe(false);
    expect(unreachable.message).toMatch(/Cannot connect to IMAP 127\.0\.0\.1/);
    // Drafts are tested before saving; a missing host is a clear failure, not a server error.
    expect(
      await ok('POST', `/api/applications/${appId}/inboxes/test`, { name: 'x', kind: 'imap', config: {} }),
    ).toEqual({
      ok: false,
      message: 'IMAP needs a host and a user name',
    });
    expect(
      (await call('POST', `/api/applications/${appId}/inboxes`, { name: 'Gmail', kind: 'mailpit' }))
        .statusCode,
    ).toBe(409);
    const before = ctx.db.select().from(schema.secrets).all().length;
    await ok('DELETE', `/api/inboxes/${gmail.id}`);
    expect(ctx.db.select().from(schema.secrets).all().length).toBe(before - 1);
  });

  it('signs up on CareClinic, reads the OTP from the email, verifies and logs in (done-when)', async () => {
    const steps = [
      { type: 'util.setVariable', params: { name: 'email', value: 'new.hire+{{run.id}}@example.test' } },
      { type: 'ui.navigate', params: { url: '/signup' } },
      {
        type: 'ui.fill',
        params: { value: 'Nora New' },
        locators: [{ strategy: 'label', value: 'Full name' }],
      },
      {
        type: 'ui.fill',
        params: { value: '{{vars.email}}' },
        locators: [{ strategy: 'label', value: 'Email' }],
      },
      {
        type: 'ui.fill',
        params: { value: 'Welcome123!' },
        locators: [{ strategy: 'label', value: 'Password' }],
      },
      { type: 'ui.click', locators: [{ strategy: 'role', value: 'button', name: 'Create account' }] },
      {
        type: 'email.waitForEmail',
        params: { to: '{{vars.email}}', subject: 'Verify your CareClinic account', timeoutMs: 20_000 },
      },
      {
        type: 'email.assertEmail',
        params: {
          from: 'no-reply@careclinic.test',
          bodyContains: 'expires in 10 minutes',
          hasLink: '/verify',
        },
      },
      { type: 'email.extractFromEmail', params: { kind: 'otp' }, captureAs: 'otp' },
      {
        type: 'ui.fill',
        params: { value: '{{vars.otp}}' },
        locators: [{ strategy: 'label', value: 'Verification code' }],
      },
      { type: 'ui.click', locators: [{ strategy: 'role', value: 'button', name: 'Verify email' }] },
      {
        type: 'ui.assert',
        params: { check: 'text', expected: 'Email verified. You can sign in now.' },
        locators: [{ strategy: 'testId', value: 'flash' }],
      },
      {
        type: 'ui.fill',
        params: { value: '{{vars.email}}' },
        locators: [{ strategy: 'label', value: 'Email' }],
      },
      {
        type: 'ui.fill',
        params: { value: 'Welcome123!' },
        locators: [{ strategy: 'testId', value: 'password' }],
      },
      { type: 'ui.click', locators: [{ strategy: 'role', value: 'button', name: 'Sign in' }] },
      {
        type: 'ui.assert',
        params: { check: 'textContains', expected: 'Nora New' },
        locators: [{ strategy: 'css', value: '#current-user' }],
      },
    ];
    const s = await ok<{ id: string }>('POST', `/api/modules/${moduleId}/scenarios`, {
      name: 'Sign up with email OTP',
      steps,
    });
    const run = await ok<{ id: string }>('POST', '/api/runs', {
      applicationId: appId,
      environmentId: envId,
      scope: { type: 'scenarios', ids: [s.id] },
    });
    await ctx.runs.idle();
    const done = await ok<{ items: { id: string; status: string; errorMessage: string | null }[] }>(
      'GET',
      `/api/runs/${run.id}`,
    );
    expect(done.items[0]!.errorMessage).toBeNull();
    expect(done.items[0]!.status).toBe('passed');

    const item = await ok<{
      steps: {
        type: string;
        message: string | null;
        responseJson: { email?: { subject: string; html: string } };
      }[];
      artifacts: { kind: string }[];
    }>('GET', `/api/run-items/${done.items[0]!.id}`);
    const wait = item.steps.find((x) => x.type === 'email.waitForEmail')!;
    expect(wait.message).toMatch(/^Received "Verify your CareClinic account" from no-reply@careclinic\.test/);
    expect(wait.responseJson.email?.html).toContain('Your verification code is');
    expect(item.steps.find((x) => x.type === 'email.extractFromEmail')!.message).toMatch(
      /^Extracted code \d{6}$/,
    );
    expect(item.artifacts.map((a) => a.kind)).toContain('email');

    // The same email is visible in the inbox viewer.
    const list = await ok<{ id: string; subject: string; to: string[] }[]>(
      'GET',
      '/api/inboxes/local/messages',
    );
    expect(list[0]).toMatchObject({
      subject: 'Verify your CareClinic account',
      to: [expect.stringMatching(/^new\.hire\+/)],
    });
    const full = await ok<{ links: string[] }>('GET', `/api/inboxes/local/messages/${list[0]!.id}`);
    expect(full.links[0]).toMatch(/\/verify\?email=.*&code=\d{6}$/);
    expect((await call('DELETE', '/api/inboxes/local/messages')).statusCode).toBe(204);
    expect(await ok('GET', '/api/inboxes/local/messages')).toEqual([]);
  }, 90_000);

  it('fails clearly when the email never comes', async () => {
    const s = await ok<{ id: string }>('POST', `/api/modules/${moduleId}/scenarios`, {
      name: 'No email',
      steps: [{ type: 'email.waitForEmail', params: { to: 'ghost@example.test', timeoutMs: 1500 } }],
    });
    const run = await ok<{ id: string }>('POST', '/api/runs', {
      applicationId: appId,
      environmentId: envId,
      scope: { type: 'scenarios', ids: [s.id] },
    });
    await ctx.runs.idle();
    const done = await ok<{ items: { status: string; errorMessage: string }[] }>(
      'GET',
      `/api/runs/${run.id}`,
    );
    expect(done.items[0]).toMatchObject({ status: 'failed' });
    expect(done.items[0]!.errorMessage).toMatch(
      /No email to ghost@example\.test arrived within 1 s after the test started/,
    );
  });
});
