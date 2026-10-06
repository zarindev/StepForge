import { defaultParamsFor, type Locator, type StepInput } from './defaults.ts';
import { readFileSync } from 'node:fs';
import { chromium, type Browser, type BrowserContext, type Frame, type Page } from 'playwright';
import { isNoise, type CapturedRequest } from './network.ts';

const INJECTED = readFileSync(new URL('./injected.js', import.meta.url), 'utf8');
/** Navigations within this window after an action are treated as caused by it (not recorded). */
const NAV_AFTER_ACTION_MS = 2500;
const MAX_CAPTURED = 300;
const MAX_BODY = 64 * 1024;

export type RecordedStep = StepInput & { id: number; label?: string; describe?: string };
export type RecorderState = 'recording' | 'paused' | 'stopped';
export type RecorderSnapshot = {
  state: RecorderState;
  startUrl: string;
  steps: RecordedStep[];
  network: CapturedRequest[];
  /** Secret keys captured from password/masked fields (values never leave the server). */
  secretKeys: string[];
};

type ActionPayload = {
  kind: 'action';
  action: 'click' | 'dblclick' | 'fill' | 'select' | 'check' | 'uncheck' | 'press' | 'upload';
  locators: (Locator & { score?: number })[];
  describe?: string;
  value?: string;
  label?: string;
  key?: string;
  files?: string[];
  noLocator?: boolean;
  secret?: { key: string; value: string };
};
type Payload =
  | ActionPayload
  | { kind: 'state' }
  | { kind: 'control'; command: 'pause' | 'resume' | 'undo' | 'stop' }
  | { kind: 'assert'; check: string; expected?: unknown; locators: Locator[] }
  | { kind: 'extract'; from: string; varName: string; locators: Locator[] }
  | { kind: 'insert'; stepType: string };

export type StartOptions = {
  startUrl: string;
  /** Environment base URL: same-origin navigations are recorded relative to it. */
  baseUrl?: string;
  headless?: boolean;
  viewport?: { width: number; height: number };
  /** Test-only: expose Chrome DevTools Protocol on this port so automation can drive the recording browser. */
  cdpPort?: number;
  onChange?: (snapshot: RecorderSnapshot) => void;
  onStop?: (snapshot: RecorderSnapshot) => void;
};

const stripScores = (ls: (Locator & { score?: number })[]): Locator[] =>
  ls.map(({ score: _s, ...l }) => l as Locator);

/**
 * A live recording: a headed Chromium with the StepForge toolbar injected into every page/frame.
 * DOM events become steps; navigations, popups, dialogs and frames are recorded from the Playwright side.
 */
export class RecordingSession {
  state: RecorderState = 'recording';
  readonly steps: RecordedStep[] = [];
  readonly network: CapturedRequest[] = [];
  readonly secrets: Record<string, string> = {};
  page!: Page;
  private browser!: Browser;
  private context!: BrowserContext;
  private seq = 0;
  private netSeq = 0;
  private lastActionAt = 0;
  private lastUrl = '';
  private currentPage!: Page;
  private currentFrame = 'main';
  private origin = '';
  private requestStarts = new WeakMap<object, number>();

  private constructor(private readonly opts: StartOptions) {}

  static async start(opts: StartOptions): Promise<RecordingSession> {
    const s = new RecordingSession(opts);
    await s.launch();
    return s;
  }

  snapshot(): RecorderSnapshot {
    return {
      state: this.state,
      startUrl: this.opts.startUrl,
      steps: this.steps.map((x) => ({ ...x })),
      network: this.network.map((x) => ({ ...x })),
      secretKeys: Object.keys(this.secrets),
    };
  }

  private changed(): void {
    this.opts.onChange?.(this.snapshot());
  }

  private relative(url: string): string {
    try {
      const u = new URL(url);
      if (this.origin && u.origin === this.origin) return `${u.pathname}${u.search}${u.hash}`;
    } catch {
      // not a URL
    }
    return url;
  }

  private push(step: StepInput & { label?: string; describe?: string }, at?: number): RecordedStep {
    const rec = { ...step, id: ++this.seq } as RecordedStep;
    if (at !== undefined) this.steps.splice(at, 0, rec);
    else this.steps.push(rec);
    this.changed();
    return rec;
  }

  private async launch(): Promise<void> {
    try {
      this.origin = this.opts.baseUrl
        ? new URL(this.opts.baseUrl).origin
        : new URL(this.opts.startUrl).origin;
    } catch {
      this.origin = '';
    }
    this.browser = await chromium.launch({
      headless: this.opts.headless ?? false,
      args: this.opts.cdpPort ? [`--remote-debugging-port=${this.opts.cdpPort}`] : [],
    });
    this.context = await this.browser.newContext({
      viewport: this.opts.viewport ?? { width: 1280, height: 800 },
    });
    await this.context.exposeBinding('__stepforgeEmit', (source, payload: Payload) =>
      this.handle(source.page, source.frame, payload),
    );
    await this.context.addInitScript({ content: INJECTED });
    this.context.on('page', (p) => this.attach(p));
    this.browser.on('disconnected', () => this.finish());
    this.page = await this.context.newPage();
    this.currentPage = this.page;
    this.push({ type: 'ui.navigate', params: { url: this.relative(this.opts.startUrl) } });
    this.lastActionAt = Date.now();
    await this.page.goto(this.opts.startUrl).catch(() => {});
    this.lastUrl = this.page.url();
    this.lastActionAt = 0; // only user actions (not the initial load) suppress navigation steps
  }

  private attach(p: Page): void {
    p.on('framenavigated', (frame) => {
      if (frame !== p.mainFrame() || this.state !== 'recording') return;
      const url = frame.url();
      if (url === this.lastUrl || url === 'about:blank') return;
      this.lastUrl = url;
      if (p !== this.currentPage) return; // popup navigations are covered by switchTab
      if (Date.now() - this.lastActionAt > NAV_AFTER_ACTION_MS) {
        this.push({ type: 'ui.navigate', params: { url: this.relative(url) } });
        this.lastActionAt = Date.now();
      }
    });
    p.on('dialog', (d) => {
      if (this.state === 'recording') {
        // Insert before the action that opened it if that action was just recorded; otherwise append.
        const last = this.steps[this.steps.length - 1];
        const insertBefore = last && Date.now() - this.lastActionAt < 400 && last.type !== 'ui.handleDialog';
        this.push(
          {
            type: 'ui.handleDialog',
            params: { action: 'accept' },
            label: `Accept "${d.message().slice(0, 60)}"`,
          },
          insertBefore ? this.steps.length - 1 : undefined,
        );
      }
      void d.accept().catch(() => {});
    });
    p.on('request', (r) => this.requestStarts.set(r, Date.now()));
    p.on('response', async (res) => {
      const req = res.request();
      if (!['xhr', 'fetch'].includes(req.resourceType()) || isNoise(req.url()) || this.state !== 'recording')
        return;
      if (this.network.length >= MAX_CAPTURED) return;
      const contentType = res.headers()['content-type'] ?? '';
      let responseBody: unknown;
      try {
        if (/json/.test(contentType)) {
          const buf = await res.body();
          if (buf.length <= MAX_BODY) responseBody = JSON.parse(buf.toString('utf8'));
        }
      } catch {
        // body unavailable (redirect, aborted)
      }
      let requestBody: unknown = req.postData() ?? undefined;
      if (typeof requestBody === 'string') {
        try {
          requestBody = JSON.parse(requestBody);
        } catch {
          // keep raw
        }
      }
      const started = this.requestStarts.get(req);
      this.network.push({
        id: ++this.netSeq,
        method: req.method(),
        url: req.url(),
        status: res.status(),
        contentType,
        requestHeaders: await req.allHeaders().catch(() => req.headers()),
        requestBody,
        responseBody,
        durationMs: started ? Date.now() - started : undefined,
        at: Date.now(),
      });
      this.changed();
    });
    p.on('close', () => {
      if (p === this.currentPage && this.state === 'recording') {
        const remaining = this.context.pages().filter((x) => x !== p);
        if (remaining.length) {
          this.push({ type: 'ui.closeTab', params: {} });
          this.currentPage = remaining[remaining.length - 1]!;
        }
      }
    });
  }

  private async frameSelector(frame: Frame): Promise<string> {
    const el = await frame.frameElement().catch(() => null);
    if (!el) return 'iframe';
    const attr = async (n: string) => (await el.getAttribute(n).catch(() => null)) ?? '';
    const id = await attr('id');
    if (id && /^[A-Za-z][\w-]*$/.test(id)) return `#${id}`;
    const name = await attr('name');
    if (name) return `iframe[name=${JSON.stringify(name)}]`;
    const src = await attr('src');
    if (src && !src.startsWith('data:')) return `iframe[src=${JSON.stringify(src)}]`;
    const index = frame.parentFrame()?.childFrames().indexOf(frame) ?? 0;
    return `iframe >> nth=${Math.max(0, index)}`;
  }

  /** Keeps tab and frame context in sync with where the action happened. */
  private async syncContext(page: Page, frame: Frame): Promise<void> {
    if (page !== this.currentPage) {
      this.push({ type: 'ui.switchTab', params: { urlContains: new URL(page.url()).pathname } });
      this.currentPage = page;
      this.currentFrame = 'main';
    }
    const target = frame === page.mainFrame() ? 'main' : await this.frameSelector(frame);
    if (target !== this.currentFrame) {
      this.push({
        type: 'ui.switchFrame',
        params: target === 'main' ? { main: true } : { selector: target },
      });
      this.currentFrame = target;
    }
  }

  private async handle(page: Page, frame: Frame, p: Payload): Promise<unknown> {
    if (p.kind === 'state') {
      return {
        recording: this.state !== 'stopped',
        paused: this.state === 'paused',
        steps: this.steps.length,
      };
    }
    if (p.kind === 'control') {
      if (p.command === 'pause' && this.state === 'recording') this.state = 'paused';
      else if (p.command === 'resume' && this.state === 'paused') this.state = 'recording';
      else if (p.command === 'undo') this.undo();
      else if (p.command === 'stop') void this.stop();
      this.changed();
      return null;
    }
    if (this.state !== 'recording') return null;
    await this.syncContext(page, frame);
    this.lastActionAt = Date.now();

    if (p.kind === 'assert') {
      this.push({
        type: 'ui.assert',
        params: { check: p.check, ...(p.expected !== undefined && { expected: p.expected }) },
        locators: stripScores(p.locators),
      });
    } else if (p.kind === 'extract') {
      this.push({
        type: 'ui.extract',
        params: { from: p.from },
        locators: stripScores(p.locators),
        captureAs: p.varName,
      });
    } else if (p.kind === 'insert') {
      this.push({ type: p.stepType, params: defaultParamsFor(p.stepType) });
    } else {
      this.recordAction(p);
    }
    return null;
  }

  private recordAction(p: ActionPayload): void {
    const locators = p.noLocator ? [] : stripScores(p.locators);
    const last = this.steps[this.steps.length - 1];
    const sameTarget = (s: RecordedStep | undefined) =>
      !!s && JSON.stringify(s.locators?.[0]) === JSON.stringify(locators[0]);
    if (p.secret) this.secrets[p.secret.key] = p.secret.value;
    switch (p.action) {
      case 'fill':
        // Typing more into the same field replaces the previous fill (one fill per field visit).
        if (last?.type === 'ui.fill' && sameTarget(last)) {
          last.params = { value: p.value ?? '' };
          this.changed();
          return;
        }
        this.push({ type: 'ui.fill', params: { value: p.value ?? '' }, locators, describe: p.describe });
        return;
      case 'dblclick':
        // The browser fires click, click, dblclick: collapse the trailing click into the double-click.
        if (last?.type === 'ui.click' && sameTarget(last)) this.steps.pop();
        this.push({ type: 'ui.dblclick', params: {}, locators, describe: p.describe });
        return;
      case 'select':
        this.push({
          type: 'ui.select',
          params: p.label ? { label: p.label } : { value: p.value },
          locators,
          describe: p.describe,
        });
        return;
      case 'press':
        this.push({ type: 'ui.press', params: { key: p.key ?? 'Enter' }, locators, describe: p.describe });
        return;
      case 'upload':
        this.push({
          type: 'ui.upload',
          params: { files: p.files ?? [] },
          locators,
          describe: p.describe,
          label: 'Choose the file path before replaying',
        });
        return;
      default:
        this.push({ type: `ui.${p.action}`, params: {}, locators, describe: p.describe });
    }
  }

  undo(): RecordedStep | undefined {
    if (this.steps.length <= 1) return undefined; // keep the initial navigate
    const removed = this.steps.pop();
    this.changed();
    return removed;
  }

  private finish(): void {
    if (this.state === 'stopped') return;
    this.state = 'stopped';
    this.changed();
    this.opts.onStop?.(this.snapshot());
  }

  async stop(): Promise<RecorderSnapshot> {
    this.finish();
    await this.browser?.close().catch(() => {});
    return this.snapshot();
  }
}
