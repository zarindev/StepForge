import { DEFAULT_RUN_OPTIONS, newId, runTestCase, type StepInput } from '@stepforge/core';
import { extractLinks, type EmailMessage, type Mailbox } from '@stepforge/email';
import { mkdtempSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createEmailExecutor } from '../src/index.ts';

/** In-memory inbox; `deliver` simulates an email arriving later. */
class MemoryBox implements Mailbox {
  readonly kind = 'mailpit' as const;
  messages: EmailMessage[] = [];
  closed = false;
  deliver(m: Partial<EmailMessage>, delayMs = 0) {
    setTimeout(() => {
      const html = m.html ?? '';
      this.messages.unshift({
        id: newId(),
        from: 'noreply@app.test',
        fromName: 'App',
        to: [],
        cc: [],
        subject: '',
        date: new Date().toISOString(),
        text: '',
        html,
        links: extractLinks(html, m.text ?? ''),
        attachments: [],
        ...m,
      });
    }, delayMs);
  }
  async list() {
    return this.messages;
  }
  async get(id: string) {
    return this.messages.find((m) => m.id === id)!;
  }
  async check() {
    return 'memory';
  }
  async close() {
    this.closed = true;
  }
}

let site: Server;
let siteUrl = '';
beforeAll(async () => {
  site = createServer((req, res) => {
    if (req.url?.startsWith('/verify')) res.writeHead(302, { location: '/welcome' }).end();
    else res.writeHead(200, { 'content-type': 'text/html' }).end('<h1>Welcome, email verified</h1>');
  });
  await new Promise<void>((r) => site.listen(0, '127.0.0.1', r));
  siteUrl = `http://127.0.0.1:${(site.address() as { port: number }).port}`;
});
afterAll(() => site.close());

const steps = (...s: StepInput[]) =>
  s.map((x) => ({
    enabled: true,
    continueOnFail: false,
    retries: 0,
    params: {},
    locators: [],
    assertions: [],
    id: newId(),
    ...x,
  }));

async function run(box: MemoryBox, s: ReturnType<typeof steps>, inboxes: Record<string, Mailbox> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'sf-email-'));
  const r = await runTestCase({
    runId: 'R1',
    steps: s,
    executors: [
      createEmailExecutor({
        resolve: async (ref) => {
          if (!ref) return box;
          const b = inboxes[ref];
          if (!b) throw new Error(`No inbox named "${ref}"`);
          return b;
        },
      }),
    ],
    options: { ...DEFAULT_RUN_OPTIONS, defaultTimeoutMs: 3000 },
    artifactsDir: dir,
    data: { email: 'ana+R1@app.test' },
  });
  return { ...r, dir };
}

describe('email executor', () => {
  it('waits for the sign-up email, checks it, extracts the OTP and the link, and opens the link', async () => {
    const box = new MemoryBox();
    box.deliver({
      to: ['ana+R1@app.test'],
      subject: 'Old',
      text: 'code 000000',
      date: new Date(Date.now() - 60_000).toISOString(),
    });
    box.deliver(
      {
        to: ['ana+R1@app.test'],
        subject: 'Verify your CareClinic account',
        html: `<p>Your verification code is <b>482913</b></p><a href="${siteUrl}/verify?t=abc">Verify email</a>`,
        attachments: [{ filename: 'welcome.pdf', contentType: 'application/pdf', size: 120 }],
      },
      400,
    );
    const r = await run(
      box,
      steps(
        {
          type: 'email.waitForEmail',
          params: { to: '{{data.email}}', subject: 'verify', timeoutMs: 5000, pollMs: 100 },
          assertions: [{ target: 'from', operator: 'equals', expected: 'noreply@app.test' }],
        },
        {
          type: 'email.assertEmail',
          params: {
            subjectContains: 'CareClinic',
            bodyContains: 'verification code',
            hasLink: 'verify',
            hasAttachment: 'welcome',
          },
        },
        { type: 'email.extractFromEmail', params: { kind: 'otp' }, captureAs: 'otp' },
        { type: 'email.extractFromEmail', params: { kind: 'link', contains: 'verify' }, captureAs: 'link' },
        {
          type: 'email.extractFromEmail',
          params: { kind: 'regex', pattern: 't=(\\w+)' },
          captureAs: 'token',
        },
        {
          type: 'email.openEmailLink',
          params: { contains: 'verify' },
          assertions: [
            { target: 'status', operator: 'equals', expected: 200 },
            { target: 'text', operator: 'contains', expected: 'verified' },
          ],
        },
      ),
    );
    expect(r.status, r.error).toBe('passed');
    expect(r.vars).toMatchObject({ otp: '482913', link: `${siteUrl}/verify?t=abc`, token: 'abc' });
    expect(r.steps[1]!.assertions.map((a) => a.message)).toEqual([
      'Subject contains "CareClinic"',
      'Body contains "verification code"',
      'Has a link containing "verify"',
      'Has the attachment "welcome"',
    ]);
    // The received email is kept on the step for the results preview and saved as evidence.
    expect(r.steps[0]!.email).toMatchObject({ subject: 'Verify your CareClinic account', inbox: 'default' });
    expect(r.artifacts).toHaveLength(1);
    expect(JSON.parse(readFileSync(r.artifacts[0]!.path, 'utf8')).subject).toBe(
      'Verify your CareClinic account',
    );
    expect(box.closed).toBe(true);
  });

  it('fails clearly when the email does not arrive in time', async () => {
    const r = await run(
      new MemoryBox(),
      steps({ type: 'email.waitForEmail', params: { to: 'x@app.test', timeoutMs: 1200, pollMs: 100 } }),
    );
    expect(r.status).toBe('failed');
    expect(r.errorKind).toBe('timeout');
    expect(r.error).toMatch(/No email to x@app.test arrived within 1 s after the test started/);
  });

  it('fails when no code is found, and when checks do not hold', async () => {
    const box = new MemoryBox();
    box.deliver({ to: ['ana+R1@app.test'], subject: 'Welcome', text: 'Thanks for joining!' });
    const r = await run(
      box,
      steps(
        { type: 'email.waitForEmail', params: { to: 'ana+R1', timeoutMs: 2000, pollMs: 100 } },
        { type: 'email.assertEmail', params: { hasLink: true }, continueOnFail: true },
        { type: 'email.extractFromEmail', params: { kind: 'otp' } },
      ),
    );
    expect(r.steps.map((s) => s.status)).toEqual(['passed', 'failed', 'failed']);
    expect(r.steps[1]!.message).toBe('Expected the email to contain a link');
    expect(r.steps[2]!.message).toMatch(/Could not find a one-time code \(4–8 digits/);
  });

  it('reports configuration mistakes as broken', async () => {
    const box = new MemoryBox();
    expect(
      (await run(box, steps({ type: 'email.extractFromEmail', params: { kind: 'otp' } }))).error,
    ).toMatch(/needs an earlier email.waitForEmail/);
    const r = await run(
      box,
      steps({ type: 'email.waitForEmail', params: { inbox: 'gmail', to: 'a@b.test' } }),
    );
    expect(r.status).toBe('broken');
    expect(r.error).toMatch(/No inbox named "gmail"/);
    expect((await run(box, steps({ type: 'email.waitForEmail', params: {} }))).error).toMatch(
      /needs at least/,
    );
  });
});
