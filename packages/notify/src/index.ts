import nodemailer from 'nodemailer';
import { z } from 'zod';

/** Printed under every notification. */
export const NOTIFY_CREDIT = 'Sent by StepForge — by Md Zarin Tasnim';

export const TelegramConfig = z.object({
  chatId: z.string().trim().min(1),
  /** Only for testing against a local stand-in; defaults to the real Telegram Bot API. */
  apiBase: z.url().optional(),
});
export const EmailConfig = z.object({
  host: z.string().trim().min(1),
  port: z.number().int().min(1).max(65535).default(587),
  /** TLS from the start (port 465). STARTTLS is used automatically when the server offers it. */
  secure: z.boolean().default(false),
  user: z.string().default(''),
  from: z.string().trim().min(3),
  to: z.array(z.string().trim().min(3)).min(1).max(50),
});
export const ChannelInput = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('telegram'),
    name: z.string().trim().min(1).max(80),
    config: TelegramConfig,
    on: z.enum(['always', 'failures']).default('always'),
    /** Bot token (stored encrypted). */
    secret: z.string().max(500).optional(),
  }),
  z.object({
    kind: z.literal('email'),
    name: z.string().trim().min(1).max(80),
    config: EmailConfig,
    on: z.enum(['always', 'failures']).default('always'),
    /** SMTP password (stored encrypted). */
    secret: z.string().max(500).optional(),
  }),
]);
export type ChannelInput = z.infer<typeof ChannelInput>;

export type RunSummary = {
  application: string;
  environment: string;
  status: string;
  trigger: string;
  scheduleName?: string;
  totals: { total: number; passed: number; failed: number; broken: number; skipped: number; flaky: number };
  passRate: number | null;
  durationMs: number | null;
  failed: { name: string; diagnosis?: string | null; error?: string | null }[];
  gate?: { status: string; failing: string[] } | null;
  /** Link to the run in the dashboard. */
  url?: string;
};

export type Message = { subject: string; text: string; html: string; telegram: string };

const GATE: Record<string, string> = {
  green: 'passing',
  amber: 'warning',
  red: 'failing',
  unknown: 'no data',
};
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const dur = (ms: number | null) =>
  ms === null ? '—' : ms < 60_000 ? `${Math.round(ms / 100) / 10} s` : `${Math.round(ms / 6000) / 10} min`;
const MAX_LISTED = 10;

/** The same summary as an email (subject, text, HTML) and a Telegram message (HTML subset). */
export function formatSummary(s: RunSummary): Message {
  const ok = s.status === 'passed';
  const icon = ok ? '✅' : '❌';
  const head = `${icon} ${s.application} · ${s.environment}: ${ok ? 'passed' : 'failed'}`;
  const counts = `${s.totals.passed}/${s.totals.total} passed${s.totals.failed ? ` · ${s.totals.failed} failed` : ''}${s.totals.broken ? ` · ${s.totals.broken} broken` : ''}${s.totals.flaky ? ` · ${s.totals.flaky} flaky` : ''}${s.totals.skipped ? ` · ${s.totals.skipped} skipped` : ''}`;
  const meta = `${s.scheduleName ? `Schedule "${s.scheduleName}"` : `Trigger: ${s.trigger}`} · pass rate ${s.passRate ?? '—'}% · ${dur(s.durationMs)}`;
  const failed = s.failed.slice(0, MAX_LISTED);
  const more = s.failed.length - failed.length;
  const gate = s.gate
    ? `Quality gate: ${GATE[s.gate.status] ?? s.gate.status}${s.gate.failing.length ? ` — ${s.gate.failing.join('; ')}` : ''}`
    : '';
  const text = [
    head,
    counts,
    meta,
    ...(gate ? [gate] : []),
    ...(failed.length
      ? [
          '',
          'Failed tests:',
          ...failed.map((f) => `• ${f.name}${f.diagnosis || f.error ? ` — ${f.diagnosis ?? f.error}` : ''}`),
        ]
      : []),
    ...(more > 0 ? [`… and ${more} more`] : []),
    ...(s.url ? ['', `Open the run: ${s.url}`] : []),
    '',
    NOTIFY_CREDIT,
  ].join('\n');
  const telegram = [
    `<b>${esc(head)}</b>`,
    esc(counts),
    `<i>${esc(meta)}</i>`,
    ...(gate ? [esc(gate)] : []),
    ...(failed.length
      ? [
          '',
          '<b>Failed tests</b>',
          ...failed.map(
            (f) =>
              `• ${esc(f.name)}${f.diagnosis || f.error ? ` — <i>${esc(String(f.diagnosis ?? f.error).slice(0, 200))}</i>` : ''}`,
          ),
        ]
      : []),
    ...(more > 0 ? [`… and ${more} more`] : []),
    ...(s.url ? ['', `<a href="${esc(s.url)}">Open the run</a>`] : []),
    '',
    `<i>${esc(NOTIFY_CREDIT)}</i>`,
  ]
    .join('\n')
    .slice(0, 4000); // Telegram's limit is 4096 characters
  const colour = ok ? '#16a34a' : '#dc2626';
  const html = `<div style="font-family:system-ui,sans-serif;font-size:14px;color:#0f172a;max-width:640px">
<h2 style="margin:0 0 4px;color:${colour}">${esc(head)}</h2>
<p style="margin:0">${esc(counts)}</p>
<p style="margin:4px 0 12px;color:#64748b">${esc(meta)}</p>
${gate ? `<p style="margin:0 0 12px"><strong>${esc(gate)}</strong></p>` : ''}
${failed.length ? `<h3 style="margin:12px 0 4px;font-size:14px">Failed tests</h3><ul style="padding-left:18px;margin:0">${failed.map((f) => `<li><strong>${esc(f.name)}</strong>${f.diagnosis || f.error ? `<br><span style="color:#64748b">${esc(String(f.diagnosis ?? f.error))}</span>` : ''}</li>`).join('')}</ul>${more > 0 ? `<p>… and ${more} more</p>` : ''}` : ''}
${s.url ? `<p style="margin-top:16px"><a href="${esc(s.url)}" style="color:#F97316">Open the run in StepForge</a></p>` : ''}
<p style="margin-top:24px;font-size:12px;color:#64748b">${esc(NOTIFY_CREDIT)}</p>
</div>`;
  return {
    subject: `[StepForge] ${s.application} · ${s.environment}: ${ok ? 'passed' : 'FAILED'} (${s.totals.passed}/${s.totals.total})`,
    text,
    html,
    telegram,
  };
}

export async function sendTelegram(
  token: string,
  config: z.input<typeof TelegramConfig>,
  text: string,
): Promise<void> {
  const c = TelegramConfig.parse(config);
  if (!token) throw new Error('The Telegram bot token is missing');
  const base = (c.apiBase ?? 'https://api.telegram.org').replace(/\/$/, '');
  let res: Response;
  try {
    res = await fetch(`${base}/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: c.chatId, text, parse_mode: 'HTML', disable_web_page_preview: true }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    throw new Error(`Telegram could not be reached: ${(err as Error).message}`);
  }
  const body = (await res.json().catch(() => ({}))) as { ok?: boolean; description?: string };
  // Never echo the URL: it contains the bot token.
  if (!res.ok || body.ok === false)
    throw new Error(`Telegram refused the message: ${body.description ?? res.status}`);
}

export async function sendEmail(
  password: string | undefined,
  config: z.input<typeof EmailConfig>,
  m: Pick<Message, 'subject' | 'text' | 'html'>,
): Promise<void> {
  const c = EmailConfig.parse(config);
  const transport = nodemailer.createTransport({
    host: c.host,
    port: c.port,
    secure: c.secure,
    ...(c.user && { auth: { user: c.user, pass: password ?? '' } }),
    connectionTimeout: 15_000,
  });
  try {
    await transport.sendMail({ from: c.from, to: c.to, subject: m.subject, text: m.text, html: m.html });
  } catch (err) {
    throw new Error(`The email could not be sent: ${(err as Error).message}`);
  } finally {
    transport.close();
  }
}

export type Channel = {
  kind: 'telegram' | 'email';
  config: Record<string, unknown>;
  on: 'always' | 'failures';
  secret?: string;
};

/** Sends a run summary to one channel (respecting "failures only"). Returns false when skipped. */
export async function notify(
  channel: Channel,
  summary: RunSummary,
  opts: { force?: boolean } = {},
): Promise<boolean> {
  if (!opts.force && channel.on === 'failures' && summary.status === 'passed') return false;
  const m = formatSummary(summary);
  if (channel.kind === 'telegram')
    await sendTelegram(channel.secret ?? '', channel.config as never, m.telegram);
  else await sendEmail(channel.secret, channel.config as never, m);
  return true;
}

/** A sample summary for the "Send test" button. */
export const TEST_SUMMARY: RunSummary = {
  application: 'StepForge',
  environment: 'Test message',
  status: 'passed',
  trigger: 'test',
  totals: { total: 3, passed: 3, failed: 0, broken: 0, skipped: 0, flaky: 0 },
  passRate: 100,
  durationMs: 4200,
  failed: [],
  gate: { status: 'green', failing: [] },
};
