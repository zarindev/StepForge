import { ImapFlow, type SearchObject } from 'imapflow';
import { simpleParser, type AddressObject } from 'mailparser';
import { extractLinks } from './extract.ts';
import {
  EmailError,
  type EmailCriteria,
  type EmailMessage,
  type EmailSummary,
  type Mailbox,
} from './types.ts';

export type ImapConfig = {
  host: string;
  port?: number;
  /** TLS from the start (port 993). Default: true unless the port is 143. */
  secure?: boolean;
  user: string;
  password?: string;
  /** Folder to read. Default INBOX. */
  mailbox?: string;
  /** Accept self-signed certificates (local test servers only). */
  allowSelfSigned?: boolean;
};

const addresses = (a: AddressObject | AddressObject[] | undefined) =>
  (Array.isArray(a) ? a : a ? [a] : []).flatMap((x) => x.value.map((v) => v.address ?? '')).filter(Boolean);

/**
 * Reads any IMAP inbox (Gmail with an app password, Outlook, Fastmail, a company server…) with imapflow,
 * parsing messages with mailparser. One connection per Mailbox; call close() when done.
 */
export class ImapMailbox implements Mailbox {
  readonly kind = 'imap' as const;
  private client: ImapFlow | null = null;

  constructor(private readonly cfg: ImapConfig) {
    if (!cfg.host || !cfg.user) throw new EmailError('config', 'IMAP needs a host and a user name');
  }

  private async connect(): Promise<ImapFlow> {
    if (this.client?.usable) return this.client;
    const port = this.cfg.port ?? 993;
    const client = new ImapFlow({
      host: this.cfg.host,
      port,
      secure: this.cfg.secure ?? port !== 143,
      auth: { user: this.cfg.user, pass: this.cfg.password ?? '' },
      logger: false,
      tls: this.cfg.allowSelfSigned ? { rejectUnauthorized: false } : undefined,
      connectionTimeout: 15_000,
    });
    client.on('error', () => undefined); // surfaced through the failing call instead
    try {
      await client.connect();
    } catch (err) {
      const e = err as Error & { authenticationFailed?: boolean; responseText?: string };
      throw new EmailError(
        'connection',
        e.authenticationFailed
          ? `IMAP login failed for ${this.cfg.user}${/gmail/i.test(this.cfg.host) ? ' (Gmail needs an app password)' : ''}`
          : `Cannot connect to IMAP ${this.cfg.host}:${port}: ${e.responseText ?? e.message}`,
      );
    }
    this.client = client;
    return client;
  }

  private async withMailbox<T>(fn: (c: ImapFlow) => Promise<T>): Promise<T> {
    const c = await this.connect();
    const lock = await c.getMailboxLock(this.cfg.mailbox ?? 'INBOX');
    try {
      return await fn(c);
    } finally {
      lock.release();
    }
  }

  async list(criteria: EmailCriteria, limit = 50): Promise<EmailSummary[]> {
    return this.withMailbox(async (c) => {
      const query: SearchObject = {};
      // IMAP SINCE has day granularity; the exact time is checked by the caller.
      if (criteria.since) query.since = new Date(criteria.since.getTime() - 24 * 3600_000);
      if (criteria.to) query.to = criteria.to;
      if (criteria.from) query.from = criteria.from;
      if (criteria.subject) query.subject = criteria.subject;
      const found = await c.search(Object.keys(query).length ? query : { all: true }, { uid: true });
      const uids = (Array.isArray(found) ? found : []).sort((a, b) => b - a).slice(0, limit);
      if (uids.length === 0) return [];
      const out: EmailSummary[] = [];
      for await (const m of c.fetch(uids, { envelope: true, internalDate: true }, { uid: true })) {
        const internal = m.internalDate ? new Date(m.internalDate) : undefined;
        out.push({
          id: String(m.uid),
          from: m.envelope?.from?.[0]?.address ?? '',
          to: (m.envelope?.to ?? []).map((t) => t.address ?? '').filter(Boolean),
          subject: m.envelope?.subject ?? '',
          date: new Date(internal ?? m.envelope?.date ?? 0).toISOString(),
        });
      }
      return out.sort((a, b) => Date.parse(b.date) - Date.parse(a.date));
    });
  }

  async get(id: string): Promise<EmailMessage> {
    return this.withMailbox(async (c) => {
      const msg = await c.fetchOne(id, { source: true, internalDate: true }, { uid: true });
      if (!msg || !msg.source) throw new EmailError('not_found', `IMAP message ${id} not found`);
      const p = await simpleParser(msg.source);
      const html = typeof p.html === 'string' ? p.html : '';
      const text = p.text ?? '';
      const date = msg.internalDate ? new Date(msg.internalDate) : (p.date ?? new Date(0));
      return {
        id,
        from: addresses(p.from)[0] ?? '',
        fromName: p.from?.value[0]?.name ?? '',
        to: addresses(p.to),
        cc: addresses(p.cc),
        subject: p.subject ?? '',
        date: date.toISOString(),
        text,
        html,
        links: extractLinks(html, text),
        attachments: p.attachments.map((a) => ({
          filename: a.filename ?? 'attachment',
          contentType: a.contentType,
          size: a.size,
        })),
      };
    });
  }

  async check(): Promise<string> {
    return this.withMailbox(async (c) => {
      const status = c.mailbox;
      const n = status && typeof status === 'object' ? status.exists : 0;
      return `IMAP ${this.cfg.host} · ${this.cfg.mailbox ?? 'INBOX'} · ${n} message${n === 1 ? '' : 's'}`;
    });
  }

  async close(): Promise<void> {
    const c = this.client;
    this.client = null;
    if (c?.usable) await c.logout().catch(() => undefined);
  }
}
