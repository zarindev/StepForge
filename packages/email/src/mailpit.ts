import { extractLinks } from './extract.ts';
import {
  EmailError,
  type EmailCriteria,
  type EmailMessage,
  type EmailSummary,
  type Mailbox,
} from './types.ts';

type Addr = { Name?: string; Address: string };
type MpSummary = { ID: string; From: Addr | null; To: Addr[] | null; Subject: string; Created: string };
type MpMessage = {
  ID: string;
  From: Addr | null;
  To: Addr[] | null;
  Cc: Addr[] | null;
  Subject: string;
  Date: string;
  Text: string;
  HTML: string;
  Attachments: { FileName: string; ContentType: string; Size: number }[] | null;
};

/** Reads a Mailpit inbox through its REST API (https://mailpit.axllent.org/docs/api-v1/). */
export class MailpitMailbox implements Mailbox {
  readonly kind = 'mailpit' as const;
  private readonly base: string;

  constructor(url: string) {
    this.base = url.replace(/\/+$/, '');
  }

  private async call<T>(path: string, init?: RequestInit): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.base}${path}`, { ...init, signal: AbortSignal.timeout(10_000) });
    } catch {
      throw new EmailError(
        'connection',
        `Cannot reach Mailpit at ${this.base}. Start it in Settings → Email, or check the inbox URL.`,
      );
    }
    if (res.status === 404) throw new EmailError('not_found', `Mailpit: ${path} not found`);
    if (!res.ok) throw new EmailError('connection', `Mailpit answered ${res.status} for ${path}`);
    return (res.headers.get('content-type')?.includes('json') ? res.json() : res.text()) as Promise<T>;
  }

  async list(criteria: EmailCriteria, limit = 200): Promise<EmailSummary[]> {
    // Mailpit's search narrows by recipient server-side; everything else is checked by the caller.
    const path = criteria.to
      ? `/api/v1/search?query=${encodeURIComponent(`to:"${criteria.to}"`)}&limit=${limit}`
      : `/api/v1/messages?limit=${limit}`;
    const data = await this.call<{ messages: MpSummary[] }>(path);
    return (data.messages ?? []).map((m) => ({
      id: m.ID,
      from: m.From?.Address ?? '',
      to: (m.To ?? []).map((t) => t.Address),
      subject: m.Subject,
      date: new Date(m.Created).toISOString(),
    }));
  }

  async get(id: string): Promise<EmailMessage> {
    const m = await this.call<MpMessage>(`/api/v1/message/${encodeURIComponent(id)}`);
    return {
      id: m.ID,
      from: m.From?.Address ?? '',
      fromName: m.From?.Name ?? '',
      to: (m.To ?? []).map((t) => t.Address),
      cc: (m.Cc ?? []).map((t) => t.Address),
      subject: m.Subject,
      date: new Date(m.Date).toISOString(),
      text: m.Text ?? '',
      html: m.HTML ?? '',
      links: extractLinks(m.HTML ?? '', m.Text ?? ''),
      attachments: (m.Attachments ?? []).map((a) => ({
        filename: a.FileName,
        contentType: a.ContentType,
        size: a.Size,
      })),
    };
  }

  /** Deletes every message (used by the inbox viewer's "Clear"). */
  async clear(): Promise<void> {
    await this.call('/api/v1/messages', { method: 'DELETE' });
  }

  async check(): Promise<string> {
    const info = await this.call<{ Version: string; Messages: number }>('/api/v1/info');
    return `Mailpit ${info.Version} · ${info.Messages} message${info.Messages === 1 ? '' : 's'}`;
  }

  async close(): Promise<void> {}
}
