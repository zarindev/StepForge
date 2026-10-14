import {
  StepError,
  type ArtifactRef,
  type ExecutorSession,
  type RunnableStep,
  type StepContext,
  type StepOutcome,
  type TestContext,
  type ProbeRequest,
  summarizeNetwork,
  formatBytes,
  type NetworkEntry as CoreNetworkEntry,
} from '@stepforge/core';
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { JSONPath } from 'jsonpath-plus';
import {
  devices,
  type Browser,
  type BrowserContext,
  type ElectronApplication,
  type Dialog,
  type Locator,
  type Page,
  type Response,
  type Route,
} from 'playwright';
import type { UiExecutorOptions } from './index.ts';
import { launchElectron } from './electron.ts';
import { baselineKey, compareWithBaseline, urlMatcher } from './visual.ts';
import { highlight, inspectFailure } from './inspect.ts';
import { buildLocator, resolveLocator, type Resolved, type Scope } from './locators.ts';
import { checkPageMetrics, collectPageMetrics, WEB_VITALS_INIT_SCRIPT } from '@stepforge/perf';

type NetworkEntry = CoreNetworkEntry & { startedAt: number };
type ConsoleEntry = { type: string; text: string; location?: string; at: number };
type SeenResponse = { response: Response; consumed: boolean };

/** Browser identities for phone and tablet runs, so sites that detect mobile browsers serve their mobile version. */
const DEVICE_PROFILE = {
  mobile: { chromium: 'Pixel 7', webkit: 'iPhone 14' },
  tablet: { chromium: 'Galaxy Tab S4', webkit: 'iPad (gen 7)' },
} as const;
const MAX_RESPONSES = 300;

const MAX_LOG_ENTRIES = 1000;
/** Requests kept per test; past this they are only counted (per step), so a network summary can say it is incomplete. */
const MAX_NETWORK_ENTRIES = 5000;
const pad = (n: number) => String(n + 1).padStart(2, '0');
/** Playwright errors are multi-line; the first line is the useful part. */
const firstLine = (e: unknown) =>
  String((e as Error)?.message ?? e)
    .split('\n')[0]!
    .replace(/^(locator|page)\.\w+: /, '');

/** Playwright's call log says why an action never happened; keep the covering element when there is one. */
function reason(err: unknown): string | undefined {
  const line = String((err as Error)?.message ?? '')
    .split('\n')
    .reverse()
    .find((l) => /intercepts pointer events|not receiving pointer events/.test(l));
  return line?.trim().replace(/^-\s*/, '').slice(0, 300);
}

function mapError(err: unknown): never {
  if ((err as { name?: string })?.name === 'StepError') throw err;
  const name = (err as Error)?.name;
  const why = reason(err);
  const msg = why ? `${firstLine(err)} ${why}` : firstLine(err);
  if (name === 'TimeoutError') throw new StepError('timeout', msg);
  if (/net::|NS_ERROR|ECONNREFUSED|Could not connect/i.test(msg)) throw new StepError('network', msg);
  throw new StepError('unknown', msg);
}

export class UiSession implements ExecutorSession {
  private pages: Page[] = [];
  private page!: Page;
  private scope!: Scope;
  private context!: BrowserContext;
  private network: NetworkEntry[] = [];
  /** Requests kept (counted when they finish, before their sizes are read, so the cap holds). */
  private keptRequests = 0;
  /** Requests not kept (past MAX_NETWORK_ENTRIES), by step (-1: before the first step). */
  private droppedRequests = new Map<number, number>();
  private consoleLog: ConsoleEntry[] = [];
  private pendingDialog: { action: 'accept' | 'dismiss'; promptText?: string } | null = null;
  private failureArtifacts: ArtifactRef[] = [];
  private videoDir: string;
  /** Responses seen so far; `ui.waitForResponse` takes the first one not taken yet. */
  private responses: SeenResponse[] = [];
  /** Active `ui.mockRoute` mocks by method and URL pattern (a new mock for both replaces the old one). */
  private mocks = new Map<
    string,
    { pattern: string; matcher: (u: URL) => boolean; handler: (r: Route) => Promise<void> }
  >();
  private touch = false;
  private electronApp?: ElectronApplication;
  /** The step running now, so each request records which step made it. */
  private currentStep = -1;
  private lastNavigation = -1;

  constructor(
    /** Not used for an Electron app (it brings its own windows). */
    private readonly browser: Browser | null,
    private readonly ctx: TestContext,
    private readonly options: UiExecutorOptions = {},
  ) {
    this.videoDir = join(ctx.artifactsDir, '.video');
  }

  async open(): Promise<void> {
    const o = this.ctx.options;
    const settings = o.browserSettings ?? {};
    mkdirSync(this.ctx.artifactsDir, { recursive: true });
    if (o.electron) return this.openElectron();
    if (!this.browser) throw new StepError('unsupported', 'No browser for this test');
    // Phones and tablets: touch, and (Chromium/WebKit) a mobile browser identity. Firefox has no mobile mode.
    const device = o.device && o.device !== 'desktop' ? o.device : undefined;
    const profile =
      device && o.browser !== 'firefox' ? devices[DEVICE_PROFILE[device][o.browser]] : undefined;
    this.touch = !!device;
    const { channel: _channel, ...contextSettings } = settings;
    this.context = await this.browser.newContext({
      viewport: o.viewport,
      baseURL: o.baseUrl,
      ignoreHTTPSErrors: true,
      ...(device && { hasTouch: true }),
      ...(profile && {
        isMobile: o.browser === 'chromium',
        userAgent: profile.userAgent,
        deviceScaleFactor: profile.deviceScaleFactor,
      }),
      ...contextSettings,
      ...(o.video !== 'off' && { recordVideo: { dir: this.videoDir, size: o.viewport } }),
    });
    // Web Vitals for perf.pageMetrics and per-navigation metrics; scoped, adds no page globals besides a hidden store.
    await this.context.addInitScript(WEB_VITALS_INIT_SCRIPT);
    if (o.trace !== 'off')
      await this.context.tracing.start({ screenshots: true, snapshots: true, sources: false });
    this.context.on('page', (p) => this.track(p));
    this.page = await this.context.newPage();
    this.scope = this.page;
    this.ctx.shared.set('ui.page', this.page);
  }

  /** An Electron desktop app: its windows are the test's pages (a new window is like a new tab). */
  private async openElectron(): Promise<void> {
    const o = this.ctx.options;
    this.electronApp = await launchElectron(o.electron!, {
      timeoutMs: o.defaultTimeoutMs,
      ...(o.video !== 'off' && { recordVideoDir: this.videoDir }),
    });
    this.context = this.electronApp.context();
    if (o.trace !== 'off')
      await this.context.tracing.start({ screenshots: true, snapshots: true, sources: false });
    this.electronApp.on('window', (p) => this.track(p));
    this.page = await this.electronApp.firstWindow({ timeout: Math.max(o.defaultTimeoutMs, 30_000) });
    await this.page.waitForLoadState('domcontentloaded').catch(() => {});
    this.track(this.page);
    this.scope = this.page;
    this.ctx.shared.set('ui.page', this.page);
  }

  private track(p: Page): void {
    if (this.pages.includes(p)) return;
    this.pages.push(p);
    p.on('console', (m) => {
      if (this.consoleLog.length < MAX_LOG_ENTRIES) {
        const loc = m.location();
        this.consoleLog.push({
          type: m.type(),
          text: m.text(),
          location: loc.url ? `${loc.url}:${loc.lineNumber}` : undefined,
          at: Date.now(),
        });
      }
    });
    p.on('pageerror', (e) =>
      this.consoleLog.push({
        type: 'pageerror',
        text: `${e.name}: ${e.message}`,
        location: e.stack?.split('\n')[1]?.trim(),
        at: Date.now(),
      }),
    );
    p.on('requestfinished', async (r) => {
      const step = this.currentStep;
      if (this.keptRequests >= this.maxNetworkEntries) return this.dropRequest(step);
      this.keptRequests++;
      const res = await r.response().catch(() => null);
      const sizes = await r.sizes().catch(() => null);
      const t = r.timing();
      this.network.push({
        method: r.method(),
        url: r.url(),
        status: res?.status(),
        resourceType: r.resourceType(),
        durationMs: t.responseEnd > 0 ? Math.round(t.responseEnd) : undefined,
        bytes: sizes ? sizes.responseBodySize + sizes.responseHeadersSize : undefined,
        startedAt: Math.round(t.startTime),
        ...(step >= 0 && { step }),
      });
    });
    p.on('response', (r) => {
      this.responses.push({ response: r, consumed: false });
      if (this.responses.length > MAX_RESPONSES)
        this.responses.splice(0, this.responses.length - MAX_RESPONSES);
    });
    p.on('requestfailed', (r) => {
      if (this.keptRequests >= this.maxNetworkEntries) this.dropRequest(this.currentStep);
      else {
        this.keptRequests++;
        this.network.push({
          method: r.method(),
          url: r.url(),
          resourceType: r.resourceType(),
          failure: r.failure()?.errorText,
          startedAt: Date.now(),
          ...(this.currentStep >= 0 && { step: this.currentStep }),
        });
      }
    });
    p.on('dialog', (d: Dialog) => {
      const pending = this.pendingDialog;
      this.pendingDialog = null;
      this.ctx.log('info', `Dialog (${d.type()}): ${d.message()}`);
      if (pending?.action === 'accept') void d.accept(pending.promptText).catch(() => {});
      else void d.dismiss().catch(() => {});
    });
  }

  private get maxNetworkEntries(): number {
    return this.options.maxNetworkEntries ?? MAX_NETWORK_ENTRIES;
  }

  private dropRequest(step: number): void {
    this.droppedRequests.set(step, (this.droppedRequests.get(step) ?? 0) + 1);
  }

  private resolve(step: RunnableStep, ctx: StepContext, locators = step.locators): Promise<Resolved> {
    return resolveLocator(this.scope, locators, ctx.timeoutMs, ctx.signal);
  }

  /** Page conditions for util.if / util.loop: polls until the check holds or the (short) wait runs out. */
  async probe(req: ProbeRequest, ctx: StepContext): Promise<{ ok: boolean; detail: string }> {
    if (!req.locators.length) throw new StepError('invalid_params', 'A page condition needs an element');
    const locs: Locator[] = [];
    for (const c of req.locators) {
      const l = buildLocator(this.scope, c);
      try {
        await l.count();
        locs.push(l);
      } catch {
        // invalid selector for this strategy
      }
    }
    if (!locs.length) throw new StepError('invalid_params', 'None of the condition’s locators is valid');
    const el = locs.reduce((a, b) => a.or(b));
    const expected = req.expected === undefined || req.expected === null ? '' : String(req.expected);
    const check = async (): Promise<[boolean, string]> => {
      const n = await el.count();
      const first = el.first();
      switch (req.check) {
        case 'present':
          return [n > 0, `${n} found`];
        case 'absent':
          return [n === 0, `${n} found`];
        case 'visible': {
          const v = n > 0 && (await first.isVisible());
          return [v, v ? 'visible' : n ? 'present but not visible' : 'not found'];
        }
        case 'hidden': {
          const v = n > 0 && (await first.isVisible());
          return [!v, v ? 'visible' : 'not visible'];
        }
        case 'enabled': {
          const e = n > 0 && (await first.isEnabled());
          return [e, n ? (e ? 'enabled' : 'disabled') : 'not found'];
        }
        case 'textContains': {
          const text = n ? ((await first.textContent()) ?? '') : '';
          return [n > 0 && text.includes(expected), n ? `text "${text.trim().slice(0, 80)}"` : 'not found'];
        }
        case 'count':
          return [n === Number(expected), `${n} found`];
      }
    };
    const deadline = Date.now() + Math.max(0, req.timeoutMs);
    for (;;) {
      if (ctx.signal.aborted) throw new StepError('aborted', 'Run was cancelled');
      const [ok, detail] = await check().catch((): [boolean, string] => [false, 'not ready']);
      if (ok || Date.now() >= deadline) return { ok, detail };
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  async execute(step: RunnableStep, ctx: StepContext): Promise<StepOutcome> {
    if (!this.pages.includes(this.page)) this.track(this.page);
    this.currentStep = step.position;
    const p = step.params as Record<string, unknown>;
    const name = step.type.split('.')[1]!;
    const timeout = ctx.timeoutMs;
    let resolved: Resolved | undefined;
    const needs = () => this.resolve(step, ctx).then((r) => (resolved = r));
    let outcome: StepOutcome = {};

    try {
      switch (name) {
        case 'navigate': {
          this.lastNavigation = step.position;
          const url = String(p.url ?? '');
          if (!url) throw new StepError('invalid_params', 'navigate needs a "url"');
          const res = await this.page.goto(url, { waitUntil: (p.waitUntil as 'load') ?? 'load', timeout });
          this.scope = this.page;
          outcome = {
            message: `Opened ${this.page.url()}${res ? ` (${res.status()})` : ''}`,
            output: this.page.url(),
          };
          const status = res?.status();
          outcome.getTarget = (t) => (t === 'status' ? status : this.pageTarget(t));
          if (this.ctx.options.pageMetrics) {
            const m = await collectPageMetrics(this.page, { timeoutMs: timeout });
            outcome.metrics = checkPageMetrics(m).rows;
            outcome.perf = { kind: 'pageMetrics', metrics: m };
          }
          break;
        }
        case 'click':
        case 'dblclick':
        case 'hover':
        case 'tap': {
          await needs();
          // x/y: a point inside the element (canvas apps, maps, charts), from its top-left corner.
          const position =
            p.x !== undefined && p.x !== '' && p.y !== undefined && p.y !== ''
              ? { x: Number(p.x), y: Number(p.y) }
              : undefined;
          const opts = { timeout, force: !!p.force, trial: false, ...(position && { position }) };
          if (name === 'click')
            await resolved!.locator.click({ ...opts, button: (p.button as 'left') ?? 'left' });
          else if (name === 'dblclick') await resolved!.locator.dblclick(opts);
          else if (name === 'tap') {
            if (!this.touch)
              throw new StepError(
                'invalid_params',
                'Tapping needs a touch screen: run on the phone or tablet size',
              );
            await resolved!.locator.tap(opts);
          } else await resolved!.locator.hover(opts);
          break;
        }
        case 'rightclick':
          await needs();
          await resolved!.locator.click({ button: 'right', timeout });
          break;
        case 'fill':
          await needs();
          await resolved!.locator.fill(String(p.value ?? ''), { timeout });
          break;
        case 'type':
          await needs();
          await resolved!.locator.pressSequentially(String(p.value ?? ''), {
            delay: Number(p.delay ?? 30),
            timeout,
          });
          break;
        case 'clear':
          await needs();
          await resolved!.locator.clear({ timeout });
          break;
        case 'press':
          if (step.locators.length) {
            await needs();
            await resolved!.locator.press(String(p.key ?? 'Enter'), { timeout });
          } else await this.page.keyboard.press(String(p.key ?? 'Enter'));
          break;
        case 'select': {
          await needs();
          const option =
            p.label !== undefined
              ? { label: String(p.label) }
              : p.index !== undefined
                ? { index: Number(p.index) }
                : String(p.value ?? '');
          const chosen = await resolved!.locator.selectOption(option, { timeout });
          outcome = { output: chosen[0], message: `Selected ${chosen.join(', ')}` };
          break;
        }
        case 'check':
          await needs();
          await resolved!.locator.check({ timeout });
          break;
        case 'uncheck':
          await needs();
          await resolved!.locator.uncheck({ timeout });
          break;
        case 'upload': {
          await needs();
          const files = Array.isArray(p.files) ? p.files.map(String) : [String(p.file ?? '')];
          await resolved!.locator.setInputFiles(files, { timeout });
          break;
        }
        case 'dragDrop': {
          await needs();
          const targetLocators = Array.isArray(p.target) ? (p.target as RunnableStep['locators']) : [];
          const target = await this.resolve(step, ctx, targetLocators);
          await resolved!.locator.dragTo(target.locator, { timeout });
          break;
        }
        case 'scroll':
          if (step.locators.length) {
            await needs();
            await resolved!.locator.scrollIntoViewIfNeeded({ timeout });
          } else await this.page.mouse.wheel(Number(p.x ?? 0), Number(p.y ?? 600));
          break;
        case 'switchTab': {
          const pages = this.context.pages();
          let target: Page | undefined;
          const deadline = Date.now() + timeout;
          while (!target && Date.now() < deadline) {
            const list = this.context.pages();
            target =
              p.index !== undefined
                ? list[Number(p.index)]
                : (list.find((pg) => (p.urlContains ? pg.url().includes(String(p.urlContains)) : false)) ??
                  (p.urlContains ? undefined : list[list.length - 1]));
            if (!target) await new Promise((r) => setTimeout(r, 200));
          }
          if (!target) throw new StepError('element_not_found', `No tab matched (${pages.length} open)`);
          await target.bringToFront();
          await target.waitForLoadState('domcontentloaded', { timeout }).catch(() => {});
          this.page = target;
          this.scope = target;
          this.ctx.shared.set('ui.page', target);
          outcome = { message: `Switched to ${target.url()}` };
          break;
        }
        case 'closeTab': {
          await this.page.close();
          const remaining = this.context.pages();
          if (!remaining.length) throw new StepError('invalid_params', 'Closed the last tab');
          this.page = remaining[remaining.length - 1]!;
          this.scope = this.page;
          this.ctx.shared.set('ui.page', this.page);
          break;
        }
        case 'handleDialog':
          this.pendingDialog = {
            action: p.action === 'dismiss' ? 'dismiss' : 'accept',
            promptText: p.promptText ? String(p.promptText) : undefined,
          };
          outcome = { message: `Next dialog will be ${this.pendingDialog.action}ed` };
          break;
        case 'switchFrame':
          if (p.main || !p.selector) {
            this.scope = this.page;
            outcome = { message: 'Switched to main document' };
          } else {
            this.scope = this.page.frameLocator(String(p.selector));
            outcome = { message: `Switched to frame ${String(p.selector)}` };
          }
          break;
        case 'waitFor':
          if (step.locators.length) {
            const state =
              (p.state as 'visible' | 'hidden' | 'attached' | 'detached' | undefined) ?? 'visible';
            if (state === 'hidden' || state === 'detached') {
              await buildLocator(this.scope, step.locators[0]!).first().waitFor({ state, timeout });
            } else {
              await needs();
              await resolved!.locator.waitFor({ state, timeout });
            }
          } else if (p.url) {
            await this.page.waitForURL(
              String(p.url).startsWith('/') && !String(p.url).includes('*')
                ? `**${String(p.url)}`
                : String(p.url),
              { timeout },
            );
          } else {
            await this.page.waitForLoadState((p.loadState as 'load') ?? 'load', { timeout });
          }
          break;
        case 'screenshot': {
          const path = join(this.ctx.artifactsDir, `shot-${pad(step.position)}.png`);
          if (step.locators.length) {
            await needs();
            await resolved!.locator.screenshot({ path, timeout });
          } else await this.page.screenshot({ path, fullPage: !!p.fullPage });
          outcome = {
            screenshotPath: path,
            artifacts: [{ kind: 'screenshot', path, stepId: step.id }],
            message: 'Screenshot saved',
          };
          break;
        }
        case 'extract': {
          const value = await this.extract(step, ctx, p, (r) => (resolved = r));
          outcome = {
            output: value,
            message: `Extracted ${JSON.stringify(value)}`,
            getTarget: (t) => (t === 'value' || t === 'output' ? value : this.pageTarget(t)),
          };
          break;
        }
        case 'assert':
          outcome = await this.assert(step, ctx, p, (r) => (resolved = r));
          break;
        case 'visualCheckpoint':
          outcome = await this.visualCheckpoint(step, ctx, p, needs, () => resolved);
          break;
        case 'download': {
          await needs();
          const [download] = await Promise.all([
            this.page.waitForEvent('download', { timeout }),
            resolved!.locator.click({ timeout }),
          ]);
          const fileName = download.suggestedFilename();
          const path = join(
            this.ctx.artifactsDir,
            `download-${pad(step.position)}-${fileName.replace(/[^\w.-]+/g, '_')}`,
          );
          await download.saveAs(path);
          const failure = await download.failure();
          if (failure) throw new StepError('network', `The download failed: ${failure}`);
          const size = statSync(path).size;
          const info = { fileName, size, path };
          let text: string | undefined;
          const content = () => (text ??= size <= 5_000_000 ? readFileSync(path, 'utf8') : '');
          outcome = {
            output: info,
            message: `Downloaded ${fileName} (${size} bytes)`,
            getTarget: (t) =>
              t === 'fileName'
                ? fileName
                : t === 'size'
                  ? size
                  : t === 'content'
                    ? content()
                    : this.pageTarget(t),
          };
          break;
        }
        case 'waitForResponse':
          outcome = await this.waitForResponse(p, timeout, ctx);
          break;
        case 'mockRoute':
          outcome = await this.mockRoute(p);
          break;
        case 'setOffline': {
          // `state` (offline/online) wins; older steps have only `offline`, where missing means offline.
          const offline =
            p.state !== undefined && p.state !== ''
              ? String(p.state) !== 'online'
              : p.offline === undefined
                ? true
                : !!p.offline && p.offline !== 'false';
          await this.context.setOffline(offline);
          outcome = { message: offline ? 'The browser is offline' : 'The browser is back online' };
          break;
        }
        case 'storage':
          outcome = await this.storage(p);
          break;
        case 'networkSummary': {
          // Requests still finishing are counted once their size is known.
          await this.page
            .waitForLoadState('networkidle', { timeout: Math.min(timeout, 5000) })
            .catch(() => {});
          // Since the test started, or since the last ui.navigate (one page's traffic).
          const since = p.since === 'lastNavigation' ? this.lastNavigation : -1;
          const entries = this.network.filter((e) => since < 0 || (e.step ?? -1) >= since);
          const s = summarizeNetwork(entries, this.ctx.options.baseUrl);
          let dropped = 0;
          for (const [at, n] of this.droppedRequests) if (since < 0 || at >= since) dropped += n;
          const truncated = dropped > 0;
          const kinds = s.byType.map((g) => `${g.requests} ${g.key}`).join(', ');
          const summary = `${s.requests} request${s.requests === 1 ? '' : 's'}, ${formatBytes(s.bytes)}${s.failed ? `, ${s.failed} failed` : ''}${s.thirdPartyHosts ? `, ${s.thirdPartyHosts} third-party host(s)` : ''}${kinds ? ` — ${kinds}` : ''}`;
          const incomplete = `Incomplete: ${dropped} more request${dropped === 1 ? ' was' : 's were'} not recorded (over ${this.maxNetworkEntries} in this test), so totals and budgets cannot be trusted`;
          outcome = {
            output: {
              requests: s.requests,
              bytes: s.bytes,
              failed: s.failed,
              thirdPartyHosts: s.thirdPartyHosts,
              ...(truncated && { truncated, droppedRequests: dropped }),
            },
            message: truncated ? `${incomplete}. ${summary}` : summary,
            response: { body: truncated ? { ...s, truncated, droppedRequests: dropped } : s },
            // A budget checked against part of the traffic would pass falsely.
            ...(truncated && {
              assertions: [
                {
                  target: 'truncated',
                  operator: 'equals',
                  expected: false,
                  actual: true,
                  passed: false,
                  message: incomplete,
                },
              ],
            }),
            getTarget: (t) => {
              const flat: Record<string, unknown> = {
                truncated,
                droppedRequests: dropped,
                requests: s.requests,
                bytes: s.bytes,
                kb: Math.round(s.bytes / 100) / 10,
                failed: s.failed,
                thirdPartyRequests: s.thirdPartyRequests,
                thirdPartyHosts: s.thirdPartyHosts,
                hosts: s.byHost.map((h) => h.key),
                thirdPartyHostNames: s.byHost.filter((h) => h.thirdParty).map((h) => h.key),
              };
              if (t in flat) return flat[t];
              // requests:script, bytes:image …
              const m = /^(requests|bytes):(.+)$/.exec(t);
              if (m) {
                const g = s.byType.find((x) => x.key === m[2]);
                return g ? (m[1] === 'requests' ? g.requests : g.bytes) : 0;
              }
              return this.pageTarget(t);
            },
          };
          break;
        }
        case 'setClock': {
          const action = String(p.action ?? 'set');
          const time =
            p.time !== undefined && p.time !== ''
              ? new Date(isNaN(Number(p.time)) ? String(p.time) : Number(p.time))
              : undefined;
          if (time && isNaN(time.getTime()))
            throw new StepError('invalid_params', `Not a date: ${String(p.time)}`);
          if (action === 'fastForward') {
            await this.page.clock.fastForward(Number(p.ms ?? 60_000));
            outcome = { message: `Moved the clock forward ${Number(p.ms ?? 60_000)} ms` };
          } else if (action === 'install') {
            await this.page.clock.install(time ? { time } : {});
            outcome = { message: `The page clock starts at ${(time ?? new Date()).toISOString()} and runs` };
          } else {
            if (!time) throw new StepError('invalid_params', 'setClock needs a "time"');
            await this.page.clock.setFixedTime(time);
            outcome = { message: `The page clock is fixed at ${time.toISOString()}` };
          }
          break;
        }
        default:
          throw new StepError('unsupported', `Unknown UI step "${step.type}"`);
      }
    } catch (err) {
      mapError(err);
    }

    const r = resolved as Resolved | undefined;
    if (r) {
      outcome.getTarget ??= (t) => this.elementTarget(r.locator, t);
      if (r.index > 0) {
        outcome.healedLocator = { from: step.locators[0]!, to: r.used };
        ctx.log(
          'warn',
          `Step ${step.position + 1}: primary locator failed, healed with ${r.used.strategy}=${r.used.value}`,
        );
      }
      if (r.matches > 1)
        ctx.log('warn', `Step ${step.position + 1}: locator matched ${r.matches} elements, used the first`);
    }
    outcome.getTarget ??= (t) => this.pageTarget(t);
    if (this.ctx.options.screenshots === 'everyStep' && !outcome.screenshotPath) {
      outcome.screenshotPath = await this.snap(step.position, 'jpeg');
    }
    return outcome;
  }

  /** A screenshot compared with the approved baseline; the first run saves the baseline. */
  private async visualCheckpoint(
    step: RunnableStep,
    ctx: StepContext,
    p: Record<string, unknown>,
    needs: () => Promise<unknown>,
    resolved: () => Resolved | undefined,
  ): Promise<StepOutcome> {
    const o = this.ctx.options;
    const maxDiffPercent =
      p.maxDiffPercent !== undefined && p.maxDiffPercent !== '' ? Number(p.maxDiffPercent) : 0.1;
    const threshold = p.threshold !== undefined && p.threshold !== '' ? Number(p.threshold) : 0.1;
    // NaN would make every comparison pass.
    if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1)
      throw new StepError(
        'invalid_params',
        `"threshold" must be a number from 0 to 1 (the colour tolerance per pixel), not "${String(p.threshold)}"`,
      );
    if (!Number.isFinite(maxDiffPercent) || maxDiffPercent < 0)
      throw new StepError(
        'invalid_params',
        `"maxDiffPercent" must be a number of 0 or more (percent of pixels allowed to differ), not "${String(p.maxDiffPercent)}"`,
      );
    const actual = join(this.ctx.artifactsDir, `visual-${pad(step.position)}.png`);
    const masks = (Array.isArray(p.mask) ? p.mask : String(p.mask ?? '').split(','))
      .map((m) => String(m).trim())
      .filter(Boolean)
      .map((css) => this.page.locator(css));
    // Animations stopped, caret hidden and changing parts masked, so the same page gives the same pixels.
    const shot = {
      path: actual,
      animations: 'disabled' as const,
      caret: 'hide' as const,
      mask: masks,
      timeout: ctx.timeoutMs,
    };
    if (step.locators.length) {
      await needs();
      await resolved()!.locator.screenshot(shot);
    } else await this.page.screenshot({ ...shot, fullPage: !!p.fullPage });
    const key = baselineKey({
      name: p.name ? String(p.name) : undefined,
      stepId: step.id,
      browser: o.browser,
      width: o.viewport.width,
      height: o.viewport.height,
    });
    const v = compareWithBaseline({
      actual,
      baseline: join(this.options.baselineDir ?? join(this.ctx.artifactsDir, 'baselines'), key),
      diff: join(this.ctx.artifactsDir, `visual-${pad(step.position)}-diff.png`),
      key,
      threshold,
      maxDiffPercent,
    });
    const message = {
      new: 'No baseline yet: this screenshot is now the baseline',
      match: `Matches the baseline (${v.diffPercent}% of pixels differ, ${maxDiffPercent}% allowed)`,
      changed: `${v.diffPercent}% of pixels differ from the baseline (${maxDiffPercent}% allowed)`,
      sizeChanged: `The size changed: ${v.size?.width}×${v.size?.height}, the baseline is ${v.size?.baselineWidth}×${v.size?.baselineHeight}`,
    }[v.status];
    return {
      message,
      output: v.diffPercent ?? 0,
      visual: v,
      screenshotPath: v.diff ?? actual,
      assertions: [
        {
          target: 'visual',
          operator: 'matchesBaseline',
          expected: `≤ ${maxDiffPercent}%`,
          actual: v.diffPercent,
          passed: v.status === 'new' || v.status === 'match',
          message,
        },
      ],
    };
  }

  /** The first response (since the test started) to a matching URL that no earlier step took, or the next one. */
  private async waitForResponse(
    p: Record<string, unknown>,
    timeout: number,
    ctx: StepContext,
  ): Promise<StepOutcome> {
    const pattern = String(p.url ?? '');
    if (!pattern)
      throw new StepError('invalid_params', 'waitForResponse needs a "url" (part of it, or a glob)');
    const match = urlMatcher(pattern);
    const method = p.method ? String(p.method).toUpperCase() : undefined;
    const status = p.status !== undefined && p.status !== '' ? Number(p.status) : undefined;
    const fits = (r: Response) =>
      match(r.url()) &&
      (!method || r.request().method() === method) &&
      (status === undefined || r.status() === status);
    const deadline = Date.now() + timeout;
    let found: SeenResponse | undefined;
    while (!(found = this.responses.find((x) => !x.consumed && fits(x.response)))) {
      if (ctx.signal.aborted) throw new StepError('aborted', 'Run was cancelled');
      if (Date.now() >= deadline)
        throw new StepError(
          'timeout',
          `No response from ${pattern}${method ? ` (${method})` : ''}${status !== undefined ? ` with status ${status}` : ''} within ${timeout} ms`,
        );
      await new Promise((r) => setTimeout(r, 100));
    }
    found.consumed = true;
    const r = found.response;
    const text = await r.text().catch(() => '');
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      // not JSON: keep the text
    }
    const t = r.request().timing();
    const headers = await r.allHeaders().catch(() => ({}) as Record<string, string>);
    return {
      output: body,
      message: `${r.request().method()} ${r.url()} → ${r.status()}`,
      request: { method: r.request().method(), url: r.url(), headers: {} },
      response: {
        status: r.status(),
        body,
        timeMs: t.responseEnd > 0 ? Math.round(t.responseEnd) : undefined,
      },
      getTarget: (target) => {
        if (target === 'status') return r.status();
        if (target === 'body') return body;
        if (target === 'url') return r.url();
        if (target.startsWith('header:')) return headers[target.slice(7).toLowerCase()];
        if (target.startsWith('$'))
          return JSONPath({ path: target, json: (body ?? null) as object, wrap: false }) as unknown;
        return this.pageTarget(target);
      },
    };
  }

  /** Answers matching requests with a fixed response, an error or a delay — for the rest of the test. */
  private async mockRoute(p: Record<string, unknown>): Promise<StepOutcome> {
    const pattern = String(p.url ?? '');
    if (!pattern) throw new StepError('invalid_params', 'mockRoute needs a "url" (part of it, or a glob)');
    const action = String(p.action ?? 'fulfill');
    const method = p.method ? String(p.method).toUpperCase() : undefined;
    // GET and POST mocks for the same URL live side by side; "remove" without a method removes them all.
    const key = `${method ?? '*'} ${pattern}`;
    const drop = async (k: string) => {
      const old = this.mocks.get(k);
      if (!old) return;
      this.mocks.delete(k);
      await this.context.unroute(old.matcher, old.handler).catch(() => {});
    };
    if (action === 'remove') {
      const keys = method ? [key] : [...this.mocks].filter(([, m]) => m.pattern === pattern).map(([k]) => k);
      for (const k of keys) await drop(k);
      return { message: `Requests to ${pattern}${method ? ` (${method})` : ''} reach the server again` };
    }
    await drop(key);
    const match = urlMatcher(pattern);
    const matcher = (u: URL) => match(u.toString());
    const status = Number(p.status ?? 200);
    const body =
      p.body === undefined || p.body === null
        ? ''
        : typeof p.body === 'string'
          ? p.body
          : JSON.stringify(p.body);
    const contentType = p.contentType
      ? String(p.contentType)
      : /^\s*[[{]/.test(body)
        ? 'application/json'
        : 'text/plain';
    const delayMs = Number(p.delayMs ?? 0);
    // Empty or 0: every matching request, as before.
    const times =
      p.times !== undefined && p.times !== '' && Number(p.times) !== 0 ? Number(p.times) : undefined;
    if (times !== undefined && !(Number.isInteger(times) && times > 0))
      throw new StepError('invalid_params', `"times" must be a whole number, not "${String(p.times)}"`);
    // Counted here, not by Playwright: requests of another method fall back and must not use up the count.
    let used = 0;
    const handler = async (route: Route) => {
      if (method && route.request().method() !== method) return route.fallback();
      if (times !== undefined) {
        if (used >= times) return route.fallback();
        if (++used >= times && this.mocks.get(key)?.handler === handler) void drop(key);
      }
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      if (action === 'abort') return route.abort('failed');
      if (action === 'delay') return route.fallback();
      return route.fulfill({ status, body, contentType });
    };
    await this.context.route(matcher, handler);
    this.mocks.set(key, { pattern, matcher, handler });
    const what =
      action === 'abort'
        ? 'fail (network error)'
        : action === 'delay'
          ? `are delayed ${delayMs} ms`
          : `are answered with ${status}`;
    return {
      message: `Requests to ${pattern}${method ? ` (${method})` : ''} ${what}${times ? `, ${times} time(s)` : ''}`,
    };
  }

  /** Cookies, localStorage and sessionStorage: set, get, remove one, or clear. */
  private async storage(p: Record<string, unknown>): Promise<StepOutcome> {
    const kind = String(p.kind ?? 'cookie');
    const action = String(p.action ?? 'get');
    const name = p.name === undefined ? '' : String(p.name);
    const value =
      p.value === undefined || p.value === null
        ? ''
        : typeof p.value === 'string'
          ? p.value
          : JSON.stringify(p.value);
    if (!name && action !== 'clear')
      throw new StepError('invalid_params', `storage ${action} needs a "name"`);
    if (kind === 'cookie') {
      if (action === 'set') {
        const url = /^https?:/.test(this.page.url()) ? this.page.url() : this.ctx.options.baseUrl;
        if (!url) throw new StepError('invalid_params', 'Open a page before setting a cookie');
        await this.context.addCookies([{ name, value, url }]);
        return { message: `Cookie ${name} set` };
      }
      if (action === 'clear') {
        await this.context.clearCookies();
        return { message: 'All cookies cleared' };
      }
      if (action === 'remove') {
        await this.context.clearCookies({ name });
        return { message: `Cookie ${name} removed` };
      }
      const c = (await this.context.cookies()).find((x) => x.name === name);
      return {
        output: c?.value ?? null,
        message: c ? `Cookie ${name} is set` : `No cookie named ${name}`,
        getTarget: (t) => (t === 'value' ? (c?.value ?? null) : t === 'exists' ? !!c : this.pageTarget(t)),
      };
    }
    type Store = {
      setItem(k: string, v: string): void;
      getItem(k: string): string | null;
      removeItem(k: string): void;
      clear(): void;
    };
    const area = kind === 'session' || kind === 'sessionStorage' ? 'sessionStorage' : 'localStorage';
    // about:blank has no origin: the browser would throw a SecurityError nobody understands.
    if (!/^https?:/.test(this.page.url()))
      throw new StepError('invalid_params', `Open a page before using ${area}`);
    const got = await this.page.evaluate(
      ([a, act, k, v]) => {
        const store = (globalThis as unknown as Record<string, Store>)[a]!;
        if (act === 'set') store.setItem(k, v);
        else if (act === 'remove') store.removeItem(k);
        else if (act === 'clear') store.clear();
        else return store.getItem(k);
        return null;
      },
      [area, action, name, value] as const,
    );
    if (action !== 'get')
      return {
        message:
          action === 'clear' ? `${area} cleared` : `${area} ${name} ${action === 'set' ? 'set' : 'removed'}`,
      };
    return {
      output: got,
      message: got === null ? `${area} has no ${name}` : `${area} ${name} read`,
      getTarget: (t) => (t === 'value' ? got : t === 'exists' ? got !== null : this.pageTarget(t)),
    };
  }

  private async pageTarget(t: string): Promise<unknown> {
    if (t === 'url') return this.page.url();
    if (t === 'title') return this.page.title();
    return undefined;
  }

  private async elementTarget(l: Locator, t: string): Promise<unknown> {
    switch (t) {
      case 'text':
        return (await l.innerText({ timeout: 2000 })).trim();
      case 'value':
        return l.inputValue({ timeout: 2000 });
      case 'visible':
        return l.isVisible();
      case 'enabled':
        return l.isEnabled({ timeout: 2000 });
      case 'checked':
        return l.isChecked({ timeout: 2000 });
      case 'count':
        return l.count();
      default:
        if (t.startsWith('attr:')) return l.getAttribute(t.slice(5), { timeout: 2000 });
        return this.pageTarget(t);
    }
  }

  private async extract(
    step: RunnableStep,
    ctx: StepContext,
    p: Record<string, unknown>,
    onResolved: (r: Resolved) => void,
  ): Promise<unknown> {
    const from = String(p.from ?? 'text');
    let value: unknown;
    if (from === 'url') value = this.page.url();
    else if (from === 'title') value = await this.page.title();
    else {
      const r = await this.resolve(step, ctx);
      onResolved(r);
      if (from === 'count') value = r.matches;
      else if (from === 'value') value = await r.locator.inputValue({ timeout: ctx.timeoutMs });
      else if (from === 'attribute')
        value = await r.locator.getAttribute(String(p.attribute ?? ''), { timeout: ctx.timeoutMs });
      else value = (await r.locator.innerText({ timeout: ctx.timeoutMs })).trim();
    }
    if (p.regex && typeof value === 'string') {
      const m = new RegExp(String(p.regex)).exec(value);
      if (!m)
        throw new StepError(
          'assertion',
          `Extracted text ${JSON.stringify(value)} does not match /${String(p.regex)}/`,
        );
      value = m[1] ?? m[0];
    }
    return value;
  }

  /** `ui.assert`: polls until the check passes or the step timeout expires. */
  private async assert(
    step: RunnableStep,
    ctx: StepContext,
    p: Record<string, unknown>,
    onResolved: (r: Resolved) => void,
  ): Promise<StepOutcome> {
    const check = String(p.check ?? 'visible');
    const expected = p.expected;
    const pageLevel = ['url', 'urlContains', 'urlMatches', 'title', 'titleContains'].includes(check);
    const deadline = Date.now() + ctx.timeoutMs;
    let actual: unknown;
    let pass = false;
    for (;;) {
      try {
        if (pageLevel) {
          actual = check.startsWith('url') ? this.page.url() : await this.page.title();
        } else if (check === 'hidden') {
          const l = buildLocator(this.scope, step.locators[0] ?? { strategy: 'css', value: 'body' });
          actual = (await l.count()) === 0 || !(await l.first().isVisible());
        } else if (check === 'count') {
          actual = await buildLocator(this.scope, step.locators[0]!).count();
        } else {
          const r = await this.resolve(step, { ...ctx, timeoutMs: Math.max(0, deadline - Date.now()) });
          onResolved(r);
          actual = await this.readForCheck(r.locator, check, p);
        }
        pass = this.compare(check, actual, expected);
      } catch (err) {
        if ((err as StepError).kind === 'element_not_found' && check !== 'visible') throw err;
        actual = (err as StepError).kind === 'element_not_found' ? 'not found' : firstLine(err);
        pass = false;
      }
      if (pass || Date.now() >= deadline) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    const describe = `${check}${expected !== undefined ? ` ${JSON.stringify(expected)}` : ''}`;
    if (!pass)
      throw new StepError('assertion', `Expected ${describe}, but got ${JSON.stringify(actual)}`, {
        expected,
        actual,
        check,
      });
    return {
      message: `Assert ${describe}`,
      output: actual,
      getTarget: (t) => (t === 'actual' ? actual : this.pageTarget(t)),
    };
  }

  private async readForCheck(l: Locator, check: string, p: Record<string, unknown>): Promise<unknown> {
    switch (check) {
      case 'visible':
        return l.isVisible();
      case 'text':
      case 'textContains':
      case 'textMatches':
        return (await l.innerText({ timeout: 1000 })).trim();
      case 'value':
        return l.inputValue({ timeout: 1000 });
      case 'attribute':
        return l.getAttribute(String(p.attribute ?? ''), { timeout: 1000 });
      case 'enabled':
      case 'disabled':
        return l.isEnabled({ timeout: 1000 });
      case 'checked':
      case 'unchecked':
        return l.isChecked({ timeout: 1000 });
      default:
        throw new StepError('invalid_params', `Unknown assert check "${check}"`);
    }
  }

  private compare(check: string, actual: unknown, expected: unknown): boolean {
    const a = String(actual ?? '');
    const e = String(expected ?? '');
    switch (check) {
      case 'visible':
      case 'hidden':
      case 'enabled':
      case 'checked':
        return actual === true;
      case 'disabled':
      case 'unchecked':
        return actual === false;
      case 'text':
      case 'value':
      case 'attribute':
      case 'url':
      case 'title':
        return a === e;
      case 'textContains':
      case 'urlContains':
      case 'titleContains':
        return a.includes(e);
      case 'textMatches':
      case 'urlMatches':
        return new RegExp(e).test(a);
      case 'count':
        return Number(actual) === Number(expected);
      default:
        return false;
    }
  }

  private async snap(position: number, type: 'jpeg' | 'png', suffix = ''): Promise<string | undefined> {
    const path = join(
      this.ctx.artifactsDir,
      `step-${pad(position)}${suffix}.${type === 'jpeg' ? 'jpg' : 'png'}`,
    );
    // A busy machine (e.g. a CI runner) can miss the first try while the page is still settling: try once more.
    for (const timeout of [5000, 10_000]) {
      try {
        await this.page.screenshot({ path, type, ...(type === 'jpeg' && { quality: 60 }), timeout });
        return path;
      } catch {
        if (this.page.isClosed()) return undefined;
      }
    }
    return undefined;
  }

  async onStepFailed(step: RunnableStep): Promise<Partial<StepOutcome>> {
    const out: Partial<StepOutcome> = {};
    // For the diagnosis: does the element exist (hidden?) or what looks like it now (locator changed?).
    let unhighlight: (() => Promise<void>) | undefined;
    if (step.locators.length) {
      try {
        const { diagnostics, target } = await inspectFailure(
          this.scope,
          step.type.split('.')[1]!,
          step.locators,
        );
        out.diagnostics = diagnostics;
        if (target) unhighlight = await highlight(target).catch(() => undefined);
      } catch {
        // the page may be gone; the failure itself is what matters
      }
    }
    // The page the step failed on: the diagnosis only blames a JavaScript error thrown on this page.
    try {
      out.diagnostics = {
        ...(out.diagnostics ?? { matchCount: 0, candidates: [] }),
        pageUrl: this.page.url(),
      } as typeof out.diagnostics;
    } catch {
      // no page
    }
    if (this.ctx.options.screenshots !== 'off')
      out.screenshotPath = await this.snap(step.position, 'png', '-failed');
    await unhighlight?.();
    try {
      const path = join(this.ctx.artifactsDir, `dom-step-${pad(step.position)}.html`);
      writeFileSync(path, await this.page.content());
      this.failureArtifacts.push({ kind: 'dom', path, stepId: step.id });
    } catch {
      // page may be closed or navigating
    }
    return out;
  }

  async close({ failed }: { failed: boolean }): Promise<ArtifactRef[]> {
    const o = this.ctx.options;
    const keep = (mode: string) => mode === 'always' || (mode === 'onFailure' && failed);
    const artifacts: ArtifactRef[] = [];
    if (o.trace !== 'off') {
      const path = join(this.ctx.artifactsDir, 'trace.zip');
      if (keep(o.trace)) {
        await this.context.tracing.stop({ path });
        artifacts.push({ kind: 'trace', path });
      } else await this.context.tracing.stop();
    }
    if (o.captureLogs) {
      const consolePath = join(this.ctx.artifactsDir, 'console.json');
      const networkPath = join(this.ctx.artifactsDir, 'network.json');
      writeFileSync(consolePath, JSON.stringify(this.consoleLog, null, 2));
      writeFileSync(networkPath, JSON.stringify(this.network, null, 2));
      artifacts.push({ kind: 'console', path: consolePath }, { kind: 'network', path: networkPath });
    }
    const videos = this.context
      .pages()
      .map((pg) => pg.video())
      .filter((v) => !!v);
    const firstVideo = this.pages[0]?.video() ?? videos[0];
    if (this.electronApp) await this.electronApp.close().catch(() => {});
    else await this.context.close();
    if (o.video !== 'off' && firstVideo) {
      const src = await firstVideo.path().catch(() => null);
      if (src && keep(o.video)) {
        const dest = join(this.ctx.artifactsDir, 'video.webm');
        renameSync(src, dest);
        artifacts.push({ kind: 'video', path: dest });
      }
      rmSync(this.videoDir, { recursive: true, force: true });
    }
    if (failed) artifacts.push(...this.failureArtifacts);
    else for (const a of this.failureArtifacts) rmSync(a.path, { force: true });
    return artifacts;
  }
}
