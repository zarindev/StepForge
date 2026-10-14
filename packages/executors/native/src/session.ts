import {
  StepError,
  type ArtifactRef,
  type ExecutorSession,
  type Locator,
  type ProbeRequest,
  type RunnableStep,
  type StepContext,
  type StepOutcome,
  type TestContext,
} from '@stepforge/core';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { androidPlatform, iosPlatform, type NativePlatform } from './platforms.ts';
import { WebDriverError, WebDriverSession, type ElementRef } from './webdriver.ts';

const pad = (n: number) => String(n).padStart(3, '0');
const describe = (l: Locator) => `${l.strategy}=${l.value}${l.name ? ` "${l.name}"` : ''}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Found = { el: ElementRef; used: Locator; index: number; matches: number };

/** One test in a native app (Android or iOS), through a local Appium server. */
export class NativeSession implements ExecutorSession {
  private driver!: WebDriverSession;
  private readonly platform: NativePlatform;
  private stopRecording: (() => Promise<Buffer | null>) | null = null;
  private failureArtifacts: ArtifactRef[] = [];

  constructor(
    private readonly ctx: TestContext,
    private readonly appiumUrl: () => Promise<string>,
    private readonly hasDriver: (driver: string) => boolean = () => true,
  ) {
    const o = ctx.options;
    if (o.ios) this.platform = iosPlatform(o.ios);
    else if (o.android) this.platform = androidPlatform(o.android);
    else throw new StepError('invalid_params', 'No Android or iOS app is set for this test');
  }

  async open(): Promise<void> {
    const pf = this.platform;
    const caps = pf.capabilities();
    if (!this.hasDriver(pf.driver))
      throw new StepError(
        'navigation',
        `Appium's ${pf.name} driver is not installed: run "npm run appium:install" (or Install Appium on the application's Environments tab)`,
      );
    const url = await this.appiumUrl().catch((err: Error) => {
      throw new StepError('navigation', err.message);
    });
    try {
      // The first test may boot the emulator or simulator and install (on iOS: build) Appium's helper app.
      this.driver = await WebDriverSession.create(url, caps, pf.name === 'iOS' ? 900_000 : 420_000);
    } catch (err) {
      if (err instanceof StepError) throw err;
      throw new StepError('navigation', `The ${pf.name} app did not start: ${(err as Error).message}`);
    }
    this.ctx.shared.set('native.driver', this.driver);
    // Older device log lines are not this test's.
    await this.driver.logs(pf.log.type).catch(() => []);
    if (this.ctx.options.video !== 'off') this.stopRecording = await pf.record(this.driver);
  }

  /** Finds the element with the ranked locators, waiting up to the timeout. A lower-ranked match is "healed". */
  private async find(locators: Locator[], timeoutMs: number, signal?: AbortSignal): Promise<Found> {
    if (!locators.length) throw new StepError('invalid_params', 'This step needs at least one locator');
    const queries = locators.map((l) => this.platform.queries(l));
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (signal?.aborted) throw new StepError('aborted', 'Run was cancelled');
      for (const [index, qs] of queries.entries()) {
        for (const q of qs) {
          const els = await this.driver.findAll(q.using, q.value).catch((err) => {
            if (err instanceof WebDriverError && err.error === 'invalid selector')
              throw new StepError(
                'invalid_params',
                `Invalid locator ${describe(locators[index]!)}: ${err.message}`,
              );
            return [] as ElementRef[];
          });
          if (els.length) return { el: els[0]!, used: locators[index]!, index, matches: els.length };
        }
      }
      if (Date.now() >= deadline)
        throw new StepError(
          'element_not_found',
          `No element found within ${timeoutMs} ms. Tried: ${locators.map(describe).join(' | ')}`,
          { tried: locators },
        );
      await sleep(250);
    }
  }

  /** How many elements the first locator matches now (no waiting). */
  private async count(l: Locator): Promise<number> {
    for (const q of this.platform.queries(l)) {
      const n = (await this.driver.findAll(q.using, q.value).catch(() => [])).length;
      if (n) return n;
    }
    return 0;
  }

  private async read(el: ElementRef, what: string, attribute?: string): Promise<unknown> {
    switch (what) {
      case 'visible':
        return this.driver.displayed(el);
      case 'enabled':
      case 'disabled':
        return this.driver.enabled(el);
      case 'checked':
      case 'unchecked':
        return this.platform.isChecked(this.driver, el);
      case 'attribute':
        return this.driver.attribute(el, attribute ?? '');
      case 'value':
      case 'text':
      case 'textContains':
      case 'textMatches':
        return (await this.driver.text(el)).trim();
      default:
        throw new StepError('invalid_params', `Unknown assert check "${what}"`);
    }
  }

  async probe(req: ProbeRequest, ctx: StepContext): Promise<{ ok: boolean; detail: string }> {
    if (!req.locators.length) throw new StepError('invalid_params', 'A condition needs an element');
    const expected = req.expected === undefined || req.expected === null ? '' : String(req.expected);
    const check = async (): Promise<[boolean, string]> => {
      let found: Found | undefined;
      try {
        found = await this.find(req.locators, 0);
      } catch (err) {
        if ((err as StepError).kind !== 'element_not_found') throw err;
      }
      switch (req.check) {
        case 'present':
          return [!!found, found ? `${found.matches} found` : '0 found'];
        case 'absent':
          return [!found, found ? `${found.matches} found` : '0 found'];
        case 'visible': {
          const v = !!found && (await this.driver.displayed(found.el));
          return [v, v ? 'visible' : found ? 'present but not visible' : 'not found'];
        }
        case 'hidden': {
          const v = !!found && (await this.driver.displayed(found.el));
          return [!v, v ? 'visible' : 'not visible'];
        }
        case 'enabled': {
          const e = !!found && (await this.driver.enabled(found.el));
          return [e, found ? (e ? 'enabled' : 'disabled') : 'not found'];
        }
        case 'textContains': {
          const t = found ? await this.driver.text(found.el) : '';
          return [!!found && t.includes(expected), found ? `text "${t.trim().slice(0, 80)}"` : 'not found'];
        }
        case 'count': {
          const n = found?.matches ?? 0;
          return [n === Number(expected), `${n} found`];
        }
      }
    };
    const deadline = Date.now() + Math.max(0, req.timeoutMs);
    for (;;) {
      if (ctx.signal.aborted) throw new StepError('aborted', 'Run was cancelled');
      const [ok, detail] = await check().catch((): [boolean, string] => [false, 'not ready']);
      if (ok || Date.now() >= deadline) return { ok, detail };
      await sleep(250);
    }
  }

  async execute(step: RunnableStep, ctx: StepContext): Promise<StepOutcome> {
    const p = step.params as Record<string, unknown>;
    const name = step.type.split('.')[1]!;
    const timeout = ctx.timeoutMs;
    let found: Found | undefined;
    const needs = async () => (found = await this.find(step.locators, timeout, ctx.signal));
    let outcome: StepOutcome = {};
    try {
      switch (name) {
        case 'navigate': {
          const url = String(p.url ?? '');
          if (!/^[a-z][a-z0-9+.-]*:/i.test(url))
            throw new StepError(
              'unsupported',
              `An ${this.platform.name} app has no pages to open: the app starts on its first screen. Use a full deep link (myapp://…) to open a screen`,
            );
          await this.platform.deepLink(this.driver, url);
          outcome = { message: `Opened ${url}` };
          break;
        }
        case 'click':
        case 'tap':
          await needs();
          await this.driver.click(found!.el);
          break;
        case 'dblclick':
          await needs();
          await this.platform.doubleTap(this.driver, found!.el);
          break;
        case 'fill':
          await needs();
          await this.driver.clear(found!.el);
          await this.driver.sendKeys(found!.el, String(p.value ?? ''));
          break;
        case 'type':
          await needs();
          await this.driver.sendKeys(found!.el, String(p.text ?? p.value ?? ''));
          break;
        case 'clear':
          await needs();
          await this.driver.clear(found!.el);
          break;
        case 'press': {
          const key = String(p.key ?? 'Enter');
          if (step.locators.length) {
            await needs();
            await this.driver.click(found!.el);
          }
          await this.platform.pressKey(this.driver, key, found?.el);
          outcome = { message: `Pressed ${key}` };
          break;
        }
        case 'check':
        case 'uncheck': {
          await needs();
          const want = name === 'check';
          if ((await this.platform.isChecked(this.driver, found!.el)) !== want)
            await this.driver.click(found!.el);
          break;
        }
        case 'select': {
          // A spinner: open it, then choose the option by its text.
          await needs();
          await this.driver.click(found!.el);
          const label = String(p.label ?? p.value ?? '');
          const option = await this.find([{ strategy: 'text', value: label }], timeout, ctx.signal);
          await this.driver.click(option.el);
          outcome = { output: label, message: `Selected ${label}` };
          break;
        }
        case 'scroll': {
          if (step.locators.length) {
            // Scroll down until the element shows (at most ten swipes).
            for (let i = 0; i < 10; i++) {
              try {
                found = await this.find(step.locators, 500, ctx.signal);
                if (await this.driver.displayed(found.el)) break;
              } catch (err) {
                if ((err as StepError).kind !== 'element_not_found') throw err;
              }
              const more = await this.scroll('down');
              if (!more) break;
            }
            if (!found) await needs();
          } else await this.scroll(Number(p.y ?? 600) < 0 ? 'up' : 'down');
          break;
        }
        case 'waitFor': {
          const state = String(p.state ?? 'visible');
          if (!step.locators.length)
            throw new StepError('invalid_params', 'In an Android app, wait for an element (set a locator)');
          const ok = await this.probe(
            {
              locators: step.locators,
              check: state === 'hidden' || state === 'detached' ? 'hidden' : 'visible',
              timeoutMs: timeout,
            },
            ctx,
          );
          if (!ok.ok)
            throw new StepError(
              'timeout',
              `Waited ${timeout} ms for the element to be ${state}: ${ok.detail}`,
            );
          break;
        }
        case 'screenshot': {
          const path = join(this.ctx.artifactsDir, `shot-${pad(step.position)}.png`);
          if (step.locators.length) await needs();
          writeFileSync(path, await this.driver.screenshot(found?.el));
          outcome = {
            screenshotPath: path,
            artifacts: [{ kind: 'screenshot', path, stepId: step.id }],
            message: 'Screenshot saved',
          };
          break;
        }
        case 'extract': {
          const from = String(p.from ?? 'text');
          let value: unknown;
          await needs();
          if (from === 'count') value = found!.matches;
          else if (from === 'attribute')
            value = await this.driver.attribute(found!.el, String(p.attribute ?? ''));
          else value = (await this.driver.text(found!.el)).trim();
          if (p.regex && typeof value === 'string') {
            const m = new RegExp(String(p.regex)).exec(value);
            if (!m)
              throw new StepError(
                'assertion',
                `Extracted text ${JSON.stringify(value)} does not match /${String(p.regex)}/`,
              );
            value = m[1] ?? m[0];
          }
          outcome = {
            output: value,
            message: `Extracted ${JSON.stringify(value)}`,
            getTarget: (t) => (t === 'value' || t === 'output' ? value : undefined),
          };
          break;
        }
        case 'assert':
          outcome = await this.assert(step, ctx, p, (f) => (found = f));
          break;
        default:
          throw new StepError(
            'unsupported',
            `"${step.type}" is not available in ${this.platform.name} apps yet (it is a web-page step); see docs/${this.platform.name === 'iOS' ? 'IOS' : 'ANDROID'}_APPS.md`,
          );
      }
    } catch (err) {
      if (err instanceof StepError) throw err;
      if (err instanceof WebDriverError) {
        if (err.error === 'stale element reference' || err.error === 'no such element')
          throw new StepError('element_not_found', `The element went away: ${err.message}`);
        throw new StepError('unknown', `Appium: ${err.message}`);
      }
      throw err;
    }
    const f = found as Found | undefined;
    if (f) {
      outcome.getTarget ??= (t) => (t === 'count' ? f.matches : this.read(f.el, t === 'text' ? 'text' : t));
      if (f.index > 0) {
        outcome.healedLocator = { from: step.locators[0]!, to: f.used };
        ctx.log('warn', `Step ${step.position + 1}: primary locator failed, healed with ${describe(f.used)}`);
      }
      if (f.matches > 1)
        ctx.log('warn', `Step ${step.position + 1}: locator matched ${f.matches} elements, used the first`);
    }
    if (this.ctx.options.screenshots === 'everyStep' && !outcome.screenshotPath)
      outcome.screenshotPath = await this.snap(step.position);
    return outcome;
  }

  /** Swipes the screen; false when nothing moved any more. */
  private scroll(direction: 'up' | 'down'): Promise<boolean> {
    return this.platform.scroll(this.driver, direction);
  }

  private async assert(
    step: RunnableStep,
    ctx: StepContext,
    p: Record<string, unknown>,
    onFound: (f: Found) => void,
  ): Promise<StepOutcome> {
    const check = String(p.check ?? 'visible');
    const expected = p.expected;
    if (['url', 'urlContains', 'urlMatches', 'title', 'titleContains'].includes(check))
      throw new StepError(
        'unsupported',
        `The "${check}" check is for web pages; check an element of the app instead`,
      );
    const deadline = Date.now() + ctx.timeoutMs;
    let actual: unknown;
    let pass = false;
    for (;;) {
      try {
        if (check === 'hidden') {
          const n = await this.count(step.locators[0]!);
          actual =
            n === 0 ||
            !(await this.find(step.locators.slice(0, 1), 0)
              .then((f) => this.driver.displayed(f.el))
              .catch(() => false));
        } else if (check === 'count') {
          actual = await this.count(step.locators[0]!);
        } else {
          const f = await this.find(step.locators, Math.max(0, deadline - Date.now()), ctx.signal);
          onFound(f);
          actual = await this.read(f.el, check, String(p.attribute ?? ''));
        }
        pass = compare(check, actual, expected);
      } catch (err) {
        if ((err as StepError).kind === 'element_not_found' && check !== 'visible') throw err;
        actual =
          (err as StepError).kind === 'element_not_found'
            ? 'not found'
            : (err as Error).message.split('\n')[0];
        pass = false;
      }
      if (pass || Date.now() >= deadline) break;
      await sleep(250);
    }
    const what = `${check}${expected !== undefined ? ` ${JSON.stringify(expected)}` : ''}`;
    if (!pass)
      throw new StepError('assertion', `Expected ${what}, but got ${JSON.stringify(actual)}`, {
        expected,
        actual,
        check,
      });
    return {
      message: `Assert ${what}`,
      output: actual,
      getTarget: (t) => (t === 'actual' ? actual : undefined),
    };
  }

  private async snap(position: number, suffix = ''): Promise<string | undefined> {
    const path = join(this.ctx.artifactsDir, `step-${pad(position)}${suffix}.png`);
    try {
      writeFileSync(path, await this.driver.screenshot());
      return path;
    } catch {
      return undefined;
    }
  }

  async onStepFailed(step: RunnableStep): Promise<Partial<StepOutcome>> {
    const out: Partial<StepOutcome> = {};
    if (this.ctx.options.screenshots !== 'off')
      out.screenshotPath = await this.snap(step.position, '-failed');
    // The screen's element tree (XML), to see what the app showed instead.
    try {
      const path = join(this.ctx.artifactsDir, `dom-step-${pad(step.position)}.xml`);
      writeFileSync(path, await this.driver.source());
      this.failureArtifacts.push({ kind: 'dom', path, stepId: step.id });
    } catch {
      // the app may have gone
    }
    if (step.locators.length) {
      let matchCount = 0;
      for (const l of step.locators) matchCount += await this.count(l).catch(() => 0);
      out.diagnostics = { matchCount, candidates: [] } as StepOutcome['diagnostics'];
    }
    return out;
  }

  async close({ failed }: { failed: boolean }): Promise<ArtifactRef[]> {
    const o = this.ctx.options;
    const keep = (mode: string) => mode === 'always' || (mode === 'onFailure' && failed);
    const artifacts: ArtifactRef[] = [];
    if (!this.driver) return artifacts;
    if (this.stopRecording) {
      const video = await this.stopRecording();
      if (video?.length && keep(o.video)) {
        const path = join(this.ctx.artifactsDir, 'video.mp4');
        writeFileSync(path, video);
        artifacts.push({ kind: 'video', path });
      }
    }
    if (o.captureLogs) {
      // The device log (logcat, or the iOS system log) is the app's console; a crash is reported as an error.
      const { type, crash } = this.platform.log;
      const lines = await this.driver.logs(type).catch(() => []);
      const log = lines.slice(-2000).map((l) => ({
        type: crash.test(l.message) ? 'error' : type,
        text: l.message,
        at: l.timestamp,
      }));
      const path = join(this.ctx.artifactsDir, 'console.json');
      writeFileSync(path, JSON.stringify(log, null, 2));
      artifacts.push({ kind: 'console', path });
    }
    await this.driver.quit();
    if (failed) artifacts.push(...this.failureArtifacts);
    return artifacts;
  }
}

function compare(check: string, actual: unknown, expected: unknown): boolean {
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
      return a === e;
    case 'textContains':
      return a.includes(e);
    case 'textMatches':
      return new RegExp(e).test(a);
    case 'count':
      return Number(actual) === Number(expected);
    default:
      return false;
  }
}
