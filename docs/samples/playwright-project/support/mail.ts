// Email checks for tests exported by StepForge (by Md Zarin Tasnim), against a Mailpit server (MAILPIT_URL).

export type Email = {
  id: string;
  from: string;
  to: string[];
  subject: string;
  date: string;
  text: string;
  html: string;
  links: string[];
  attachments: string[];
};

const base = () => (process.env.MAILPIT_URL ?? 'http://127.0.0.1:8025').replace(/\/$/, '');

type Listing = {
  ID: string;
  Created: string;
  From?: { Address: string };
  To?: { Address: string }[];
  Subject: string;
  Snippet: string;
};
type Message = {
  ID: string;
  Date: string;
  From?: { Address: string };
  To?: { Address: string }[];
  Subject: string;
  Text: string;
  HTML: string;
  Attachments?: { FileName: string }[];
};

const includes = (a: string | undefined, b: unknown) =>
  b === undefined || (a ?? '').toLowerCase().includes(String(b).toLowerCase());

/** Every http(s) link in the HTML (href) and text, in order, without duplicates. */
export function links(html: string, text = ''): string[] {
  const out: string[] = [];
  const add = (u: string) => {
    const url = u
      .trim()
      .replace(/&amp;/g, '&')
      .replace(/[).,;'"\]>]+$/, '');
    if (/^https?:\/\//i.test(url) && !out.includes(url)) out.push(url);
  };
  for (const m of html.matchAll(/href\s*=\s*["']([^"']+)["']/gi)) add(m[1]!);
  for (const m of `${text}\n${html.replace(/<[^>]+>/g, ' ')}`.matchAll(/https?:\/\/[^\s<>"']+/gi)) add(m[0]);
  return out;
}

/** Waits for an email received after `since` that matches every given criterion (case-insensitive "contains"). */
export async function waitForEmail(c: {
  to?: string;
  from?: string;
  subject?: string;
  contains?: string;
  since: Date;
  timeoutMs?: number;
}): Promise<Email> {
  const deadline = Date.now() + (c.timeoutMs ?? 20_000);
  for (;;) {
    const res = await fetch(`${base()}/api/v1/messages?limit=50`);
    if (!res.ok) throw new Error(`Mailpit answered ${res.status} at ${base()}`);
    const { messages } = (await res.json()) as { messages: Listing[] };
    for (const m of messages) {
      if (Date.parse(m.Created) < c.since.getTime() - 1000) continue;
      if (!includes(m.From?.Address, c.from) || !includes(m.Subject, c.subject)) continue;
      if (c.to !== undefined && !(m.To ?? []).some((t) => includes(t.Address, c.to))) continue;
      const full = (await (await fetch(`${base()}/api/v1/message/${m.ID}`)).json()) as Message;
      if (!includes(`${full.Text}\n${full.HTML}`, c.contains)) continue;
      return {
        id: full.ID,
        from: full.From?.Address ?? '',
        to: (full.To ?? []).map((t) => t.Address),
        subject: full.Subject,
        date: full.Date,
        text: full.Text,
        html: full.HTML,
        links: links(full.HTML, full.Text),
        attachments: (full.Attachments ?? []).map((a) => a.FileName),
      };
    }
    if (Date.now() > deadline)
      throw new Error(
        `No email${c.to ? ` to ${c.to}` : ''} arrived within ${Math.round((c.timeoutMs ?? 20_000) / 1000)} s`,
      );
    await new Promise((r) => setTimeout(r, 500));
  }
}

const OTP_WORDS =
  /\b(code|otp|one[-\s]?time|passcode|pass\s?code|pin|verification|verify|confirm(?:ation)?|security|login|sign[-\s]?in|token|password)\b/i;

/** A one-time code (4–8 digits), preferring numbers next to words like "code" or "verification". */
export function otp(email: Email, minLength = 4, maxLength = 8): string {
  const text = (email.text || email.html.replace(/<[^>]+>/g, ' ')).replace(/[*_]/g, ' ');
  const found: { code: string; index: number; score: number }[] = [];
  for (const m of text.matchAll(/(?<![\d$€£#+]|\d[.,:/-])(\d{3}[ -]\d{3}|\d+)(?![\d%]|[.,:/]\d)/g)) {
    const code = m[1]!.replace(/[ -]/g, '');
    if (code.length < minLength || code.length > maxLength) continue;
    const before = text.slice(Math.max(0, m.index - 60), m.index);
    const after = text.slice(m.index + m[1]!.length, m.index + m[1]!.length + 25);
    if (/^\s*[-/]\s*\d/.test(after) || /\d\s*[-/]\s*$/.test(before)) continue;
    // Digits inside a link or an email address are never the code.
    const token = `${/\S*$/.exec(before)![0]}${m[1]!}${/^\S*/.exec(after)![0]}`;
    if (/:\/\/|@|%[0-9a-f]{2}|[?&][\w-]+=/i.test(token)) continue;
    let score = 0;
    if (OTP_WORDS.test(before)) score += 10;
    if (OTP_WORDS.test(after)) score += 4;
    if (/[:：]\s*$/.test(before) || /\bis\s*$/i.test(before)) score += 3;
    if (/^(19|20)\d\d$/.test(code)) score -= 6;
    found.push({ code, index: m.index, score });
  }
  found.sort((a, b) => b.score - a.score || a.index - b.index);
  const best = found[0];
  if (!best || (best.score <= 0 && found.length > 1))
    throw new Error(`No one-time code found in "${email.subject}"`);
  return best.code;
}

/** The first link containing `contains`, or the `index`-th link. */
export function link(email: Email, o: { contains?: string; index?: number } = {}): string {
  const pool = o.contains
    ? email.links.filter((l) => l.toLowerCase().includes(o.contains!.toLowerCase()))
    : email.links;
  const found = pool[o.index ?? 0];
  if (!found)
    throw new Error(`No link${o.contains ? ` containing "${o.contains}"` : ''} in "${email.subject}"`);
  return found;
}

/** The first capture group of `pattern` in the email text. */
export function extract(email: Email, pattern: string): string {
  const m = new RegExp(pattern, 'i').exec(`${email.text}\n${email.html}`);
  if (!m) throw new Error(`/${pattern}/ found nothing in "${email.subject}"`);
  return m[1] ?? m[0];
}

/** StepForge's "Check email" step. */
export function assertEmail(
  email: Email,
  c: {
    subjectContains?: string;
    bodyContains?: string;
    from?: string;
    hasLink?: string | boolean;
    hasAttachment?: string | boolean;
  },
): void {
  const fail = (what: string) => {
    throw new Error(`Email "${email.subject}": ${what}`);
  };
  if (c.subjectContains !== undefined && !includes(email.subject, c.subjectContains))
    fail(`subject does not contain "${c.subjectContains}"`);
  if (c.bodyContains !== undefined && !includes(`${email.text}\n${email.html}`, c.bodyContains))
    fail(`body does not contain "${c.bodyContains}"`);
  if (c.from !== undefined && !includes(email.from, c.from)) fail(`is not from "${c.from}"`);
  if (c.hasLink !== undefined && !email.links.some((l) => c.hasLink === true || includes(l, c.hasLink)))
    fail('has no matching link');
  if (
    c.hasAttachment !== undefined &&
    !email.attachments.some((a) => c.hasAttachment === true || includes(a, c.hasAttachment))
  )
    fail('has no matching attachment');
}
