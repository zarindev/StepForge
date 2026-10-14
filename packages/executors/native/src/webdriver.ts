import { StepError } from '@stepforge/core';

/** The W3C WebDriver key for an element reference. */
const ELEMENT = 'element-6066-11e4-a386-3a7b2b1c0e5f';

export type ElementRef = string;

/** A WebDriver error answered by Appium (`error` is the W3C error code, e.g. "no such element"). */
export class WebDriverError extends Error {
  constructor(
    public readonly error: string,
    message: string,
  ) {
    super(message);
  }
}

/**
 * A minimal client for the standard WebDriver protocol, as spoken by Appium: only the commands StepForge needs
 * (no extra dependency).
 */
export class WebDriverSession {
  private constructor(
    private readonly base: string,
    readonly id: string,
    readonly capabilities: Record<string, unknown>,
  ) {}

  static async create(
    serverUrl: string,
    capabilities: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<WebDriverSession> {
    const base = serverUrl.replace(/\/$/, '');
    const value = (await call(
      base,
      'POST',
      '/session',
      { capabilities: { alwaysMatch: capabilities, firstMatch: [{}] } },
      timeoutMs,
    )) as { sessionId: string; capabilities: Record<string, unknown> };
    return new WebDriverSession(base, value.sessionId, value.capabilities ?? {});
  }

  private cmd(method: string, path: string, body?: unknown, timeoutMs = 60_000): Promise<unknown> {
    return call(this.base, method, `/session/${this.id}${path}`, body, timeoutMs);
  }

  async findAll(using: string, value: string): Promise<ElementRef[]> {
    const els = (await this.cmd('POST', '/elements', { using, value })) as Record<string, string>[];
    return els.map((e) => e[ELEMENT] ?? e.ELEMENT!).filter(Boolean);
  }
  click(el: ElementRef) {
    return this.cmd('POST', `/element/${el}/click`, {});
  }
  sendKeys(el: ElementRef, text: string) {
    return this.cmd('POST', `/element/${el}/value`, { text, value: [...text] });
  }
  clear(el: ElementRef) {
    return this.cmd('POST', `/element/${el}/clear`, {});
  }
  async text(el: ElementRef): Promise<string> {
    return String((await this.cmd('GET', `/element/${el}/text`)) ?? '');
  }
  async attribute(el: ElementRef, name: string): Promise<string | null> {
    const v = await this.cmd('GET', `/element/${el}/attribute/${encodeURIComponent(name)}`);
    return v === null || v === undefined ? null : String(v);
  }
  async displayed(el: ElementRef): Promise<boolean> {
    return (await this.cmd('GET', `/element/${el}/displayed`)) === true;
  }
  async enabled(el: ElementRef): Promise<boolean> {
    return (await this.cmd('GET', `/element/${el}/enabled`)) === true;
  }
  async rect(el: ElementRef): Promise<{ x: number; y: number; width: number; height: number }> {
    return (await this.cmd('GET', `/element/${el}/rect`)) as {
      x: number;
      y: number;
      width: number;
      height: number;
    };
  }
  /** A PNG of the screen (or of one element). */
  async screenshot(el?: ElementRef): Promise<Buffer> {
    const b64 = (await this.cmd('GET', el ? `/element/${el}/screenshot` : '/screenshot')) as string;
    return Buffer.from(b64, 'base64');
  }
  /** The element that has the keyboard focus, if any. */
  async activeElement(): Promise<ElementRef | undefined> {
    const e = (await this.cmd('GET', '/element/active').catch(() => null)) as Record<string, string> | null;
    return e ? (e[ELEMENT] ?? e.ELEMENT) : undefined;
  }
  async source(): Promise<string> {
    return String(await this.cmd('GET', '/source'));
  }
  back() {
    return this.cmd('POST', '/back', {});
  }
  /** Appium `mobile:` commands and scripts. */
  execute(script: string, args: unknown[] = [], timeoutMs?: number) {
    return this.cmd('POST', '/execute/sync', { script, args }, timeoutMs);
  }
  async logs(type: string): Promise<{ timestamp: number; level: string; message: string }[]> {
    return ((await this.cmd('POST', '/se/log', { type })) ?? []) as {
      timestamp: number;
      level: string;
      message: string;
    }[];
  }
  /** W3C actions: a tap, long press or swipe at screen points. */
  actions(actions: unknown[]) {
    return this.cmd('POST', '/actions', { actions });
  }
  startRecording(options: Record<string, unknown> = {}) {
    return this.cmd('POST', '/appium/start_recording_screen', { options });
  }
  /** The screen recording (MP4) since startRecording. */
  async stopRecording(): Promise<Buffer> {
    const b64 = (await this.cmd('POST', '/appium/stop_recording_screen', {}, 120_000)) as string;
    return Buffer.from(b64 ?? '', 'base64');
  }
  async quit(): Promise<void> {
    await call(this.base, 'DELETE', `/session/${this.id}`, undefined, 60_000).catch(() => {});
  }
}

async function call(
  base: string,
  method: string,
  path: string,
  body: unknown,
  timeoutMs: number,
): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(base + path, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      ...(body !== undefined && { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const e = err as Error;
    if (e.name === 'TimeoutError')
      throw new StepError('timeout', `Appium did not answer within ${Math.round(timeoutMs / 1000)} s`);
    throw new StepError('network', `Appium is not reachable at ${base}: ${e.message}`);
  }
  const text = await res.text();
  let json: { value?: unknown } = {};
  try {
    json = text ? (JSON.parse(text) as { value?: unknown }) : {};
  } catch {
    throw new WebDriverError('unknown error', `Appium answered ${res.status}: ${text.slice(0, 200)}`);
  }
  const v = json.value as { error?: string; message?: string } | undefined;
  if (!res.ok || (v && typeof v === 'object' && 'error' in v && v.error)) {
    throw new WebDriverError(v?.error ?? `HTTP ${res.status}`, (v?.message ?? text).split('\n')[0]!);
  }
  return json.value;
}
