import { MailpitMailbox, MailpitServer, mailpitBinary, waitForEmail } from '@stepforge/email';
import type { FastifyInstance } from 'fastify';
import { existsSync, mkdtempSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { createServer as netServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AppContext, LiveEvent } from '../src/context.ts';
import { H, testServer } from './helpers.ts';

let app: FastifyInstance;
let ctx: AppContext;
let target: Server;
let telegram: Server;
let telegramBase = '';
const telegramReceived: { path: string; body: { chat_id: string; text: string } }[] = [];
let appId = '';
let envId = '';
let healthId = '';

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
const freePort = () =>
  new Promise<number>((r) => {
    const s = netServer().listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => r(port));
    });
  });
/** Resolves with the next `notifications.sent` event. */
const nextNotification = (timeoutMs = 20_000) =>
  new Promise<LiveEvent>((res, rej) => {
    const t = setTimeout(() => rej(new Error('no notification')), timeoutMs);
    const on = (e: LiveEvent) => {
      if (e.type !== 'notifications.sent') return;
      clearTimeout(t);
      ctx.bus.off('event', on);
      res(e);
    };
    ctx.bus.on('event', on);
  });

beforeAll(async () => {
  ({ app, ctx } = await testServer());
  target = createServer((req, res) => {
    if (req.url === '/api/health') return void res.writeHead(200).end('{"ok":true}');
    if (req.url === '/api/slow') return void setTimeout(() => res.writeHead(200).end('{}'), 6000);
    // The planted defect: booking twice is accepted instead of 409 Conflict.
    if (req.url === '/api/bookings') return void res.writeHead(201).end('{"id":1}');
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => target.listen(0, '127.0.0.1', r));
  // A stand-in for api.telegram.org that behaves like the Bot API.
  telegram = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      telegramReceived.push({ path: req.url ?? '', body: JSON.parse(body || '{}') });
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true,"result":{}}');
    });
  });
  await new Promise<void>((r) => telegram.listen(0, '127.0.0.1', r));
  telegramBase = `http://127.0.0.1:${(telegram.address() as { port: number }).port}`;

  const base = `http://127.0.0.1:${(target.address() as { port: number }).port}`;
  appId = (await ok('POST', '/api/applications', { name: 'CareClinic', slug: 'careclinic' })).id;
  envId = (await ok('POST', `/api/applications/${appId}/environments`, { name: 'Staging', baseUrl: base }))
    .id;
  const mod = await ok('POST', `/api/applications/${appId}/modules`, { name: 'Booking' });
  const step = (method: string, url: string, status: number) => ({
    type: 'api.request',
    params: { method, url },
    assertions: [{ target: 'status', operator: 'equals', expected: status }],
  });
  healthId = (
    await ok('POST', `/api/modules/${mod.id}/scenarios`, {
      name: 'Health check',
      priority: 'P1',
      steps: [step('GET', '/api/health', 200)],
    })
  ).id;
  await ok('POST', `/api/modules/${mod.id}/scenarios`, {
    name: 'Double booking is rejected',
    priority: 'P1',
    steps: [step('POST', '/api/bookings', 409)],
  });
  await ok('POST', `/api/applications/${appId}/quality-gates`, { preset: 'default' });
}, 30_000);
afterAll(async () => {
  await app.close();
  target.close();
  telegram.close();
});

describe('schedules', () => {
  it('previews cron expressions and rejects invalid ones', async () => {
    const p = await ok<{ next: string[] }>('GET', '/api/schedules/preview?cron=0%202%20*%20*%20*&count=3');
    expect(p.next).toHaveLength(3);
    for (const d of p.next) expect(new Date(d).getHours()).toBe(2);
    const bad = await call('GET', '/api/schedules/preview?cron=not%20a%20cron');
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toBe('invalid_cron');
    const badSave = await call('POST', `/api/applications/${appId}/schedules`, {
      name: 'x',
      environmentId: envId,
      cron: '61 * * * *',
    });
    expect(badSave.statusCode).toBe(400);
  });

  it('stores channel secrets encrypted and never returns them', async () => {
    const ch = await ok<{ id: string; hasSecret: boolean }>('POST', '/api/notify-channels', {
      kind: 'telegram',
      name: 'QA chat',
      config: { chatId: '-100123', apiBase: telegramBase },
      secret: 'BOT-TOKEN-XYZ',
    });
    expect(ch.hasSecret).toBe(true);
    const list = await call('GET', '/api/notify-channels');
    expect(list.body).not.toContain('BOT-TOKEN-XYZ');
    const raw = ctx.sqlite.prepare('select * from secrets').all();
    expect(JSON.stringify(raw)).not.toContain('BOT-TOKEN-XYZ');
    // Updating without a secret keeps the stored one.
    const upd = await ok<{ hasSecret: boolean }>('PUT', `/api/notify-channels/${ch.id}`, {
      kind: 'telegram',
      name: 'QA chat',
      config: { chatId: '-100123', apiBase: telegramBase },
      on: 'failures',
    });
    expect(upd.hasSecret).toBe(true);
    const test = await ok<{ ok: boolean; message: string }>('POST', `/api/notify-channels/${ch.id}/test`);
    expect(test).toEqual({ ok: true, message: 'Test message sent to QA chat' });
    expect(telegramReceived.at(-1)!.path).toBe('/botBOT-TOKEN-XYZ/sendMessage');
    await ok('DELETE', `/api/notify-channels/${ch.id}`);
  });
});

describe('overlapping ticks', () => {
  it('skips a cron time while the previous scheduled run is still going', async () => {
    const slowApp = (await ok('POST', '/api/applications', { name: 'Slow', slug: 'slow' })).id;
    const base = `http://127.0.0.1:${(target.address() as { port: number }).port}`;
    const env = (
      await ok('POST', `/api/applications/${slowApp}/environments`, { name: 'Local', baseUrl: base })
    ).id;
    const mod = await ok('POST', `/api/applications/${slowApp}/modules`, { name: 'Slow' });
    await ok('POST', `/api/modules/${mod.id}/scenarios`, {
      name: 'Slow endpoint',
      steps: [{ type: 'api.request', params: { url: '/api/slow' } }],
    });
    const events: string[] = [];
    const on = (e: LiveEvent) => {
      if (e.type === 'schedule.triggered' || e.type === 'schedule.skipped') events.push(e.type);
    };
    ctx.bus.on('event', on);
    const s = await ok('POST', `/api/applications/${slowApp}/schedules`, {
      name: 'Every second',
      environmentId: env,
      cron: '* * * * * *',
    });
    // Wait for the second tick (skipped: the first run is still waiting for the 6 s endpoint), not a fixed time —
    // CI machines can be slow to start the first run.
    for (const deadline = Date.now() + 10_000; !events.includes('schedule.skipped') && Date.now() < deadline;)
      await new Promise((r) => setTimeout(r, 100));
    await ok('DELETE', `/api/schedules/${s.id}`);
    ctx.bus.off('event', on);
    await ctx.runs.idle();
    expect(events.filter((e) => e === 'schedule.triggered')).toHaveLength(1);
    expect(events.filter((e) => e === 'schedule.skipped').length).toBeGreaterThanOrEqual(1);
    const runs = await ok<{ applicationId: string; trigger: string }[]>(
      'GET',
      `/api/runs?applicationId=${slowApp}`,
    );
    expect(runs.filter((r) => r.trigger === 'schedule')).toHaveLength(1);
  }, 30_000);
});

const BIN_DIR = resolve(import.meta.dirname, '../../../data/bin');
describe.skipIf(!existsSync(mailpitBinary(BIN_DIR)))('scheduled run sends a summary (done-when)', () => {
  let mp: MailpitServer;
  beforeAll(async () => {
    mp = new MailpitServer({
      binDir: BIN_DIR,
      dataDir: mkdtempSync(join(tmpdir(), 'sf-sched-mail-')),
      httpPort: await freePort(),
      smtpPort: await freePort(),
    });
    await mp.start();
  }, 30_000);
  afterAll(async () => {
    await mp.stop();
  });

  it('runs on its cron, then emails and messages Telegram with failures, diagnosis and gate', async () => {
    const email = await ok('POST', '/api/notify-channels', {
      kind: 'email',
      name: 'QA team',
      config: {
        host: '127.0.0.1',
        port: mp.smtpPort,
        from: 'StepForge <qa@stepforge.test>',
        to: ['qa@team.test'],
      },
    });
    const tg = await ok('POST', '/api/notify-channels', {
      kind: 'telegram',
      name: 'QA chat',
      config: { chatId: '-100777', apiBase: telegramBase },
      on: 'failures',
      secret: 'BOT-TOKEN-XYZ',
    });
    const since = new Date(Date.now() - 1000);
    const sent = nextNotification();
    // Every second (6-field cron), so the test doesn't wait for a real nightly slot.
    const s = await ok<{ id: string; nextRunAt: string; enabled: boolean }>(
      'POST',
      `/api/applications/${appId}/schedules`,
      { name: 'Nightly', environmentId: envId, cron: '* * * * * *', channelIds: [email.id, tg.id] },
    );
    expect(s.enabled).toBe(true);
    expect(Date.parse(s.nextRunAt)).toBeGreaterThan(Date.now() - 1000);

    const event = (await sent) as LiveEvent & {
      runId: string;
      results: { channel: string; ok: boolean }[];
    };
    // Stop the cron before more runs pile up.
    await ok('PUT', `/api/schedules/${s.id}`, {
      name: 'Nightly',
      environmentId: envId,
      cron: '0 2 * * *',
      enabled: false,
      channelIds: [email.id, tg.id],
    });
    expect(event.results).toEqual([
      expect.objectContaining({ channel: 'QA team', ok: true }),
      expect.objectContaining({ channel: 'QA chat', ok: true }),
    ]);
    const run = await ok<{ id: string; trigger: string; scheduleId: string; status: string }>(
      'GET',
      `/api/runs/${event.runId}`,
    );
    expect(run).toMatchObject({ trigger: 'schedule', scheduleId: s.id, status: 'failed' });

    const m = await waitForEmail(
      new MailpitMailbox(mp.url),
      { to: 'qa@team.test', since },
      { timeoutMs: 5000, pollMs: 200 },
    );
    expect(m.subject).toBe('[StepForge] CareClinic · Staging: FAILED (1/2)');
    expect(m.text).toContain('Schedule "Nightly"');
    expect(m.text).toContain(
      '• Double booking is rejected — The API accepted a duplicate (201 instead of 409 Conflict)',
    );
    expect(m.text).toMatch(/Quality gate: failing — /);
    expect(m.text).toContain(`/runs/${run.id}`);
    expect(m.text).toContain('Sent by StepForge — by Md Zarin Tasnim');

    const msg = telegramReceived.at(-1)!;
    expect(msg.path).toBe('/botBOT-TOKEN-XYZ/sendMessage');
    expect(msg.body.chat_id).toBe('-100777');
    expect(msg.body.text).toContain('<b>❌ CareClinic · Staging: failed</b>');
    expect(msg.body.text).toContain('Double booking is rejected');

    // History shows the run with its notification results.
    const history = await ok<{ id: string; notifications: { ok: boolean }[] }[]>(
      'GET',
      `/api/schedules/${s.id}/runs`,
    );
    expect(history.find((h) => h.id === run.id)?.notifications).toHaveLength(2);
    const disabled = (await ok<{ id: string; nextRunAt: string | null }[]>('GET', '/api/schedules')).find(
      (x) => x.id === s.id,
    )!;
    expect(disabled.nextRunAt).toBeNull();
  }, 60_000);

  it('"Run now" works for a disabled schedule, and "failures only" skips passing runs', async () => {
    const tg = await ok('POST', '/api/notify-channels', {
      kind: 'telegram',
      name: 'Failures only',
      config: { chatId: '1', apiBase: telegramBase },
      on: 'failures',
      secret: 'BOT-TOKEN-XYZ',
    });
    const s = await ok('POST', `/api/applications/${appId}/schedules`, {
      name: 'Smoke',
      environmentId: envId,
      cron: '0 6 * * 1-5',
      enabled: false,
      scope: { type: 'scenarios', ids: [healthId] },
      channelIds: [tg.id],
    });
    const before = telegramReceived.length;
    const sent = nextNotification();
    const run = await ok<{ id: string }>('POST', `/api/schedules/${s.id}/run`);
    const e = (await sent) as LiveEvent & { runId: string; results: { ok: boolean; skipped?: boolean }[] };
    expect(e.runId).toBe(run.id);
    expect(e.results).toEqual([expect.objectContaining({ ok: true, skipped: true })]);
    expect(telegramReceived.length).toBe(before);
    const upcoming = await ok<unknown[]>('GET', '/api/schedules/upcoming');
    expect(upcoming.find((u) => (u as { id: string }).id === s.id)).toBeUndefined(); // disabled
  }, 30_000);
});
