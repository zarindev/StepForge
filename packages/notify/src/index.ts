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
export const SlackConfig = z.object({
  /** Slack (default) or Mattermost: they differ in bold text and links. Rocket.Chat reads the Slack format. */
  flavor: z.enum(['slack', 'mattermost']).default('slack'),
  /** Added when tests fail, e.g. `<!here>` (Slack) or `@channel` (Mattermost). */
  mention: z.string().trim().max(100).optional(),
});
export const TeamsConfig = z.object({});
export const WebhookConfig = z.object({
  /**
   * Extra request headers as entered, e.g. an authorization header your service expects. The server moves
   * their values into the encrypted secret; empty keeps the stored ones when editing.
   */
  headers: z.record(z.string(), z.string()).default({}),
  /** Names of the stored headers, for display (their values are encrypted with the URL). */
  headerNames: z.array(z.string()).default([]),
});

/** Credentials belong in a header: a URL with user:pass@ would be echoed by fetch errors. */
const WebhookUrl = z
  .url()
  .max(2000)
  .refine((u) => {
    try {
      const x = new URL(u);
      return !x.username && !x.password;
    } catch {
      return false;
    }
  }, 'The URL must not contain a username or password; put credentials in a header instead');

/** A generic webhook's secret: its URL and header values, encrypted together. */
export type WebhookSecret = { url: string; headers: Record<string, string> };
export const writeWebhookSecret = (s: WebhookSecret): string => JSON.stringify(s);
/** Reads a webhook secret; older channels stored the plain URL. */
export function readWebhookSecret(secret: string | undefined | null): WebhookSecret {
  if (!secret) return { url: '', headers: {} };
  if (secret.trimStart().startsWith('{')) {
    try {
      const v = JSON.parse(secret) as Partial<WebhookSecret>;
      if (typeof v.url === 'string')
        return { url: v.url, headers: v.headers && typeof v.headers === 'object' ? v.headers : {} };
    } catch {
      // Not JSON after all: treat it as a URL.
    }
  }
  return { url: secret, headers: {} };
}
const Common = {
  name: z.string().trim().min(1).max(80),
  on: z.enum(['always', 'failures']).default('always'),
};
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
  // Webhook URLs contain a token: they are the stored secret.
  z.object({
    ...Common,
    kind: z.literal('slack'),
    config: SlackConfig,
    secret: WebhookUrl.optional(),
  }),
  z.object({
    ...Common,
    kind: z.literal('teams'),
    config: TeamsConfig,
    secret: WebhookUrl.optional(),
  }),
  z.object({
    ...Common,
    kind: z.literal('webhook'),
    config: WebhookConfig,
    secret: WebhookUrl.optional(),
  }),
]);
export type ChannelInput = z.infer<typeof ChannelInput>;

export type RunSummary = {
  application: string;
  environment: string;
  status: string;
  trigger: string;
  scheduleName?: string;
  /** Set for a campaign summary (all its environment × browser × screen size runs together). */
  campaignName?: string;
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
  const origin = [
    s.campaignName && `Campaign "${s.campaignName}"`,
    s.scheduleName ? `Schedule "${s.scheduleName}"` : !s.campaignName && `Trigger: ${s.trigger}`,
  ]
    .filter(Boolean)
    .join(' · ');
  const meta = `${origin} · pass rate ${s.passRate ?? '—'}% · ${dur(s.durationMs)}`;
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
    throw new Error(`Telegram could not be reached: ${networkReason(err)}`);
  }
  const body = (await res.json().catch(() => ({}))) as { ok?: boolean; description?: string };
  // Never echo the URL: it contains the bot token.
  if (!res.ok || body.ok === false)
    throw new Error(`Telegram refused the message: ${stripUrls(String(body.description ?? res.status))}`);
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

/** Pieces of a summary that every format shares. */
function parts(s: RunSummary) {
  const ok = s.status === 'passed';
  const m = formatSummary(s);
  const [head, counts, meta, ...rest] = m.text.split('\n');
  const gate = rest[0]?.startsWith('Quality gate:') ? rest[0] : '';
  const failed = s.failed.slice(0, MAX_LISTED);
  return {
    ok,
    head: head!,
    counts: counts!,
    meta: meta!,
    gate,
    failed,
    more: s.failed.length - failed.length,
  };
}

/** Slack, Mattermost and Rocket.Chat: an incoming-webhook message with a coloured attachment. */
export function formatSlack(
  s: RunSummary,
  config: z.input<typeof SlackConfig> = {},
): Record<string, unknown> {
  const c = SlackConfig.parse(config);
  const p = parts(s);
  // Slack escapes &, < and >; bold is *x* in Slack and **x** in Mattermost.
  const e = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const b = (t: string) => (c.flavor === 'mattermost' ? `**${t}**` : `*${t}*`);
  const link = (url: string, label: string) =>
    c.flavor === 'mattermost' ? `[${label}](${url})` : `<${url}|${label}>`;
  const body = [
    e(p.counts),
    `_${e(p.meta)}_`,
    ...(p.gate ? [e(p.gate)] : []),
    ...(p.failed.length
      ? [
          '',
          b('Failed tests'),
          ...p.failed.map(
            (f) =>
              `• ${e(f.name)}${f.diagnosis || f.error ? ` — ${e(String(f.diagnosis ?? f.error).slice(0, 200))}` : ''}`,
          ),
        ]
      : []),
    ...(p.more > 0 ? [`… and ${p.more} more`] : []),
    ...(s.url ? ['', link(s.url, 'Open the run')] : []),
  ].join('\n');
  const mention = !p.ok && c.mention ? `${c.mention} ` : '';
  return {
    text: `${mention}${b(e(p.head))}`,
    attachments: [
      { color: p.ok ? '#16a34a' : '#dc2626', text: body, footer: NOTIFY_CREDIT, mrkdwn_in: ['text'] },
    ],
  };
}

/** Microsoft Teams (a "Workflows" webhook): an Adaptive Card. */
export function formatTeams(s: RunSummary): Record<string, unknown> {
  const p = parts(s);
  const text = (t: string, extra: Record<string, unknown> = {}) => ({
    type: 'TextBlock',
    text: t,
    wrap: true,
    ...extra,
  });
  return {
    type: 'message',
    attachments: [
      {
        contentType: 'application/vnd.microsoft.card.adaptive',
        contentUrl: null,
        content: {
          $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
          type: 'AdaptiveCard',
          version: '1.4',
          body: [
            text(p.head, { weight: 'Bolder', size: 'Medium', color: p.ok ? 'Good' : 'Attention' }),
            text(p.counts),
            text(p.meta, { isSubtle: true, spacing: 'None' }),
            ...(p.gate ? [text(p.gate, { weight: 'Bolder' })] : []),
            ...(p.failed.length ? [text('Failed tests', { weight: 'Bolder', spacing: 'Medium' })] : []),
            ...p.failed.map((f) =>
              text(
                `- **${f.name}**${f.diagnosis || f.error ? ` — ${String(f.diagnosis ?? f.error).slice(0, 200)}` : ''}`,
                {
                  spacing: 'Small',
                },
              ),
            ),
            ...(p.more > 0 ? [text(`… and ${p.more} more`)] : []),
            text(NOTIFY_CREDIT, { isSubtle: true, size: 'Small', spacing: 'Medium' }),
          ],
          ...(s.url && { actions: [{ type: 'Action.OpenUrl', title: 'Open the run', url: s.url }] }),
        },
      },
    ],
  };
}

/** Removes anything URL-like (a webhook URL or bot API URL holds the token). */
const stripUrls = (t: string) => t.replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, '<url>');

/**
 * Why fetch failed, without its message: Node quotes the URL there ("Failed to parse URL from …",
 * "… a URL that includes credentials: https://user:pass@…"), and the URL holds the token.
 */
function networkReason(err: unknown): string {
  const e = err as { name?: string; cause?: { code?: unknown } };
  if (e.name === 'TimeoutError' || e.name === 'AbortError') return 'no answer within 15 s';
  const code = e.cause?.code;
  if (typeof code === 'string' && /^[A-Z0-9_]+$/.test(code)) return code;
  return 'the URL is invalid or the network failed';
}

/** POSTs JSON to a webhook URL; errors never include the URL (it holds the token). */
async function postJson(label: string, url: string, payload: unknown, headers: Record<string, string> = {}) {
  if (!url) throw new Error(`The ${label} webhook URL is missing`);
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    throw new Error(`${label} could not be reached: ${networkReason(err)}`);
  }
  if (!res.ok) {
    const body = stripUrls((await res.text().catch(() => '')).slice(0, 200));
    throw new Error(`${label} refused the message: ${res.status}${body ? ` ${body}` : ''}`);
  }
}

export type Channel = {
  kind: 'telegram' | 'email' | 'slack' | 'teams' | 'webhook';
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
  switch (channel.kind) {
    case 'telegram':
      await sendTelegram(channel.secret ?? '', channel.config as never, m.telegram);
      break;
    case 'email':
      await sendEmail(channel.secret, channel.config as never, m);
      break;
    case 'slack': {
      const c = SlackConfig.parse(channel.config);
      await postJson(
        c.flavor === 'mattermost' ? 'Mattermost' : 'Slack',
        channel.secret ?? '',
        formatSlack(summary, c),
      );
      break;
    }
    case 'teams':
      await postJson('Teams', channel.secret ?? '', formatTeams(summary));
      break;
    case 'webhook': {
      const s = readWebhookSecret(channel.secret);
      // Header values live in the secret; older channels kept them in the config.
      await postJson(
        'The webhook',
        s.url,
        { event: 'run.finished', summary, text: m.text },
        { ...WebhookConfig.parse(channel.config).headers, ...s.headers },
      );
      break;
    }
  }
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
