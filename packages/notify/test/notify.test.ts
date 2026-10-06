import { MailpitMailbox, MailpitServer, mailpitBinary, waitForEmail } from '@stepforge/email';
import { existsSync, mkdtempSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { createServer as netServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { formatSummary, notify, sendTelegram, type RunSummary } from '../src/index.ts';

const summary: RunSummary = {
  application: 'CareClinic',
  environment: 'Staging',
  status: 'failed',
  trigger: 'schedule',
  scheduleName: 'Nightly',
  totals: { total: 12, passed: 9, failed: 2, broken: 1, skipped: 0, flaky: 0 },
  passRate: 75,
  durationMs: 95_000,
  failed: [
    { name: 'Book appointment', diagnosis: 'The API accepted a duplicate (201 instead of 409 Conflict)' },
    { name: 'Login <admin>', error: 'Timeout 15000ms exceeded' },
  ],
  gate: { status: 'red', failing: ['Pass rate of P1 tests ≥ 100%'] },
  url: 'http://127.0.0.1:4400/runs/RUN1',
};

const freePort = () =>
  new Promise<number>((r) => {
    const s = netServer().listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => r(port));
    });
  });

describe('message formatting', () => {
  it('summarises the run with failures, diagnoses, gate and a link', () => {
    const m = formatSummary(summary);
    expect(m.subject).toBe('[StepForge] CareClinic · Staging: FAILED (9/12)');
    expect(m.text).toBe(
      [
        '❌ CareClinic · Staging: failed',
        '9/12 passed · 2 failed · 1 broken',
        'Schedule "Nightly" · pass rate 75% · 1.6 min',
        'Quality gate: failing — Pass rate of P1 tests ≥ 100%',
        '',
        'Failed tests:',
        '• Book appointment — The API accepted a duplicate (201 instead of 409 Conflict)',
        '• Login <admin> — Timeout 15000ms exceeded',
        '',
        'Open the run: http://127.0.0.1:4400/runs/RUN1',
        '',
        'Sent by StepForge — by Md Zarin Tasnim',
      ].join('\n'),
    );
    // Telegram HTML is escaped.
    expect(m.telegram).toContain('• Login &lt;admin&gt;');
    expect(m.telegram).toContain('<a href="http://127.0.0.1:4400/runs/RUN1">Open the run</a>');
    expect(m.html).toContain('Sent by StepForge — by Md Zarin Tasnim');
    const many = formatSummary({
      ...summary,
      failed: Array.from({ length: 14 }, (_, i) => ({ name: `T${i}` })),
    });
    expect(many.text).toContain('… and 4 more');
  });
});

describe('Telegram', () => {
  let server: Server;
  let base = '';
  const received: { path: string; body: Record<string, unknown> }[] = [];
  beforeAll(async () => {
    // A stand-in for api.telegram.org that behaves like the Bot API.
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const ok = req.url === '/botGOOD-TOKEN/sendMessage';
        received.push({ path: req.url ?? '', body: JSON.parse(body || '{}') });
        res
          .writeHead(ok ? 200 : 401, { 'content-type': 'application/json' })
          .end(JSON.stringify(ok ? { ok: true, result: {} } : { ok: false, description: 'Unauthorized' }));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(() => server.close());

  it('posts an HTML message to the chat, and reports refusals without leaking the token', async () => {
    await notify(
      { kind: 'telegram', config: { chatId: '-1001', apiBase: base }, on: 'always', secret: 'GOOD-TOKEN' },
      summary,
    );
    expect(received[0]).toMatchObject({
      path: '/botGOOD-TOKEN/sendMessage',
      body: { chat_id: '-1001', parse_mode: 'HTML' },
    });
    expect(String(received[0]!.body.text)).toContain('<b>❌ CareClinic · Staging: failed</b>');
    const err = await sendTelegram('BAD-TOKEN', { chatId: '1', apiBase: base }, 'x').catch((e: Error) => e);
    expect((err as Error).message).toBe('Telegram refused the message: Unauthorized');
    expect((err as Error).message).not.toContain('BAD-TOKEN');
    await expect(sendTelegram('', { chatId: '1', apiBase: base }, 'x')).rejects.toThrow(/token is missing/);
  });

  it('skips passing runs on "failures only" channels unless forced', async () => {
    const n = received.length;
    const ch = {
      kind: 'telegram' as const,
      config: { chatId: '1', apiBase: base },
      on: 'failures' as const,
      secret: 'GOOD-TOKEN',
    };
    expect(await notify(ch, { ...summary, status: 'passed' })).toBe(false);
    expect(received.length).toBe(n);
    expect(await notify(ch, { ...summary, status: 'passed' }, { force: true })).toBe(true);
  });
});

const BIN_DIR = resolve(import.meta.dirname, '../../../data/bin');
describe.skipIf(!existsSync(mailpitBinary(BIN_DIR)))('email (real SMTP via Mailpit)', () => {
  let mp: MailpitServer;
  beforeAll(async () => {
    mp = new MailpitServer({
      binDir: BIN_DIR,
      dataDir: mkdtempSync(join(tmpdir(), 'sf-notify-')),
      httpPort: await freePort(),
      smtpPort: await freePort(),
    });
    await mp.start();
  }, 30_000);
  afterAll(async () => {
    await mp.stop();
  });

  it('sends the summary by email', async () => {
    const since = new Date(Date.now() - 1000);
    await notify(
      {
        kind: 'email',
        config: {
          host: '127.0.0.1',
          port: mp.smtpPort,
          from: 'StepForge <qa@stepforge.test>',
          to: ['team@example.test'],
        },
        on: 'always',
      },
      summary,
    );
    const m = await waitForEmail(
      new MailpitMailbox(mp.url),
      { to: 'team@example.test', since },
      { timeoutMs: 5000, pollMs: 200 },
    );
    expect(m.subject).toBe('[StepForge] CareClinic · Staging: FAILED (9/12)');
    expect(m.html).toContain('The API accepted a duplicate (201 instead of 409 Conflict)');
    expect(m.text).toContain('Sent by StepForge — by Md Zarin Tasnim');
  });
});
