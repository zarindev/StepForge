import {
  StepError,
  type ArtifactRef,
  type AssertionResult,
  type Executor,
  type ExecutorSession,
  type RunnableStep,
  type StepContext,
  type StepOutcome,
} from '@stepforge/core';
import {
  bodyText,
  extractOtp,
  extractRegex,
  htmlToText,
  pickLink,
  waitForEmail,
  type EmailMessage,
  type Mailbox,
} from '@stepforge/email';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Opens a mailbox by inbox name (or the application's default inbox when `ref` is empty). Provided by the host. */
export type InboxResolver = (ref?: string) => Promise<Mailbox>;

/** Minimal view of the Playwright page the UI executor shares, so this package does not depend on Playwright. */
type SharedPage = {
  goto(url: string, opts: { timeout: number; waitUntil: 'load' }): Promise<{ status(): number } | null>;
  url(): string;
};

const MAX_HTML = 200_000;
const MAX_TEXT = 20_000;
/** Emails may be sent a moment before the test's clock says it started (clock skew between processes). */
const SINCE_SKEW_MS = 2000;

const isTrue = (v: unknown) => v === true || v === 'true';

function mapError(err: unknown): StepError {
  if (err instanceof StepError) return err;
  const e = err as Error & { code?: string };
  if (e.name === 'EmailTimeoutError') return new StepError('timeout', e.message);
  if (e.name === 'EmailError')
    return new StepError(
      e.code === 'config' ? 'invalid_params' : e.code === 'not_found' ? 'assertion' : 'network',
      e.message,
    );
  return new StepError('unknown', e.message);
}

/** The email as stored on a step result (preview in run results); large bodies are cut. */
function preview(m: EmailMessage, inbox: string) {
  return {
    inbox,
    id: m.id,
    from: m.fromName ? `${m.fromName} <${m.from}>` : m.from,
    to: m.to,
    cc: m.cc,
    subject: m.subject,
    date: m.date,
    text: m.text.slice(0, MAX_TEXT),
    html: m.html.slice(0, MAX_HTML),
    links: m.links,
    attachments: m.attachments,
  };
}

/** Assertion targets on an email. */
export function emailTarget(m: EmailMessage, target: string): unknown {
  switch (target) {
    case 'subject':
      return m.subject;
    case 'from':
      return m.from;
    case 'fromName':
      return m.fromName;
    case 'to':
      return m.to;
    case 'cc':
      return m.cc;
    case 'text':
    case 'body':
      return bodyText(m);
    case 'html':
      return m.html;
    case 'links':
      return m.links;
    case 'linkCount':
      return m.links.length;
    case 'attachments':
      return m.attachments.map((a) => a.filename);
    case 'attachmentCount':
      return m.attachments.length;
    case 'date':
      return m.date;
    default:
      return undefined;
  }
}

class EmailSession implements ExecutorSession {
  private boxes = new Map<string, Mailbox>();
  private last: { message: EmailMessage; inbox: string } | null = null;
  private artifacts: ArtifactRef[] = [];

  constructor(private readonly resolve: InboxResolver) {}

  private async box(ref: unknown): Promise<{ box: Mailbox; name: string }> {
    const name = String(ref ?? '').trim();
    const cached = this.boxes.get(name);
    if (cached) return { box: cached, name: name || 'default' };
    let box: Mailbox;
    try {
      box = await this.resolve(name || undefined);
    } catch (err) {
      throw new StepError('invalid_params', (err as Error).message);
    }
    this.boxes.set(name, box);
    return { box, name: name || 'default' };
  }

  private requireLast(type: string): { message: EmailMessage; inbox: string } {
    if (!this.last)
      throw new StepError('invalid_params', `${type} needs an earlier email.waitForEmail step in this test`);
    return this.last;
  }

  async execute(step: RunnableStep, ctx: StepContext): Promise<StepOutcome> {
    const p = step.params as Record<string, unknown>;
    try {
      switch (step.type) {
        case 'email.waitForEmail':
          return await this.wait(p, step, ctx);
        case 'email.assertEmail':
          return this.assertEmail(p);
        case 'email.extractFromEmail':
          return this.extract(p);
        case 'email.openEmailLink':
          return await this.open(p, ctx);
        default:
          throw new StepError('unsupported', `Unknown email step "${step.type}"`);
      }
    } catch (err) {
      throw mapError(err);
    }
  }

  private async wait(p: Record<string, unknown>, step: RunnableStep, ctx: StepContext): Promise<StepOutcome> {
    const criteria = {
      to: p.to ? String(p.to) : undefined,
      from: p.from ? String(p.from) : undefined,
      subject: p.subject ? String(p.subject) : undefined,
      contains: p.contains ? String(p.contains) : undefined,
      since: p.since === 'any' ? undefined : new Date(ctx.startedAt - SINCE_SKEW_MS),
    };
    if (!criteria.to && !criteria.subject && !criteria.from)
      throw new StepError('invalid_params', 'email.waitForEmail needs at least "to", "from" or "subject"');
    const { box, name } = await this.box(p.inbox);
    const started = Date.now();
    // Leave a little room inside the engine's step timeout to report a clear message.
    const timeoutMs = Math.max(500, ctx.timeoutMs - 500);
    const m = await waitForEmail(box, criteria, {
      timeoutMs,
      pollMs: Number(p.pollMs ?? 1000),
      signal: ctx.signal,
    });
    this.last = { message: m, inbox: name };
    this.save(m, step.position, ctx);
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    return {
      message: `Received "${m.subject}" from ${m.from} after ${secs} s`,
      output: {
        id: m.id,
        from: m.from,
        to: m.to,
        subject: m.subject,
        date: m.date,
        text: bodyText(m).slice(0, MAX_TEXT),
        links: m.links,
        attachments: m.attachments.map((a) => a.filename),
      },
      email: preview(m, name),
      getTarget: (t) => (t === 'waitMs' ? Date.now() - started : emailTarget(m, t)),
      metrics: [{ metric: 'email.delivery_wait', value: Date.now() - started, unit: 'ms' }],
    };
  }

  private save(m: EmailMessage, position: number, ctx: StepContext) {
    try {
      const dir = join(ctx.artifactsDir, 'emails');
      mkdirSync(dir, { recursive: true });
      const base = join(dir, `email-${String(position + 1).padStart(2, '0')}`);
      writeFileSync(`${base}.json`, JSON.stringify(preview(m, this.last?.inbox ?? ''), null, 2));
      this.artifacts.push({ kind: 'email', path: `${base}.json` });
    } catch {
      // evidence is best-effort
    }
  }

  private assertEmail(p: Record<string, unknown>): StepOutcome {
    const { message: m, inbox } = this.requireLast('email.assertEmail');
    const text = `${bodyText(m)}\n${htmlToText(m.html)}`;
    const checks: AssertionResult[] = [];
    const add = (
      target: string,
      operator: string,
      expected: unknown,
      actual: unknown,
      passed: boolean,
      ok: string,
      bad: string,
    ) => checks.push({ target, operator, expected, actual, passed, message: passed ? ok : bad });
    if (p.subjectContains) {
      const e = String(p.subjectContains);
      add(
        'subject',
        'contains',
        e,
        m.subject,
        m.subject.toLowerCase().includes(e.toLowerCase()),
        `Subject contains "${e}"`,
        `Expected the subject to contain "${e}", but it is "${m.subject}"`,
      );
    }
    if (p.bodyContains) {
      const e = String(p.bodyContains);
      add(
        'body',
        'contains',
        e,
        undefined,
        text.toLowerCase().includes(e.toLowerCase()),
        `Body contains "${e}"`,
        `Expected the email body to contain "${e}"`,
      );
    }
    if (p.from) {
      const e = String(p.from);
      add(
        'from',
        'contains',
        e,
        m.from,
        `${m.fromName} ${m.from}`.toLowerCase().includes(e.toLowerCase()),
        `Sent by ${m.from}`,
        `Expected the sender to be "${e}", but it is ${m.from}`,
      );
    }
    if (p.hasLink !== undefined && p.hasLink !== false && p.hasLink !== '') {
      const want = isTrue(p.hasLink) ? undefined : String(p.hasLink);
      const link = pickLink(m.links, { contains: want });
      add(
        'links',
        'contains',
        want ?? 'any link',
        m.links,
        !!link,
        want ? `Has a link containing "${want}"` : `Has ${m.links.length} link(s)`,
        want
          ? `Expected a link containing "${want}" (links: ${m.links.join(', ') || 'none'})`
          : 'Expected the email to contain a link',
      );
    }
    if (p.hasAttachment !== undefined && p.hasAttachment !== false && p.hasAttachment !== '') {
      const want = isTrue(p.hasAttachment) ? undefined : String(p.hasAttachment).toLowerCase();
      const names = m.attachments.map((a) => a.filename);
      const ok = want ? names.some((n) => n.toLowerCase().includes(want)) : names.length > 0;
      add(
        'attachments',
        'contains',
        want ?? 'any attachment',
        names,
        ok,
        want ? `Has the attachment "${want}"` : `Has ${names.length} attachment(s)`,
        want
          ? `Expected an attachment named like "${want}" (found: ${names.join(', ') || 'none'})`
          : 'Expected the email to have an attachment',
      );
    }
    return {
      message: `Checked "${m.subject}"`,
      output: m.subject,
      email: preview(m, inbox),
      assertions: checks,
      getTarget: (t) => emailTarget(m, t),
    };
  }

  private extract(p: Record<string, unknown>): StepOutcome {
    const { message: m } = this.requireLast('email.extractFromEmail');
    const kind = String(p.kind ?? 'otp');
    const body = `${m.subject}\n${bodyText(m)}`;
    let value: string | undefined;
    let what: string;
    if (kind === 'otp') {
      const min = Number(p.minLength ?? 4);
      const max = Number(p.maxLength ?? 8);
      value = extractOtp(body, { minLength: min, maxLength: max });
      what = `a one-time code (${min}–${max} digits near words like "code", "OTP", "verification")`;
    } else if (kind === 'link') {
      value = pickLink(m.links, {
        contains: p.contains ? String(p.contains) : undefined,
        index: Number(p.index ?? 0),
      });
      what = p.contains ? `a link containing "${String(p.contains)}"` : 'a link';
    } else if (kind === 'regex') {
      if (!p.pattern)
        throw new StepError('invalid_params', 'extractFromEmail with kind "regex" needs a "pattern"');
      try {
        value = extractRegex(`${body}\n${m.html}`, String(p.pattern), String(p.flags ?? 'i'));
      } catch (err) {
        throw new StepError('invalid_params', (err as Error).message);
      }
      what = `a match for /${String(p.pattern)}/`;
    } else throw new StepError('invalid_params', `Unknown extract kind "${kind}" (use otp, link or regex)`);
    if (value === undefined)
      throw new StepError('assertion', `Could not find ${what} in the email "${m.subject}"`);
    return {
      output: value,
      message: `Extracted ${kind === 'otp' ? 'code' : kind} ${value.length > 120 ? `${value.slice(0, 117)}…` : value}`,
      getTarget: (t) => (t === 'value' ? value : emailTarget(m, t)),
    };
  }

  private async open(p: Record<string, unknown>, ctx: StepContext): Promise<StepOutcome> {
    let url = p.url ? String(p.url) : undefined;
    if (!url) {
      const { message: m } = this.requireLast('email.openEmailLink');
      url = pickLink(m.links, {
        contains: p.contains ? String(p.contains) : undefined,
        index: Number(p.index ?? 0),
      });
      if (!url)
        throw new StepError(
          'assertion',
          `The email "${m.subject}" has no link${p.contains ? ` containing "${String(p.contains)}"` : ''} (links: ${m.links.join(', ') || 'none'})`,
        );
    }
    const page = ctx.shared.get('ui.page') as SharedPage | undefined;
    if (page) {
      // Open it in the test's browser so the following UI steps continue on that page.
      const res = await page.goto(url, { timeout: ctx.timeoutMs, waitUntil: 'load' });
      const status = res?.status() ?? 0;
      return {
        message: `Opened ${url} in the browser (${status || 'no response'})`,
        output: page.url(),
        getTarget: (t) => (t === 'status' ? status : t === 'url' ? page.url() : undefined),
      };
    }
    let res: Response;
    try {
      res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(ctx.timeoutMs) });
    } catch (err) {
      throw new StepError('network', `Could not open ${url}: ${(err as Error).message}`);
    }
    const body = (await res.text()).slice(0, 5000);
    return {
      message: `GET ${url} → ${res.status} (no browser open in this test, so the link was requested directly)`,
      output: res.url,
      getTarget: (t) =>
        t === 'status' ? res.status : t === 'url' ? res.url : t === 'text' ? body : undefined,
    };
  }

  async close(): Promise<ArtifactRef[]> {
    const boxes = [...this.boxes.values()];
    this.boxes.clear();
    await Promise.all(boxes.map((b) => b.close().catch(() => undefined)));
    return this.artifacts;
  }
}

export function createEmailExecutor(opts: { resolve: InboxResolver }): Executor {
  return {
    group: 'email',
    async createSession() {
      return new EmailSession(opts.resolve);
    },
  };
}
