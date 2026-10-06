import {
  StepError,
  type ArtifactRef,
  type ExecutorSession,
  type RunnableStep,
  type StepContext,
  type StepOutcome,
  type TestContext,
} from '@stepforge/core';
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Browser, BrowserContext, Dialog, Locator, Page } from 'playwright';
import { buildLocator, resolveLocator, type Resolved, type Scope } from './locators.ts';
import { checkPageMetrics, collectPageMetrics, WEB_VITALS_INIT_SCRIPT } from '@stepforge/perf';

type NetworkEntry = {
  method: string;
  url: string;
  status?: number;
  resourceType: string;
  durationMs?: number;
  failure?: string;
  startedAt: number;
};
type ConsoleEntry = { type: string; text: string; location?: string; at: number };

const MAX_LOG_ENTRIES = 1000;
const pad = (n: number) => String(n + 1).padStart(2, '0');
/** Playwright errors are multi-line; the first line is the useful part. */
const firstLine = (e: unknown) =>
  String((e as Error)?.message ?? e)
    .split('\n')[0]!
    .replace(/^(locator|page)\.\w+: /, '');

function mapError(err: unknown): never {
  if ((err as { name?: string })?.name === 'StepError') throw err;
  const name = (err as Error)?.name;
  const msg = firstLine(err);
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
  private consoleLog: ConsoleEntry[] = [];
  private pendingDialog: { action: 'accept' | 'dismiss'; promptText?: string } | null = null;
  private failureArtifacts: ArtifactRef[] = [];
  private videoDir: string;

  constructor(
    private readonly browser: Browser,
    private readonly ctx: TestContext,
  ) {
    this.videoDir = join(ctx.artifactsDir, '.video');
  }

  async open(): Promise<void> {
    const o = this.ctx.options;
    mkdirSync(this.ctx.artifactsDir, { recursive: true });
    this.context = await this.browser.newContext({
      viewport: o.viewport,
      baseURL: o.baseUrl,
      ignoreHTTPSErrors: true,
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
      if (this.network.length >= MAX_LOG_ENTRIES) return;
      const res = await r.response().catch(() => null);
      const t = r.timing();
      this.network.push({
        method: r.method(),
        url: r.url(),
        status: res?.status(),
        resourceType: r.resourceType(),
        durationMs: t.responseEnd > 0 ? Math.round(t.responseEnd) : undefined,
        startedAt: Math.round(t.startTime),
      });
    });
    p.on('requestfailed', (r) => {
      if (this.network.length < MAX_LOG_ENTRIES) {
        this.network.push({
          method: r.method(),
          url: r.url(),
          resourceType: r.resourceType(),
          failure: r.failure()?.errorText,
          startedAt: Date.now(),
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

  private resolve(step: RunnableStep, ctx: StepContext, locators = step.locators): Promise<Resolved> {
    return resolveLocator(this.scope, locators, ctx.timeoutMs, ctx.signal);
  }

  async execute(step: RunnableStep, ctx: StepContext): Promise<StepOutcome> {
    if (!this.pages.includes(this.page)) this.track(this.page);
    const p = step.params as Record<string, unknown>;
    const name = step.type.split('.')[1]!;
    const timeout = ctx.timeoutMs;
    let resolved: Resolved | undefined;
    const needs = () => this.resolve(step, ctx).then((r) => (resolved = r));
    let outcome: StepOutcome = {};

    try {
      switch (name) {
        case 'navigate': {
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
        case 'hover': {
          await needs();
          const opts = { timeout, force: !!p.force, trial: false };
          if (name === 'click')
            await resolved!.locator.click({ ...opts, button: (p.button as 'left') ?? 'left' });
          else if (name === 'dblclick') await resolved!.locator.dblclick(opts);
          else await resolved!.locator.hover(opts);
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
          throw new StepError('unsupported', 'Visual checkpoints are not available yet');
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
    try {
      await this.page.screenshot({ path, type, ...(type === 'jpeg' && { quality: 60 }), timeout: 5000 });
      return path;
    } catch {
      return undefined;
    }
  }

  async onStepFailed(step: RunnableStep): Promise<Partial<StepOutcome>> {
    const out: Partial<StepOutcome> = {};
    if (this.ctx.options.screenshots !== 'off')
      out.screenshotPath = await this.snap(step.position, 'png', '-failed');
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
    await this.context.close();
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
