// Phone and desktop-app steps through Appium (WebdriverIO), done the way StepForge (by Md Zarin Tasnim) does them:
// every lookup and check waits (30 s by default), and an element is found by the first of its Appium selectors
// (strategy, value) that matches.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { remote } from 'webdriverio';

export type Platform = 'android' | 'ios' | 'macos' | 'windows' | 'linux';
export type Selectors = [using: string, value: string][];
type Ref = Record<string, string>;
type Driver = Awaited<ReturnType<typeof remote>>;

const ELEMENT = 'element-6066-11e4-a52e-4f735466cecf';
const idOf = (el: Ref) => el[ELEMENT] ?? el.ELEMENT!;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const ANDROID_KEYS: Record<string, number> = {
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
  Menu: 82,
  Search: 84,
};
const IOS_KEYS: Record<string, string> = { Enter: '\n', Tab: '\t', Backspace: '\b', Space: ' ' };
const W3C_KEYS: Record<string, string> = {
  Enter: '',
  Return: '',
  Tab: '',
  Escape: '',
  Backspace: '',
  Delete: '',
  Space: ' ',
  ArrowLeft: '',
  ArrowUp: '',
  ArrowRight: '',
  ArrowDown: '',
  Home: '',
  End: '',
  PageUp: '',
  PageDown: '',
  Shift: '',
  Control: '',
  Ctrl: '',
  Alt: '',
  Option: '',
  Meta: '',
  Command: '',
  Cmd: '',
  ...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`F${i + 1}`, String.fromCharCode(0xe031 + i)])),
};
const PERMISSIONS: Record<string, [string[], string]> = {
  camera: [['android.permission.CAMERA'], 'camera'],
  location: [
    ['android.permission.ACCESS_FINE_LOCATION', 'android.permission.ACCESS_COARSE_LOCATION'],
    'location',
  ],
  microphone: [['android.permission.RECORD_AUDIO'], 'microphone'],
  contacts: [['android.permission.READ_CONTACTS'], 'contacts'],
  photos: [['android.permission.READ_MEDIA_IMAGES'], 'photos'],
  notifications: [['android.permission.POST_NOTIFICATIONS'], ''],
  calendar: [['android.permission.READ_CALENDAR'], 'calendar'],
};

/** An XPath string literal for any text. */
const literal = (s: string) =>
  !s.includes("'")
    ? `'${s}'`
    : !s.includes('"')
      ? `"${s}"`
      : `concat(${s
          .split("'")
          .map((p) => `'${p}'`)
          .join(`, "'", `)})`;
const predicate = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/** Starts the app through Appium (or StepForge's Linux helper) with these capabilities. */
export async function startApp(
  url: string,
  capabilities: Record<string, unknown>,
  platform: Platform,
  timeout = 30,
): Promise<App> {
  const u = new URL(url);
  const driver = await remote({
    protocol: u.protocol.replace(':', '') as 'http',
    hostname: u.hostname,
    port: Number(u.port || 4723),
    path: u.pathname,
    capabilities: capabilities as WebdriverIO.Capabilities,
    logLevel: 'warn',
    connectionRetryTimeout: 600_000,
  });
  return new App(driver, platform, timeout);
}

export class App {
  private appIdCache?: string;

  constructor(
    readonly driver: Driver,
    readonly platform: Platform,
    readonly timeout = 30,
  ) {}

  // ─── Finding ──────────────────────────────────────────────────────────────
  /** The elements the first matching selector finds now (no waiting), or []. */
  async all(selectors: Selectors): Promise<Ref[]> {
    for (const [using, value] of selectors) {
      let found: Ref[] = [];
      try {
        found = (await this.driver.findElements(using, value)) as unknown as Ref[];
      } catch (err) {
        if (/invalid selector/i.test(String(err)))
          throw new Error(`Invalid locator ${using}=${value}: ${err}`);
      }
      if (found.length) return found;
    }
    return [];
  }

  async find(selectors: Selectors, timeout = this.timeout): Promise<string> {
    const deadline = Date.now() + timeout * 1000;
    for (;;) {
      const found = await this.all(selectors);
      if (found.length) return idOf(found[0]!);
      if (Date.now() >= deadline)
        throw new Error(`No element found within ${timeout} s: ${JSON.stringify(selectors)}`);
      await sleep(250);
    }
  }

  private async attempt<T>(f: () => Promise<T>): Promise<T | undefined> {
    try {
      return await f();
    } catch {
      return undefined;
    }
  }

  private run(script: string, args?: Record<string, unknown>): Promise<unknown> {
    return this.driver.execute(script, ...(args ? [args] : []));
  }

  // ─── Actions ──────────────────────────────────────────────────────────────
  async click(selectors: Selectors): Promise<void> {
    await this.driver.elementClick(await this.find(selectors));
  }

  async doubleClick(selectors: Selectors): Promise<void> {
    const el = await this.find(selectors);
    if (this.platform === 'android') await this.run('mobile: doubleClickGesture', { elementId: el });
    else if (this.platform === 'ios') await this.run('mobile: doubleTap', { elementId: el });
    else if (this.platform === 'macos') await this.run('macos: doubleClick', { elementId: el });
    else {
      await this.driver.elementClick(el);
      await this.driver.elementClick(el);
    }
  }

  async fill(selectors: Selectors, text: unknown): Promise<void> {
    const el = await this.find(selectors);
    await this.driver.elementClear(el);
    await this.driver.elementSendKeys(el, String(text));
  }

  async type(selectors: Selectors, text: unknown): Promise<void> {
    await this.driver.elementSendKeys(await this.find(selectors), String(text));
  }

  async clear(selectors: Selectors): Promise<void> {
    await this.driver.elementClear(await this.find(selectors));
  }

  async isChecked(el: string): Promise<boolean> {
    const attr = (name: string) => this.attempt(() => this.driver.getElementAttribute(el, name));
    if (this.platform === 'android' || this.platform === 'linux') return (await attr('checked')) === 'true';
    if (this.platform === 'ios' || this.platform === 'macos')
      return ['1', 'true'].includes((await attr('value')) ?? '');
    return /^(on|1|true)$/i.test((await attr('Toggle.ToggleState')) ?? '');
  }

  async setChecked(selectors: Selectors, want: boolean): Promise<void> {
    const el = await this.find(selectors);
    if ((await this.isChecked(el)) !== want) await this.driver.elementClick(el);
  }

  /** A spinner or pop-up: opens it, then taps the option with that text. */
  async select(selectors: Selectors, label: unknown): Promise<void> {
    await this.click(selectors);
    const t = String(label);
    const option: Selectors =
      this.platform === 'android'
        ? [['-android uiautomator', `new UiSelector().text(${predicate(t)})`]]
        : this.platform === 'ios'
          ? [['-ios predicate string', `label == ${predicate(t)} OR value == ${predicate(t)}`]]
          : this.platform === 'macos'
            ? [
                [
                  '-ios predicate string',
                  `title == ${predicate(t)} OR label == ${predicate(t)} OR value == ${predicate(t)}`,
                ],
              ]
            : [['name', t]];
    await this.click(option);
  }

  async press(key: string, selectors?: Selectors): Promise<void> {
    const el = selectors ? await this.find(selectors) : undefined;
    if (el) await this.driver.elementClick(el);
    if (this.platform === 'android') {
      if (key === 'Back') return void (await this.driver.back());
      if (ANDROID_KEYS[key] === undefined) throw new Error(`The key "${key}" is not available on Android`);
      return void (await this.run('mobile: pressKey', { keycode: ANDROID_KEYS[key] }));
    }
    if (this.platform === 'ios') {
      if (key === 'Home') return void (await this.run('mobile: pressButton', { name: 'home' }));
      if (IOS_KEYS[key] === undefined) throw new Error(`The key "${key}" is not available on iOS`);
      const target = el ?? idOf((await this.driver.getActiveElement()) as unknown as Ref);
      return void (await this.driver.elementSendKeys(target, IOS_KEYS[key]!));
    }
    await this.shortcut(key);
  }

  /** A key or a shortcut ("Control+S") with W3C key actions: modifiers down, the key, modifiers up. */
  async shortcut(combo: string): Promise<void> {
    const keys = combo
      .split('+')
      .map((k) => k.trim())
      .filter(Boolean)
      .map((k) => {
        const v =
          W3C_KEYS[k] ?? W3C_KEYS[k[0]!.toUpperCase() + k.slice(1)] ?? (k.length === 1 ? k : undefined);
        if (v === undefined) throw new Error(`Unknown key "${k}" in "${combo}"`);
        return v;
      });
    const actions = [
      ...keys.map((value) => ({ type: 'keyDown', value })),
      ...[...keys].reverse().map((value) => ({ type: 'keyUp', value })),
    ];
    await this.driver.performActions([{ type: 'key', id: 'keyboard', actions }]);
  }

  // ─── Checks and reading ───────────────────────────────────────────────────
  async read(source: string, selectors: Selectors, attribute?: string): Promise<unknown> {
    if (source === 'count') return (await this.all(selectors)).length;
    const el = await this.find(selectors);
    if (source === 'attribute') return this.driver.getElementAttribute(el, attribute ?? '');
    return ((await this.driver.getElementText(el)) ?? '').trim();
  }

  /** Waits until the check passes (as StepForge's assert step), else fails with what was seen. */
  async expect(check: string, selectors: Selectors, expected?: unknown, attribute?: string): Promise<void> {
    const deadline = Date.now() + this.timeout * 1000;
    for (;;) {
      const [ok, seen] = await this.check(check, selectors, expected, attribute);
      if (ok) return;
      if (Date.now() >= deadline)
        throw new Error(
          `Expected ${check}${expected === undefined ? '' : ` ${JSON.stringify(expected)}`}, but got ${seen}`,
        );
      await sleep(250);
    }
  }

  private async check(
    check: string,
    selectors: Selectors,
    expected: unknown,
    attribute?: string,
  ): Promise<[boolean, string]> {
    try {
      const found = await this.all(selectors);
      if (check === 'count') return [found.length === Number(expected), `${found.length} found`];
      const el = found.length ? idOf(found[0]!) : undefined;
      if (check === 'hidden') {
        const visible = !!el && (await this.driver.isElementDisplayed(el));
        return [!visible, visible ? 'visible' : 'not visible'];
      }
      if (!el) return [false, 'not found'];
      if (check === 'visible') return [await this.driver.isElementDisplayed(el), 'present but not visible'];
      if (check === 'enabled' || check === 'disabled') {
        const enabled = await this.driver.isElementEnabled(el);
        return [enabled === (check === 'enabled'), enabled ? 'enabled' : 'disabled'];
      }
      if (check === 'checked' || check === 'unchecked') {
        const checked = await this.isChecked(el);
        return [checked === (check === 'checked'), checked ? 'checked' : 'unchecked'];
      }
      if (check === 'attribute') {
        const value = await this.driver.getElementAttribute(el, attribute ?? '');
        return [value === String(expected), JSON.stringify(value)];
      }
      const text = ((await this.driver.getElementText(el)) ?? '').trim();
      if (check === 'text' || check === 'value') return [text === String(expected), JSON.stringify(text)];
      if (check === 'textContains') return [text.includes(String(expected)), JSON.stringify(text)];
      if (check === 'textMatches') return [new RegExp(String(expected)).test(text), JSON.stringify(text)];
      throw new Error(`Unknown check "${check}"`);
    } catch (err) {
      if (/Unknown check/.test(String(err))) throw err;
      return [false, `not ready (${(err as Error).message.split('\n')[0]})`];
    }
  }

  waitFor(selectors: Selectors, state = 'visible'): Promise<void> {
    return this.expect(state === 'hidden' || state === 'detached' ? 'hidden' : 'visible', selectors);
  }

  async screenshot(name: string, selectors?: Selectors): Promise<string> {
    mkdirSync('screenshots', { recursive: true });
    const path = join('screenshots', `${name}.png`);
    const b64 = selectors
      ? await this.driver.takeElementScreenshot(await this.find(selectors))
      : await this.driver.takeScreenshot();
    writeFileSync(path, Buffer.from(b64, 'base64'));
    return path;
  }

  // ─── Gestures ─────────────────────────────────────────────────────────────
  private async area() {
    const { width: w, height: h } = await this.driver.getWindowRect();
    return {
      left: Math.round(w * 0.1),
      top: Math.round(h * 0.2),
      width: Math.round(w * 0.8),
      height: Math.round(h * 0.6),
    };
  }

  /** Scrolls the screen; false when it could not move any more (Android says so). */
  async scroll(direction: 'up' | 'down' = 'down'): Promise<boolean> {
    const p = this.platform;
    if (p === 'android')
      return (
        (await this.run('mobile: scrollGesture', { ...(await this.area()), direction, percent: 0.75 })) ===
        true
      );
    // On iOS a swipe up moves the content down.
    if (p === 'ios') await this.run('mobile: swipe', { direction: direction === 'down' ? 'up' : 'down' });
    else if (p === 'macos')
      await this.run('macos: scroll', {
        x: 400,
        y: 300,
        deltaX: 0,
        deltaY: direction === 'down' ? -200 : 200,
      });
    else if (p === 'windows')
      await this.run('windows: scroll', { deltaY: direction === 'down' ? -360 : 360 });
    else await this.shortcut(direction === 'down' ? 'PageDown' : 'PageUp');
    return true;
  }

  /** Looks, scrolls, looks again, until the element shows or the screen stops moving. */
  async scrollTo(selectors: Selectors, direction: 'up' | 'down' = 'down', maxSwipes = 10): Promise<void> {
    let stuck = 0;
    for (let i = 0; i <= maxSwipes; i++) {
      const found = await this.all(selectors);
      if (found.length && (await this.attempt(() => this.driver.isElementDisplayed(idOf(found[0]!))))) return;
      if (i === maxSwipes || stuck >= 2) break;
      const before = (await this.attempt(() => this.driver.getPageSource())) ?? '';
      await this.scroll(direction);
      await sleep(400);
      const after = (await this.attempt(() => this.driver.getPageSource())) ?? '';
      stuck = before && before === after ? stuck + 1 : 0;
    }
    throw new Error(`Scrolled ${direction} and the element did not show: ${JSON.stringify(selectors)}`);
  }

  swipe(direction: string, percent = 0.75): Promise<void> {
    return this.swipeAt(direction, percent);
  }

  async swipeOn(selectors: Selectors, direction: string, percent = 0.75): Promise<void> {
    return this.swipeAt(direction, percent, await this.find(selectors));
  }

  private async swipeAt(direction: string, percent: number, el?: string): Promise<void> {
    const p = this.platform;
    if (p === 'android')
      await this.run('mobile: swipeGesture', {
        ...(el ? { elementId: el } : await this.area()),
        direction,
        percent,
      });
    else if (p === 'ios' || p === 'macos')
      await this.run(`${p === 'ios' ? 'mobile' : 'macos'}: swipe`, {
        direction,
        ...(el && { elementId: el }),
      });
    else throw new Error('A swipe is for phone apps; desktop apps use the mouse, keyboard and menus');
  }

  async drag(selectors: Selectors, to: Selectors): Promise<void> {
    const [a, b] = [await this.find(selectors), await this.find(to)];
    const [ra, rb] = [await this.driver.getElementRect(a), await this.driver.getElementRect(b)];
    const centre = (r: typeof ra) => [Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2)];
    const [fx, fy] = centre(ra);
    const [tx, ty] = centre(rb);
    const p = this.platform;
    if (p === 'android') await this.run('mobile: dragGesture', { elementId: a, endX: tx, endY: ty });
    else if (p === 'ios')
      await this.run('mobile: dragFromToForDuration', {
        duration: 1,
        fromX: fx,
        fromY: fy,
        toX: tx,
        toY: ty,
      });
    else if (p === 'macos')
      await this.run('macos: clickAndDrag', { startX: fx, startY: fy, endX: tx, endY: ty, duration: 1 });
    else if (p === 'windows') await this.run('windows: clickAndDrag', { startElementId: a, endElementId: b });
    else throw new Error('Drag and drop is not available in Linux apps');
  }

  async longPress(selectors: Selectors, ms = 1000): Promise<void> {
    const el = await this.find(selectors);
    const p = this.platform;
    if (p === 'android') await this.run('mobile: longClickGesture', { elementId: el, duration: ms });
    else if (p === 'ios') await this.run('mobile: touchAndHold', { elementId: el, duration: ms / 1000 });
    else if (p === 'macos') await this.run('macos: press', { elementId: el, duration: ms / 1000 });
    else throw new Error('A long press is for phone apps; desktop apps use the mouse, keyboard and menus');
  }

  async back(): Promise<void> {
    await this.driver.back();
  }

  async hideKeyboard(): Promise<void> {
    if (this.platform !== 'android' && this.platform !== 'ios') return;
    if ((await this.attempt(() => this.run('mobile: isKeyboardShown'))) === false) return;
    // iOS hides the keyboard through one of its keys.
    if (this.platform === 'android') await this.run('mobile: hideKeyboard');
    else await this.run('mobile: hideKeyboard', { keys: ['done', 'Done', 'return', 'Return'] });
  }

  async rotate(orientation: string): Promise<void> {
    await this.driver.setOrientation(orientation === 'portrait' ? 'PORTRAIT' : 'LANDSCAPE');
  }

  // ─── The app and the device ───────────────────────────────────────────────
  async appId(): Promise<string> {
    if (this.appIdCache) return this.appIdCache;
    const caps = this.driver.capabilities as Record<string, unknown>;
    const cap = (k: string) => (caps[k] ?? caps[`appium:${k}`]) as string | undefined;
    if (this.platform === 'android')
      this.appIdCache = cap('appPackage') ?? String(await this.run('mobile: getCurrentPackage'));
    else if (this.platform === 'ios')
      this.appIdCache =
        cap('bundleId') ??
        ((await this.run('mobile: activeAppInfo')) as { bundleId?: string } | null)?.bundleId;
    else this.appIdCache = cap('bundleId') ?? cap('appPath');
    return this.appIdCache ?? '';
  }

  private async app(): Promise<Record<string, string>> {
    const caps = this.driver.capabilities as Record<string, unknown>;
    if (this.platform === 'macos' && !(caps.bundleId ?? caps['appium:bundleId']))
      return { path: await this.appId() };
    return { [this.platform === 'android' ? 'appId' : 'bundleId']: await this.appId() };
  }

  launchApp(): Promise<void> {
    return this.appAction('activateApp');
  }

  closeApp(): Promise<void> {
    return this.appAction('terminateApp');
  }

  async resetApp(): Promise<void> {
    if (this.platform !== 'android' && this.platform !== 'ios')
      throw new Error('"reset" is for phone apps; close and launch the app instead');
    await this.run('mobile: clearApp', await this.app());
  }

  private async appAction(name: 'activateApp' | 'terminateApp'): Promise<void> {
    const p = this.platform;
    if (p === 'android' || p === 'ios') await this.run(`mobile: ${name}`, await this.app());
    else if (p === 'macos') await this.run(`macos: ${name}`, await this.app());
    else if (p === 'windows')
      await this.run(name === 'activateApp' ? 'windows: launchApp' : 'windows: closeApp');
    else throw new Error('Each Linux test starts and closes the app itself');
  }

  async backgroundApp(seconds = -1): Promise<void> {
    if (this.platform !== 'android' && this.platform !== 'ios')
      throw new Error('"background" is for phone apps; close and launch the app instead');
    await this.run('mobile: backgroundApp', { seconds });
  }

  async deepLink(url: string): Promise<void> {
    const p = this.platform;
    if (p === 'android') await this.run('mobile: deepLink', { url, package: await this.appId() });
    else if (p === 'ios') await this.run('mobile: deepLink', { url, bundleId: await this.appId() });
    else if (p === 'macos') await this.run('macos: deepLink', { url, ...(await this.app()) });
    else throw new Error('Opening a deep link is for phone apps');
  }

  async setLocation(latitude: number, longitude: number): Promise<void> {
    if (this.platform === 'android') await this.run('mobile: setGeolocation', { latitude, longitude });
    else if (this.platform === 'ios') await this.run('mobile: setSimulatedLocation', { latitude, longitude });
    else throw new Error('Setting the location is for phone apps');
  }

  async permission(name: string, grant = true): Promise<void> {
    const [android, ios] = PERMISSIONS[name.toLowerCase()] ?? [[name], name];
    if (this.platform === 'android')
      await this.run('mobile: changePermissions', {
        permissions: android,
        appPackage: await this.appId(),
        action: grant ? 'grant' : 'revoke',
      });
    else if (this.platform === 'ios') {
      if (!ios) throw new Error(`On iOS the app itself asks for the ${name} permission: answer its dialog`);
      await this.run('mobile: setPermission', {
        bundleId: await this.appId(),
        access: { [ios]: grant ? 'yes' : 'no' },
      });
    } else throw new Error('Granting permissions is for phone apps');
  }

  async pushNotification(title: string, body: string): Promise<void> {
    if (this.platform !== 'ios')
      throw new Error(
        "Sending a notification works on iOS simulators (Android needs the app's own push service)",
      );
    await this.run('mobile: pushNotification', {
      bundleId: await this.appId(),
      payload: { aps: { alert: { title, body }, sound: 'default' } },
    });
  }

  /** A desktop app's menu path: "File > Save". */
  async menu(path: string): Promise<void> {
    const titles = path
      .split('>')
      .map((t) => t.trim())
      .filter(Boolean);
    for (const [i, title] of titles.entries()) {
      const selectors: Selectors =
        this.platform === 'macos'
          ? [
              [
                '-ios class chain',
                `**/${i === 0 ? 'XCUIElementTypeMenuBarItem' : 'XCUIElementTypeMenuItem'}[\`title == ${predicate(title)}\`]`,
              ],
            ]
          : this.platform === 'windows'
            ? [['xpath', `//MenuItem[@Name=${literal(title)}]`]]
            : this.platform === 'linux'
              ? [
                  ['xpath', `//${i === 0 ? 'menu' : 'menu_item'}[@name=${literal(title)}]`],
                  ['xpath', `//menu[@name=${literal(title)}]`],
                ]
              : [];
      if (!selectors.length)
        throw new Error('Menu bars are for desktop apps; in a phone app tap the menu button instead');
      await this.driver.elementClick(await this.find(selectors, 10));
    }
  }

  /** Answers the dialog on screen, waiting for it to appear. */
  async handleDialog(accept = true, button: string | null = null): Promise<void> {
    const deadline = Date.now() + this.timeout * 1000;
    for (;;) {
      try {
        if (await this.dialog(accept, button ?? undefined)) return;
      } catch (err) {
        if (!/no such alert|no alert|not.*(present|open|shown)|cannot be found/i.test(String(err))) throw err;
      }
      if (Date.now() >= deadline) throw new Error(`No dialog appeared within ${this.timeout} s`);
      await sleep(250);
    }
  }

  private async dialog(accept: boolean, button?: string): Promise<boolean> {
    const p = this.platform;
    if (p === 'android') {
      await this.run(
        accept ? 'mobile: acceptAlert' : 'mobile: dismissAlert',
        button ? { buttonLabel: button } : {},
      );
      return true;
    }
    if (p === 'ios') {
      await this.run('mobile: alert', {
        action: accept ? 'accept' : 'dismiss',
        ...(button && { buttonLabel: button }),
      });
      return true;
    }
    const label = button ?? (accept ? 'OK' : 'Cancel');
    if (p === 'macos') {
      const sheets: Selectors = [['-ios class chain', '**/XCUIElementTypeSheet']];
      let found = await this.all([
        ['-ios class chain', `**/XCUIElementTypeButton[\`title == ${predicate(label)}\`]`],
      ]);
      if (!found.length && !button && (await this.all(sheets)).length)
        found = await this.all([['accessibility id', accept ? 'action-button-1' : 'action-button-2']]);
      if (!found.length) return false;
      await this.attempt(() => this.driver.elementClick(idOf(found[0]!)));
      // A sheet can report its buttons at the wrong place (several displays): the keyboard answers it.
      for (let i = 0; i < 6; i++) {
        await sleep(250);
        if (!(await this.all(sheets)).length) return true;
      }
      await this.shortcut((!accept && !button) || /^cancel$/i.test(label) ? 'Escape' : 'Enter');
      return true;
    }
    const selectors: Selectors =
      p === 'windows'
        ? [['xpath', `//Window//Button[@Name=${literal(label)}]`]]
        : [
            ['xpath', `//alert//push_button[@name=${literal(label)}]`],
            ['xpath', `//dialog//push_button[@name=${literal(label)}]`],
          ];
    if (!(await this.all(selectors)).length) return false;
    // A dialog that is still opening ignores the first press: press until it has gone.
    for (let attempt = 0; attempt < 5; attempt++) {
      const found = await this.all(selectors);
      if (!found.length) return true;
      await this.attempt(() => this.driver.elementClick(idOf(found[0]!)));
      for (let i = 0; i < 8; i++) {
        await sleep(250);
        if (!(await this.all(selectors)).length) return true;
      }
    }
    throw new Error('The dialog did not close after pressing its button');
  }

  /** Ends the test: a failed test keeps a screenshot of the screen, then the app closes. */
  async end(test?: { title: string; state?: string }): Promise<void> {
    if (test?.state === 'failed')
      await this.attempt(() => this.screenshot(`${test.title.replace(/[^\w.-]+/g, '-')}-failed`));
    await this.attempt(() => this.driver.deleteSession());
  }
}
