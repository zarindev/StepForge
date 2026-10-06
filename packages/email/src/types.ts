/** An email as StepForge sees it, whatever inbox it came from. */
export type EmailMessage = {
  id: string;
  from: string;
  fromName: string;
  to: string[];
  cc: string[];
  subject: string;
  /** ISO 8601. */
  date: string;
  text: string;
  html: string;
  /** Absolute http(s) links found in the HTML and text, in order, without duplicates. */
  links: string[];
  attachments: { filename: string; contentType: string; size: number }[];
};

/** A cheap listing entry (no body), used to find candidates before fetching. */
export type EmailSummary = {
  id: string;
  from: string;
  to: string[];
  subject: string;
  date: string;
};

/** Which email to wait for. Text matches are case-insensitive substrings. */
export type EmailCriteria = {
  to?: string;
  from?: string;
  subject?: string;
  /** Text that must appear in the body. */
  contains?: string;
  /** Only emails received at or after this time. */
  since?: Date;
};

/** An inbox StepForge can read. */
export interface Mailbox {
  readonly kind: 'mailpit' | 'imap';
  /** Newest first. Implementations may pre-filter with `criteria`; callers still check with `matches`. */
  list(criteria: EmailCriteria, limit?: number): Promise<EmailSummary[]>;
  get(id: string): Promise<EmailMessage>;
  /** Checks the inbox is reachable; returns a short description ("Mailpit v1.31.4 · 3 messages"). */
  check(): Promise<string>;
  close(): Promise<void>;
}

export class EmailError extends Error {
  constructor(
    public readonly code: 'connection' | 'not_found' | 'config',
    message: string,
  ) {
    super(message);
    this.name = 'EmailError';
  }
}
