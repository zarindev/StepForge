import type { EmailCriteria, EmailMessage, EmailSummary } from './types.ts';

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  '#39': "'",
};
const decodeEntities = (s: string) =>
  s
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+|#39);/gi, (m, n: string) => ENTITIES[n.toLowerCase()] ?? m);

/** Readable text from an HTML body (scripts/styles dropped, block elements become line breaks). */
export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<(script|style|head)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|tr|li|h[1-6]|table)>/gi, '\n')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

/** Every http(s) link in the HTML (href) and in the text, in document order, de-duplicated. */
export function extractLinks(html: string, text = ''): string[] {
  const out: string[] = [];
  const add = (u: string) => {
    const url = decodeEntities(u.trim()).replace(/[).,;'"\]>]+$/, '');
    if (/^https?:\/\//i.test(url) && !out.includes(url)) out.push(url);
  };
  for (const m of html.matchAll(/href\s*=\s*["']([^"']+)["']/gi)) add(m[1]!);
  for (const m of `${text}\n${html.replace(/<[^>]+>/g, ' ')}`.matchAll(/https?:\/\/[^\s<>"']+/gi)) add(m[0]);
  return out;
}

/** Picks a link: the first containing `contains` (case-insensitive), or the `index`-th (0-based). */
export function pickLink(
  links: string[],
  opts: { contains?: string; index?: number } = {},
): string | undefined {
  const pool = opts.contains
    ? links.filter((l) => l.toLowerCase().includes(opts.contains!.toLowerCase()))
    : links;
  return pool[opts.index ?? 0];
}

const OTP_WORDS =
  /\b(code|otp|one[-\s]?time|passcode|pass\s?code|pin|verification|verify|confirm(?:ation)?|security|login|sign[-\s]?in|token|password)\b/i;

/**
 * Finds a one-time code (default 4–8 digits) in an email. Codes written near the usual words ("code", "OTP",
 * "verification", "PIN"…) win; "123 456" / "123-456" groups are joined. Numbers that are part of dates, times,
 * prices, phone numbers or longer digit runs are skipped.
 */
export function extractOtp(
  body: string,
  opts: { minLength?: number; maxLength?: number } = {},
): string | undefined {
  const min = opts.minLength ?? 4;
  const max = opts.maxLength ?? 8;
  const text = body.replace(/[*_]/g, ' '); // Mailpit/markdown-ish emphasis around codes
  type Candidate = { code: string; index: number; score: number };
  const found: Candidate[] = [];
  // Not part of a longer number, a price, an order number (#123), a decimal, a time or a date.
  const re = /(?<![\d$€£#+]|\d[.,:/-])(\d{3}[ -]\d{3}|\d+)(?![\d%]|[.,:/]\d)/g;
  for (const m of text.matchAll(re)) {
    const raw = m[1]!;
    const code = raw.replace(/[ -]/g, '');
    if (code.length < min || code.length > max) continue;
    const before = text.slice(Math.max(0, m.index - 60), m.index);
    const after = text.slice(m.index + raw.length, m.index + raw.length + 25);
    // Skip things that look like years in a date, or a phone number continuing.
    if (/^\s*[-/]\s*\d/.test(after) || /\d\s*[-/]\s*$/.test(before)) continue;
    let score = 0;
    if (OTP_WORDS.test(before)) score += 10;
    if (OTP_WORDS.test(after)) score += 4;
    if (/[:：]\s*$/.test(before) || /\bis\s*$/i.test(before)) score += 3;
    if (/^(19|20)\d\d$/.test(code)) score -= 6; // a bare year
    found.push({ code, index: m.index, score });
  }
  if (found.length === 0) return undefined;
  found.sort((a, b) => b.score - a.score || a.index - b.index);
  const best = found[0]!;
  // Without any hint, only accept an unambiguous single candidate.
  if (best.score <= 0 && found.length > 1) return undefined;
  return best.code;
}

/** Applies a custom regular expression; returns the first capture group, or the whole match. */
export function extractRegex(body: string, pattern: string, flags = 'i'): string | undefined {
  let re: RegExp;
  try {
    re = new RegExp(pattern, flags.replace(/g/g, ''));
  } catch (err) {
    throw new Error(`Invalid regular expression: ${(err as Error).message}`);
  }
  const m = re.exec(body);
  return m ? (m[1] ?? m[0]) : undefined;
}

const has = (hay: string | undefined, needle: string) =>
  (hay ?? '').toLowerCase().includes(needle.toLowerCase());

/** Whether a listing entry could match (cheap, before fetching the body). */
export function summaryMatches(s: EmailSummary, c: EmailCriteria): boolean {
  if (c.since && Date.parse(s.date) < c.since.getTime()) return false;
  if (c.to && !s.to.some((t) => has(t, c.to!))) return false;
  if (c.from && !has(s.from, c.from)) return false;
  if (c.subject && !has(s.subject, c.subject)) return false;
  return true;
}

/**
 * Whether a fetched email matches. `since` is not re-checked here: it was applied to the listing's receive
 * time, while a message's own Date header has whole-second precision and may look slightly earlier.
 */
export function messageMatches(m: EmailMessage, c: EmailCriteria): boolean {
  if (!summaryMatches(m, { ...c, since: undefined })) return false;
  if (c.contains && !has(`${m.subject}\n${m.text}\n${htmlToText(m.html)}`, c.contains)) return false;
  return true;
}

/** Text used for extraction: the plain-text part, or text derived from the HTML. */
export const bodyText = (m: EmailMessage) => (m.text.trim() ? m.text : htmlToText(m.html));

export function describeCriteria(c: EmailCriteria): string {
  const parts = [
    c.to && `to ${c.to}`,
    c.from && `from ${c.from}`,
    c.subject && `with subject containing "${c.subject}"`,
    c.contains && `containing "${c.contains}"`,
  ].filter(Boolean);
  return parts.length ? parts.join(' ') : 'any';
}
