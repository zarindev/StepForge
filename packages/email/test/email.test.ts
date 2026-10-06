import hoodiecrow from 'hoodiecrow-imap';
import { existsSync, mkdtempSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import nodemailer from 'nodemailer';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  extractLinks,
  extractOtp,
  extractRegex,
  htmlToText,
  ImapMailbox,
  MailpitMailbox,
  MailpitServer,
  mailpitAsset,
  mailpitBinary,
  pickLink,
  waitForEmail,
} from '../src/index.ts';

const freePort = () =>
  new Promise<number>((r) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => r(port));
    });
  });

describe('extractors', () => {
  it.each([
    ['Your verification code is 482913.', '482913'],
    ['Your verification code is *482913*. Verify ( http://x.test )', '482913'],
    ['Use 7731 to sign in. Order #20261005 total $1200', '7731'],
    ['Hi Ana, on 2026-10-06 at 10:30 you asked for a code. OTP: 551 204', '551204'],
    ['Call +1-555-201-0001. Your one-time passcode: 90817', '90817'],
    ['Your PIN\n\n  3141  \n\nexpires in 10 minutes', '3141'],
    ['Code: 12345678 (valid 5 min)', '12345678'],
  ])('finds the code in %j', (text, code) => {
    expect(extractOtp(text)).toBe(code);
  });

  it('returns nothing when the email has no code, or only ambiguous numbers', () => {
    expect(extractOtp('Welcome to CareClinic! Your appointment is confirmed.')).toBeUndefined();
    expect(extractOtp('Invoice 4821 and invoice 9932 are attached')).toBeUndefined();
    // Regression: digits of a run id inside the verification link (next to "verify" and "code=") are not the code.
    expect(
      extractOtp(
        'Your verification code is 482913. It expires in 10 minutes.\n\nOr open this link: http://127.0.0.1:8131/verify?email=qa%2B19a81234567f4821%40example.test&code=482913',
      ),
    ).toBe('482913');
    expect(extractOtp('Code sent to qa+20261005123@example.test: 551 204')).toBe('551204');
    expect(extractOtp('code 12', { minLength: 4 })).toBeUndefined();
    expect(extractOtp('Your code is AB12', { minLength: 4 })).toBeUndefined();
  });

  it('extracts links from HTML and text, decodes entities and picks one', () => {
    const html =
      '<p>Hello</p><a href="https://app.test/verify?u=1&amp;t=abc">Verify</a> <a href="mailto:x@y.test">mail</a> <a href="https://app.test/help">help</a>';
    const links = extractLinks(html, 'Or open https://app.test/verify?u=1&t=abc.');
    expect(links).toEqual(['https://app.test/verify?u=1&t=abc', 'https://app.test/help']);
    expect(pickLink(links, { contains: 'HELP' })).toBe('https://app.test/help');
    expect(pickLink(links, { index: 1 })).toBe('https://app.test/help');
    expect(pickLink(links, { contains: 'nope' })).toBeUndefined();
  });

  it('turns HTML into readable text and applies custom regexes', () => {
    expect(htmlToText('<style>p{}</style><p>Hi&nbsp;<b>Ana</b></p><p>Code&#58; 42</p>')).toBe(
      'Hi Ana\nCode: 42',
    );
    expect(extractRegex('Ref: INV-0042 paid', 'INV-(\\d+)')).toBe('0042');
    expect(extractRegex('Ref: INV-0042', 'inv-\\d+')).toBe('INV-0042');
    expect(() => extractRegex('x', '(')).toThrow(/Invalid regular expression/);
  });

  it('knows the Mailpit asset for each platform', () => {
    expect(mailpitAsset('win32', 'x64')).toBe('mailpit-windows-amd64.zip');
    expect(mailpitAsset('darwin', 'arm64')).toBe('mailpit-darwin-arm64.tar.gz');
    expect(mailpitAsset('linux', 'x64')).toBe('mailpit-linux-amd64.tar.gz');
    expect(() => mailpitAsset('darwin', 'ia32')).toThrow(/no build/);
  });
});

// Mailpit is installed by `npm run mailpit:install` (setup and CI do this); the tests skip without it.
const BIN_DIR = resolve(import.meta.dirname, '../../../data/bin');
const hasMailpit = existsSync(mailpitBinary(BIN_DIR));

describe.skipIf(!hasMailpit)('Mailpit (real binary)', () => {
  let server: MailpitServer;
  let smtp: ReturnType<typeof nodemailer.createTransport>;
  beforeAll(async () => {
    server = new MailpitServer({
      binDir: BIN_DIR,
      dataDir: mkdtempSync(join(tmpdir(), 'sf-mailpit-')),
      httpPort: await freePort(),
      smtpPort: await freePort(),
    });
    const st = await server.start();
    expect(st).toMatchObject({ running: true, version: 'v1.31.4' });
    smtp = nodemailer.createTransport({
      host: '127.0.0.1',
      port: server.smtpPort,
      secure: false,
      ignoreTLS: true,
    });
  }, 30_000);
  afterAll(async () => {
    expect((await server.stop()).running).toBe(false);
  });

  it('waits for the matching email, ignoring older and other recipients, and reads it fully', async () => {
    const box = new MailpitMailbox(server.url);
    await smtp.sendMail({
      from: 'CareClinic <noreply@clinic.test>',
      to: 'ana+r1@example.test',
      subject: 'Old code',
      text: 'code 111111',
    });
    await new Promise((r) => setTimeout(r, 1100));
    const since = new Date();
    setTimeout(() => {
      void smtp.sendMail({
        from: 'noreply@clinic.test',
        to: 'ben@example.test',
        subject: 'Verify your email',
        text: 'code 222222',
      });
      void smtp.sendMail({
        from: 'CareClinic <noreply@clinic.test>',
        to: 'ana+r1@example.test',
        subject: 'Verify your email',
        html: '<p>Your verification code is <b>482913</b>.</p><a href="http://clinic.test/verify?t=abc&amp;u=7">Verify</a>',
        attachments: [{ filename: 'terms.pdf', content: Buffer.from('%PDF-1.4') }],
      });
    }, 300);
    const m = await waitForEmail(
      box,
      { to: 'ana+r1@example.test', subject: 'verify', since },
      { timeoutMs: 10_000, pollMs: 200 },
    );
    expect(m).toMatchObject({
      from: 'noreply@clinic.test',
      fromName: 'CareClinic',
      to: ['ana+r1@example.test'],
      subject: 'Verify your email',
      links: ['http://clinic.test/verify?t=abc&u=7'],
      attachments: [{ filename: 'terms.pdf', contentType: 'application/pdf' }],
    });
    expect(extractOtp(m.text || htmlToText(m.html))).toBe('482913');
    expect(await box.check()).toMatch(/Mailpit v1\.31\.4 · 3 messages/);
  });

  it('times out with a clear message', async () => {
    const box = new MailpitMailbox(server.url);
    await expect(
      waitForEmail(box, { to: 'nobody@example.test', since: new Date() }, { timeoutMs: 600, pollMs: 200 }),
    ).rejects.toThrow(/No email to nobody@example.test arrived within 1 s after the test started/);
  });

  it('reports an unreachable Mailpit', async () => {
    await expect(new MailpitMailbox(`http://127.0.0.1:${await freePort()}`).check()).rejects.toThrow(
      /Cannot reach Mailpit/,
    );
  });
});

describe('IMAP adapter', () => {
  let port = 0;
  let server: { listen: (p: number, cb: () => void) => void; close: (cb?: () => void) => void };
  const raw = (to: string, subject: string, body: string, date: Date) =>
    `From: Shop <orders@shop.test>\r\nTo: ${to}\r\nSubject: ${subject}\r\nDate: ${date.toUTCString()}\r\nMessage-ID: <${Math.random()}@shop.test>\r\nContent-Type: text/html; charset=utf-8\r\n\r\n${body}\r\n`;

  beforeAll(async () => {
    port = await freePort();
    const old = new Date(Date.now() - 3 * 24 * 3600_000);
    server = hoodiecrow({
      plugins: [
        'ID',
        'IDLE',
        'UNSELECT',
        'ENABLE',
        'CONDSTORE',
        'SPECIAL-USE',
        'NAMESPACE',
        'UIDPLUS',
        'LITERALPLUS',
      ],
      users: { 'qa@shop.test': { password: 'app-password' } },
      storage: {
        INBOX: {
          messages: [
            { raw: raw('qa+old@shop.test', 'Your code', '<p>Code 000000</p>', old), internaldate: old },
            {
              raw: raw(
                'qa+run42@shop.test',
                'Confirm your order',
                '<p>Your security code: <b>7731</b></p><a href="https://shop.test/confirm/42">Confirm</a>',
                new Date(),
              ),
              internaldate: new Date(),
            },
          ],
        },
      },
    });
    await new Promise<void>((r) => server.listen(port, r));
  });
  afterAll(() => server.close());

  const box = () =>
    new ImapMailbox({
      host: '127.0.0.1',
      port,
      secure: false,
      user: 'qa@shop.test',
      password: 'app-password',
    });

  it('finds a plus-addressed email received after the test started and parses it', async () => {
    const b = box();
    try {
      expect(await b.check()).toBe('IMAP 127.0.0.1 · INBOX · 2 messages');
      const m = await waitForEmail(
        b,
        { to: 'qa+run42@shop.test', since: new Date(Date.now() - 60_000) },
        { timeoutMs: 3000 },
      );
      expect(m).toMatchObject({
        subject: 'Confirm your order',
        from: 'orders@shop.test',
        links: ['https://shop.test/confirm/42'],
      });
      expect(extractOtp(htmlToText(m.html))).toBe('7731');
      // The three-day-old message is outside the time window.
      await expect(
        waitForEmail(
          b,
          { to: 'qa+old@shop.test', since: new Date(Date.now() - 60_000) },
          { timeoutMs: 500, pollMs: 200 },
        ),
      ).rejects.toThrow(/No email/);
    } finally {
      await b.close();
    }
  });

  it('explains a failed login', async () => {
    const b = new ImapMailbox({
      host: '127.0.0.1',
      port,
      secure: false,
      user: 'qa@shop.test',
      password: 'wrong',
    });
    await expect(b.check()).rejects.toThrow(/IMAP login failed for qa@shop.test/);
    await b.close();
  });
});
