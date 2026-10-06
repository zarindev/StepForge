import { describeCriteria, messageMatches, summaryMatches } from './extract.ts';
import type { EmailCriteria, EmailMessage, Mailbox } from './types.ts';

export class EmailTimeoutError extends Error {
  constructor(
    message: string,
    public readonly checked: number,
  ) {
    super(message);
    this.name = 'EmailTimeoutError';
  }
}

/**
 * Polls a mailbox until an email matching `criteria` arrives (newest match wins), or the timeout expires.
 * Emails already examined are not fetched again.
 */
export async function waitForEmail(
  box: Mailbox,
  criteria: EmailCriteria,
  opts: { timeoutMs?: number; pollMs?: number; signal?: AbortSignal } = {},
): Promise<EmailMessage> {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const pollMs = opts.pollMs ?? 1000;
  const deadline = Date.now() + timeoutMs;
  const rejected = new Set<string>();
  let seen = 0;
  for (;;) {
    if (opts.signal?.aborted) throw new Error('Run cancelled');
    const list = await box.list(criteria);
    seen = Math.max(seen, list.length);
    for (const s of list) {
      if (rejected.has(s.id) || !summaryMatches(s, criteria)) continue;
      const m = await box.get(s.id);
      if (messageMatches(m, criteria)) return m;
      rejected.add(s.id); // body did not match `contains`
    }
    if (Date.now() + pollMs > deadline) break;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new EmailTimeoutError(
    `No email ${describeCriteria(criteria)} arrived within ${Math.round(timeoutMs / 1000)} s` +
      (criteria.since ? ' after the test started' : '') +
      ` (${seen} recent message${seen === 1 ? '' : 's'} checked)`,
    seen,
  );
}
