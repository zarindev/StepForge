import { MailpitMailbox, MailpitServer, mailpitBinary, waitForEmail } from '@stepforge/email';
import { existsSync, mkdtempSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { createServer as netServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ChannelInput,
  formatSlack,
  formatSummary,
  formatTeams,
  notify,
  readWebhookSecret,
  sendTelegram,
  writeWebhookSecret,
  type RunSummary,
} from '../src/index.ts';

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
    // Long names and messages: Telegram's text stays under its limit with every tag closed (a cut tag is refused).
    const long = formatSummary({
      ...summary,
      failed: Array.from({ length: 10 }, (_, i) => ({
        name: `Test & ${'x'.repeat(400)} ${i}`,
        error: 'e'.repeat(400),
      })),
      gate: { status: 'red', failing: Array.from({ length: 40 }, (_, i) => `Rule ${i} & ${'y'.repeat(60)}`) },
    });
    expect(long.telegram.length).toBeLessThan(4096);
    for (const tag of ['b', 'i', 'a']) {
      const open = long.telegram.match(new RegExp(`<${tag}[ >]`, 'g'))?.length ?? 0;
      expect(long.telegram.match(new RegExp(`</${tag}>`, 'g'))?.length ?? 0, tag).toBe(open);
    }
    expect(long.telegram).not.toMatch(/&[a-z]*$/m);
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
describe('Slack, Mattermost, Teams and webhooks', () => {
  let hook: Server;
  let base = '';
  const got: { path: string; body: Record<string, unknown>; headers: Record<string, unknown> }[] = [];
  beforeAll(async () => {
    hook = createServer((req, res) => {
      let b = '';
      req.on('data', (c) => (b += c));
      req.on('end', () => {
        if (req.url?.includes('revoked')) return res.writeHead(404).end('no_service');
        got.push({
          path: req.url ?? '',
          body: JSON.parse(b) as Record<string, unknown>,
          headers: req.headers,
        });
        res.writeHead(req.url?.startsWith('/teams') ? 202 : 200).end('ok');
      });
    });
    await new Promise<void>((r) => hook.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(hook.address() as { port: number }).port}`;
  });
  afterAll(() => {
    hook.close();
  });

  it('Slack: a coloured attachment with the failures, a mention on failure and escaped names', () => {
    const m = formatSlack(summary, { mention: '<!here>' }) as {
      text: string;
      attachments: { color: string; text: string; footer: string }[];
    };
    expect(m.text).toBe('<!here> *❌ CareClinic · Staging: failed*');
    expect(m.attachments[0]!.color).toBe('#dc2626');
    expect(m.attachments[0]!.text).toContain('• Login &lt;admin&gt; — Timeout 15000ms exceeded');
    expect(m.attachments[0]!.text).toContain('<http://127.0.0.1:4400/runs/RUN1|Open the run>');
    expect(m.attachments[0]!.footer).toBe('Sent by StepForge — by Md Zarin Tasnim');
    const mm = formatSlack(
      { ...summary, status: 'passed', failed: [] },
      { flavor: 'mattermost', mention: '@channel' },
    ) as {
      text: string;
      attachments: { color: string; text: string }[];
    };
    expect(mm.text).toBe('**✅ CareClinic · Staging: passed**'); // no mention when it passed
    expect(mm.attachments[0]!.text).toContain('[Open the run](http://127.0.0.1:4400/runs/RUN1)');
  });

  it('Teams: an Adaptive Card with an "Open the run" button', () => {
    const card = (
      formatTeams(summary) as {
        attachments: {
          contentType: string;
          content: { body: { text: string; color?: string }[]; actions: { url: string }[] };
        }[];
      }
    ).attachments[0]!;
    expect(card.contentType).toBe('application/vnd.microsoft.card.adaptive');
    expect(card.content.body[0]).toMatchObject({
      text: '❌ CareClinic · Staging: failed',
      color: 'Attention',
    });
    expect(card.content.body.map((b) => b.text)).toContain(
      '- **Book appointment** — The API accepted a duplicate (201 instead of 409 Conflict)',
    );
    expect(card.content.actions[0]!.url).toBe('http://127.0.0.1:4400/runs/RUN1');
  });

  it('posts to each webhook; a refusal never shows the URL (it holds the token)', async () => {
    await notify({ kind: 'slack', config: {}, on: 'always', secret: `${base}/slack/T000/B000/XXX` }, summary);
    await notify(
      { kind: 'teams', config: {}, on: 'always', secret: `${base}/teams/workflow?sig=SECRET` },
      summary,
    );
    await notify(
      {
        kind: 'webhook',
        config: { headers: { authorization: 'Bearer abc' } },
        on: 'always',
        secret: `${base}/hook`,
      },
      summary,
    );
    await notify(
      {
        kind: 'webhook',
        config: { headerNames: ['x-api-key'] },
        on: 'always',
        secret: writeWebhookSecret({ url: `${base}/hook2`, headers: { 'x-api-key': 'KEY1' } }),
      },
      summary,
    );
    expect(got.map((g) => g.path)).toEqual([
      '/slack/T000/B000/XXX',
      '/teams/workflow?sig=SECRET',
      '/hook',
      '/hook2',
    ]);
    expect(got[2]!.headers.authorization).toBe('Bearer abc');
    expect(got[3]!.headers['x-api-key']).toBe('KEY1');
    expect(got[2]!.body).toMatchObject({
      event: 'run.finished',
      summary: { application: 'CareClinic', status: 'failed' },
    });

    const err = await notify(
      { kind: 'slack', config: {}, on: 'always', secret: `${base}/revoked/SECRET-TOKEN` },
      summary,
    ).catch((e: Error) => e);
    expect(String(err)).toContain('Slack refused the message: 404 no_service');
    expect(String(err)).not.toContain('SECRET-TOKEN');
    expect(
      await notify(
        { kind: 'teams', config: {}, on: 'failures', secret: `${base}/teams/x` },
        { ...summary, status: 'passed' },
      ),
    ).toBe(false);
  });
});

describe('webhook secrets', () => {
  it('reads the URL and header values from the secret, and a plain-URL secret from older channels', () => {
    const s = writeWebhookSecret({ url: 'https://h.test/x', headers: { Authorization: 'Bearer T' } });
    expect(readWebhookSecret(s)).toEqual({ url: 'https://h.test/x', headers: { Authorization: 'Bearer T' } });
    expect(readWebhookSecret('https://h.test/old')).toEqual({ url: 'https://h.test/old', headers: {} });
    expect(readWebhookSecret(undefined)).toEqual({ url: '', headers: {} });
  });

  it('refuses webhook URLs with a username or password', () => {
    for (const kind of ['slack', 'teams', 'webhook'] as const)
      expect(
        ChannelInput.safeParse({ kind, name: 'x', config: {}, secret: 'https://user:pass@h.test/x' }).success,
      ).toBe(false);
    expect(
      ChannelInput.safeParse({ kind: 'webhook', name: 'x', config: {}, secret: 'https://h.test/x' }).success,
    ).toBe(true);
  });

  it('errors never quote the URL or token, even when fetch does', async () => {
    const errs = await Promise.all([
      // "Failed to parse URL from …"
      notify({ kind: 'slack', config: {}, on: 'always', secret: 'TOKEN-abc not a url' }, summary).catch(
        (e: Error) => e,
      ),
      // "Request cannot be constructed from a URL that includes credentials: …"
      notify(
        { kind: 'teams', config: {}, on: 'always', secret: 'http://user:PASSWORD@127.0.0.1:1/x' },
        summary,
      ).catch((e: Error) => e),
      notify(
        {
          kind: 'webhook',
          config: {},
          on: 'always',
          secret: writeWebhookSecret({ url: 'http://u:PASSWORD@127.0.0.1:1/x', headers: {} }),
        },
        summary,
      ).catch((e: Error) => e),
      sendTelegram('123:BOT-TOKEN', { chatId: '1', apiBase: 'http://u:PASSWORD@127.0.0.1:1' }, 'hi').catch(
        (e: Error) => e,
      ),
    ]);
    for (const e of errs) {
      expect(e).toBeInstanceOf(Error);
      expect(String(e)).toContain('could not be reached');
      expect(String(e)).not.toMatch(/TOKEN|PASSWORD|127\.0\.0\.1|https?:/);
    }
  });
});

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
