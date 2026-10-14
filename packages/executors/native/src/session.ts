import {
  StepError,
  type AndroidLaunch,
  type ArtifactRef,
  type ExecutorSession,
  type Locator,
  type ProbeRequest,
  type RunnableStep,
  type StepContext,
  type StepOutcome,
  type TestContext,
} from '@stepforge/core';
import { existsSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { androidQueries } from './locators.ts';
import { WebDriverError, WebDriverSession, type ElementRef } from './webdriver.ts';

const pad = (n: number) => String(n).padStart(3, '0');
const describe = (l: Locator) => `${l.strategy}=${l.value}${l.name ? ` "${l.name}"` : ''}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Found = { el: ElementRef; used: Locator; index: number; matches: number };

/** Android key codes for the key names steps use (as on the web). */
const KEYCODES: Record<string, number> = {
  Enter: 66,
  Tab: 61,
  Escape: 111,
  Backspace: 67,
  Delete: 112,
  Space: 62,
  ArrowUp: 19,
  ArrowDown: 20,
  ArrowLeft: 21,
  ArrowRight: 22,
  Home: 3,
  Back: 4,
  Menu: 82,
  Search: 84,
};

/** The Appium capabilities for an environment's Android launch settings. */
export function androidCapabilities(launch: AndroidLaunch): Record<string, unknown> {
  const caps: Record<string, unknown> = {
    platformName: 'Android',
    'appium:automationName': 'UiAutomator2',
    'appium:noReset': launch.resetApp === false,
    'appium:fullReset': false,
    'appium:autoGrantPermissions': true,
    'appium:newCommandTimeout': 300,
    'appium:disableWindowAnimation': true,
    'appium:uiautomator2ServerInstallTimeout': 120_000,
    'appium:uiautomator2ServerLaunchTimeout': 120_000,
    'appium:adbExecTimeout': 60_000,
    'appium:appWaitDuration': 60_000,
  };
  if (launch.app) {
    const app = isAbsolute(launch.app) ? launch.app : resolve(launch.app);
    if (!existsSync(app)) throw new StepError('invalid_params', `The app file was not found: ${app}`);
    caps['appium:app'] = app;
  }
  if (launch.appPackage) caps['appium:appPackage'] = launch.appPackage;
  if (launch.appActivity) caps['appium:appActivity'] = launch.appActivity;
  if (!launch.app && !launch.appPackage)
    throw new StepError(
      'invalid_params',
      'Set the app file (.apk) or the installed app’s package in the environment',
    );
  if (launch.udid) caps['appium:udid'] = launch.udid;
  if (launch.avd) {
    caps['appium:avd'] = launch.avd;
    caps['appium:avdArgs'] = launch.showEmulator ? '-no-audio' : '-no-window -no-audio -no-boot-anim';
    caps['appium:avdLaunchTimeout'] = 300_000;
    caps['appium:avdReadyTimeout'] = 300_000;
  }
  return { ...caps, ...(launch.capabilities ?? {}) };
}

/** One test in an Android app, through a local Appium server (UiAutomator2). */
export class AndroidSession implements ExecutorSession {
  private driver!: WebDriverSession;
  private recording = false;
  private failureArtifacts: ArtifactRef[] = [];

  constructor(
    private readonly ctx: TestContext,
    private readonly appiumUrl: () => Promise<string>,
  ) {}

  async open(): Promise<void> {
    const launch = this.ctx.options.android!;
    const caps = androidCapabilities(launch);
    const url = await this.appiumUrl().catch((err: Error) => {
      throw new StepError('navigation', err.message);
    });
    try {
      // The first test may boot the emulator and install Appium's helper app: allow minutes, not seconds.
      this.driver = await WebDriverSession.create(url, caps, 420_000);
    } catch (err) {
      if (err instanceof StepError) throw err;
      throw new StepError('navigation', `The Android app did not start: ${(err as Error).message}`);
    }
    this.ctx.shared.set('android.driver', this.driver);
    // Older device log lines are not this test's.
    await this.driver.logs('logcat').catch(() => []);
    if (this.ctx.options.video !== 'off') {
      this.recording = await this.driver
        .startRecording({ timeLimit: '1800', bitRate: '2000000' })
        .then(() => true)
        .catch(() => false);
    }
  }

  /** Finds the element with the ranked locators, waiting up to the timeout. A lower-ranked match is "healed". */
  private async find(locators: Locator[], timeoutMs: number, signal?: AbortSignal): Promise<Found> {
    if (!locators.length) throw new StepError('invalid_params', 'This step needs at least one locator');
    const queries = locators.map((l) => androidQueries(l));
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
    for (const q of androidQueries(l)) {
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
        return (await this.driver.attribute(el, 'checked')) === 'true';
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
              'An Android app has no pages to open: the app starts on its first screen. Use a full deep link (myapp://…) to open a screen',
            );
          await this.driver.execute('mobile: deepLink', [
            { url, package: (this.driver.capabilities['appium:appPackage'] as string) ?? undefined },
          ]);
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
          await this.driver.execute('mobile: doubleClickGesture', [{ elementId: found!.el }]);
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
          if (key === 'Back') await this.driver.back();
          else {
            const keycode = KEYCODES[key];
            if (keycode === undefined)
              throw new StepError(
                'invalid_params',
                `The key "${key}" is not available on Android (keys: ${Object.keys(KEYCODES).join(', ')})`,
              );
            await this.driver.execute('mobile: pressKey', [{ keycode }]);
          }
          outcome = { message: `Pressed ${key}` };
          break;
        }
        case 'check':
        case 'uncheck': {
          await needs();
          const want = name === 'check';
          if (((await this.driver.attribute(found!.el, 'checked')) === 'true') !== want)
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
            `"${step.type}" is not available in Android apps yet (it is a web-page step); see docs/ANDROID_APPS.md`,
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
  private async scroll(direction: 'up' | 'down'): Promise<boolean> {
    const size = (await this.driver.execute('mobile: deviceScreenInfo').catch(() => null)) as {
      realDisplaySize?: string;
    } | null;
    const [w, h] = (size?.realDisplaySize ?? '1080x2400').split('x').map(Number) as [number, number];
    const more = await this.driver.execute('mobile: scrollGesture', [
      {
        left: Math.round(w * 0.1),
        top: Math.round(h * 0.2),
        width: Math.round(w * 0.8),
        height: Math.round(h * 0.6),
        direction,
        percent: 0.75,
      },
    ]);
    return more === true;
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
    if (this.recording) {
      const video = await this.driver.stopRecording().catch(() => null);
      if (video?.length && keep(o.video)) {
        const path = join(this.ctx.artifactsDir, 'video.mp4');
        writeFileSync(path, video);
        artifacts.push({ kind: 'video', path });
      }
    }
    if (o.captureLogs) {
      // The device log (logcat) is the app's console; a crash is reported as an error.
      const lines = await this.driver.logs('logcat').catch(() => []);
      const log = lines.slice(-2000).map((l) => ({
        type: /FATAL EXCEPTION|ANR in /.test(l.message) ? 'error' : 'logcat',
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
