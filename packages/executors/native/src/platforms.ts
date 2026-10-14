import {
  StepError,
  type AndroidLaunch,
  type IosLaunch,
  type Locator,
  type MacLaunch,
  type WindowsLaunch,
} from '@stepforge/core';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { listSimulators } from './ios.ts';
import {
  androidQueries,
  iosQueries,
  macQueries,
  predicateLiteral,
  windowsQueries,
  xpathLiteral,
  type Query,
} from './locators.ts';
import { parseElements } from './recorder.ts';
import type { ElementRef, WebDriverSession } from './webdriver.ts';

/** What differs between Android and iOS for the same steps. */
export type NativePlatform = {
  name: 'Android' | 'iOS' | 'macOS' | 'Windows';
  /** Phone (touch, device) or desktop (mouse, keyboard, menus). */
  kind: 'phone' | 'desktop';
  /** The Appium driver this platform needs. */
  driver: 'uiautomator2' | 'xcuitest' | 'mac2' | 'novawindows';
  capabilities(): Record<string, unknown>;
  queries(l: Locator): Query[];
  isChecked(d: WebDriverSession, el: ElementRef): Promise<boolean>;
  pressKey(d: WebDriverSession, key: string, el?: ElementRef): Promise<void>;
  deepLink(d: WebDriverSession, url: string): Promise<void>;
  doubleTap(d: WebDriverSession, el: ElementRef): Promise<void>;
  /** Swipes the screen; false when nothing moved any more (when the platform says so). */
  scroll(d: WebDriverSession, direction: 'up' | 'down'): Promise<boolean>;
  /** The device log Appium reads, and what in it means the app crashed. */
  log: { type: string; crash: RegExp };
  /** Starts a screen recording; the returned function stops it and gives the MP4 (null when it could not record). */
  record(d: WebDriverSession): Promise<(() => Promise<Buffer | null>) | null>;
  /** The app under test: its package (Android) or bundle id (iOS). */
  appId(d: WebDriverSession): Promise<string>;
  longPress(d: WebDriverSession, el: ElementRef, ms: number): Promise<void>;
  /** Swipes on an element, or on the screen. */
  swipe(d: WebDriverSession, direction: Direction, percent: number, el?: ElementRef): Promise<void>;
  /** Drags one element onto another. */
  drag(d: WebDriverSession, from: ElementRef, to: ElementRef): Promise<void>;
  setLocation(d: WebDriverSession, latitude: number, longitude: number): Promise<void>;
  appState(
    d: WebDriverSession,
    action: 'launch' | 'close' | 'background' | 'reset',
    seconds?: number,
  ): Promise<void>;
  permission(d: WebDriverSession, name: string, grant: boolean): Promise<void>;
  pushNotification(d: WebDriverSession, title: string, body: string): Promise<void>;
  hideKeyboard(d: WebDriverSession): Promise<void>;
  /** Answers the dialog on screen (an app or system alert); throws while there is none. */
  dialog(d: WebDriverSession, accept: boolean, buttonLabel?: string): Promise<void>;
  /** 1 not running, 2–3 in the background, 4 on screen (Appium's app states). */
  queryAppState(d: WebDriverSession): Promise<number | undefined>;
  /** Desktop apps: opens a menu path such as ["File", "Save"]. */
  menu(d: WebDriverSession, path: string[]): Promise<void>;
};

export type Direction = 'up' | 'down' | 'left' | 'right';

/** Friendly permission names → Android permissions and iOS privacy services. */
const PERMISSIONS: Record<string, { android: string[]; ios: string }> = {
  camera: { android: ['android.permission.CAMERA'], ios: 'camera' },
  location: {
    android: ['android.permission.ACCESS_FINE_LOCATION', 'android.permission.ACCESS_COARSE_LOCATION'],
    ios: 'location',
  },
  microphone: { android: ['android.permission.RECORD_AUDIO'], ios: 'microphone' },
  contacts: { android: ['android.permission.READ_CONTACTS'], ios: 'contacts' },
  photos: { android: ['android.permission.READ_MEDIA_IMAGES'], ios: 'photos' },
  // iOS: only the app can ask (answer its dialog with the dialog step).
  notifications: { android: ['android.permission.POST_NOTIFICATIONS'], ios: '' },
  calendar: { android: ['android.permission.READ_CALENDAR'], ios: 'calendar' },
};

/** Remembers the app id once per session. */
function cachedAppId(read: (d: WebDriverSession) => Promise<string>) {
  const known = new WeakMap<WebDriverSession, string>();
  return async (d: WebDriverSession) => {
    const hit = known.get(d);
    if (hit) return hit;
    const id = await read(d);
    if (!id) throw new StepError('unknown', 'Could not tell which app is under test');
    known.set(d, id);
    return id;
  };
}

/** Appium's own screen recorder (Android: on the device; iOS: needs ffmpeg). */
async function appiumRecording(d: WebDriverSession): Promise<(() => Promise<Buffer | null>) | null> {
  try {
    await d.startRecording({ timeLimit: '1800', bitRate: '2000000' });
  } catch {
    return null;
  }
  return () => d.stopRecording().catch(() => null);
}

/** A simulator's screen, recorded by Xcode's own tool (no ffmpeg needed). */
async function simulatorRecording(udid: string): Promise<(() => Promise<Buffer | null>) | null> {
  const dir = mkdtempSync(join(tmpdir(), 'sf-sim-video-'));
  const file = join(dir, 'video.mp4');
  const proc = spawn('xcrun', ['simctl', 'io', udid, 'recordVideo', '--codec=h264', '--force', file], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  // It prints "Recording started" once it records.
  const started = await new Promise<boolean>((done) => {
    const t = setTimeout(() => done(false), 15_000);
    proc.stderr!.on('data', (b: Buffer) => {
      if (/Recording started/i.test(b.toString())) {
        clearTimeout(t);
        done(true);
      }
    });
    proc.on('exit', () => {
      clearTimeout(t);
      done(false);
    });
  });
  if (!started) {
    proc.kill();
    rmSync(dir, { recursive: true, force: true });
    return null;
  }
  return async () => {
    await new Promise<void>((done) => {
      proc.on('exit', () => done());
      proc.kill('SIGINT');
      setTimeout(() => {
        proc.kill('SIGKILL');
        done();
      }, 20_000);
    });
    const video = existsSync(file) ? readFileSync(file) : null;
    rmSync(dir, { recursive: true, force: true });
    return video;
  };
}

const appFile = (path: string) => {
  const app = isAbsolute(path) ? path : resolve(path);
  if (!existsSync(app)) throw new StepError('invalid_params', `The app file was not found: ${app}`);
  return app;
};

/** Android key codes for the key names steps use (as on the web). */
export const ANDROID_KEYCODES: Record<string, number> = {
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
    caps['appium:app'] = appFile(launch.app);
    // Install this exact file: Appium otherwise keeps an installed app with the same version number.
    if (launch.resetApp !== false) caps['appium:enforceAppInstall'] = true;
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

export function androidPlatform(launch: AndroidLaunch): NativePlatform {
  return {
    name: 'Android',
    kind: 'phone',
    driver: 'uiautomator2',
    capabilities: () => androidCapabilities(launch),
    queries: androidQueries,
    isChecked: async (d, el) => (await d.attribute(el, 'checked')) === 'true',
    async pressKey(d, key) {
      if (key === 'Back') return void (await d.back());
      const keycode = ANDROID_KEYCODES[key];
      if (keycode === undefined)
        throw new StepError(
          'invalid_params',
          `The key "${key}" is not available on Android (keys: ${Object.keys(ANDROID_KEYCODES).join(', ')})`,
        );
      await d.execute('mobile: pressKey', [{ keycode }]);
    },
    deepLink: async (d, url) =>
      void (await d.execute('mobile: deepLink', [
        { url, package: (d.capabilities['appium:appPackage'] as string) ?? launch.appPackage },
      ])),
    doubleTap: async (d, el) => void (await d.execute('mobile: doubleClickGesture', [{ elementId: el }])),
    async scroll(d, direction) {
      // The app window's size (pixels on Android).
      const { width: w, height: h } = await d.windowSize();
      const more = await d.execute('mobile: scrollGesture', [
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
    },
    log: { type: 'logcat', crash: /FATAL EXCEPTION|ANR in / },
    menu: phoneOnlyMenu,
    record: appiumRecording,
    appId: cachedAppId(
      async (d) =>
        launch.appPackage ??
        (d.capabilities['appPackage'] as string | undefined) ??
        String((await d.execute('mobile: getCurrentPackage')) ?? ''),
    ),
    longPress: async (d, el, ms) =>
      void (await d.execute('mobile: longClickGesture', [{ elementId: el, duration: ms }])),
    async swipe(d, direction, percent, el) {
      const area = el
        ? { elementId: el }
        : await (async () => {
            // The app window's size (pixels on Android).
            const { width: w, height: h } = await d.windowSize();
            return {
              left: Math.round(w * 0.1),
              top: Math.round(h * 0.2),
              width: Math.round(w * 0.8),
              height: Math.round(h * 0.6),
            };
          })();
      await d.execute('mobile: swipeGesture', [{ ...area, direction, percent }]);
    },
    async drag(d, from, to) {
      const r = await d.rect(to);
      await d.execute('mobile: dragGesture', [
        { elementId: from, endX: Math.round(r.x + r.width / 2), endY: Math.round(r.y + r.height / 2) },
      ]);
    },
    setLocation: async (d, latitude, longitude) =>
      void (await d.execute('mobile: setGeolocation', [{ latitude, longitude }])),
    async appState(d, action, seconds) {
      const appId = await this.appId(d);
      if (action === 'launch') await d.execute('mobile: activateApp', [{ appId }]);
      else if (action === 'close') await d.execute('mobile: terminateApp', [{ appId }]);
      else if (action === 'reset') await d.execute('mobile: clearApp', [{ appId }]);
      else await d.execute('mobile: backgroundApp', [{ seconds: seconds ?? -1 }]);
    },
    async permission(d, name, grant) {
      const permissions = PERMISSIONS[name.toLowerCase()]?.android ?? [name];
      await d.execute('mobile: changePermissions', [
        { permissions, appPackage: await this.appId(d), action: grant ? 'grant' : 'revoke' },
      ]);
    },
    async hideKeyboard(d) {
      if ((await d.execute('mobile: isKeyboardShown').catch(() => true)) === false) return;
      await d.execute('mobile: hideKeyboard');
    },
    async queryAppState(d) {
      const s = await d
        .execute('mobile: queryAppState', [{ appId: await this.appId(d) }])
        .catch(() => undefined);
      return typeof s === 'number' ? s : undefined;
    },
    dialog: async (d, accept, buttonLabel) =>
      void (await d.execute(accept ? 'mobile: acceptAlert' : 'mobile: dismissAlert', [
        { ...(buttonLabel && { buttonLabel }) },
      ])),
    async pushNotification() {
      throw new StepError(
        'unsupported',
        'Sending a notification needs the app’s own push service on Android; this step works on iOS simulators',
      );
    },
  };
}

/** The Appium capabilities for an environment's iOS launch settings (simulator by default). */
export function iosCapabilities(launch: IosLaunch): Record<string, unknown> {
  const caps: Record<string, unknown> = {
    platformName: 'iOS',
    'appium:automationName': 'XCUITest',
    'appium:noReset': launch.resetApp === false,
    'appium:fullReset': false,
    'appium:newCommandTimeout': 300,
    'appium:isHeadless': !launch.showSimulator,
    // The first test builds Appium's helper (WebDriverAgent) with Xcode: allow minutes.
    'appium:wdaLaunchTimeout': 600_000,
    'appium:wdaConnectionTimeout': 600_000,
    'appium:simulatorStartupTimeout': 300_000,
    'appium:shouldTerminateApp': true,
    // XCUITest waits for the app to be idle before every action, by default up to 10 s: on a slow machine with
    // animations that made every step take seconds. A short wait still lets a scroll settle before the next tap.
    'appium:waitForIdleTimeout': 1,
    'appium:animationCoolOffTimeout': 0,
    'appium:reduceMotion': true,
  };
  if (launch.app) {
    caps['appium:app'] = appFile(launch.app);
    // Install this exact build: Appium otherwise keeps an installed app with the same version number.
    if (launch.resetApp !== false) caps['appium:enforceAppInstall'] = true;
  }
  if (launch.bundleId) caps['appium:bundleId'] = launch.bundleId;
  if (!launch.app && !launch.bundleId)
    throw new StepError(
      'invalid_params',
      'Set the app (.app or .ipa) or the installed app’s bundle id in the environment',
    );
  if (launch.platformVersion) caps['appium:platformVersion'] = launch.platformVersion;
  if (launch.udid) caps['appium:udid'] = launch.udid;
  if (launch.simulator) caps['appium:deviceName'] = launch.simulator;
  else if (!launch.udid) {
    // No device named: the first iPhone simulator (a booted one if any).
    const sim = listSimulators().find((s) => s.name.startsWith('iPhone'));
    if (!sim)
      throw new StepError(
        'invalid_params',
        'No iPhone simulator found: add one in Xcode (Window → Devices and Simulators)',
      );
    caps['appium:udid'] = sim.udid;
    caps['appium:deviceName'] = sim.name;
  }
  caps['appium:deviceName'] ??= 'iPhone';
  return { ...caps, ...(launch.capabilities ?? {}) };
}

/** Text keys typed into the focused field on iOS (the keyboard has no key codes). */
const IOS_TEXT_KEYS: Record<string, string> = { Enter: '\n', Tab: '\t', Backspace: '\b', Space: ' ' };

export function iosPlatform(launch: IosLaunch): NativePlatform {
  return {
    name: 'iOS',
    kind: 'phone',
    driver: 'xcuitest',
    capabilities: () => iosCapabilities(launch),
    queries: iosQueries,
    // Switches report "1" / "0"; a selected button reports "true".
    isChecked: async (d, el) => ['1', 'true'].includes((await d.attribute(el, 'value')) ?? ''),
    async pressKey(d, key, el) {
      if (key === 'Home') return void (await d.execute('mobile: pressButton', [{ name: 'home' }]));
      if (key === 'Back')
        throw new StepError('invalid_params', 'iPhones have no Back key: tap the app’s own back button');
      const text = IOS_TEXT_KEYS[key];
      if (text === undefined)
        throw new StepError(
          'invalid_params',
          `The key "${key}" is not available on iOS (keys: ${[...Object.keys(IOS_TEXT_KEYS), 'Home'].join(', ')})`,
        );
      const target = el ?? (await d.activeElement());
      if (!target)
        throw new StepError('invalid_params', `Press ${key} needs a text field: set the step's element`);
      await d.sendKeys(target, text);
    },
    deepLink: async (d, url) =>
      void (await d.execute('mobile: deepLink', [
        { url, bundleId: (d.capabilities['appium:bundleId'] as string) ?? launch.bundleId },
      ])),
    doubleTap: async (d, el) => void (await d.execute('mobile: doubleTap', [{ elementId: el }])),
    async scroll(d, direction) {
      // A swipe up moves the content down.
      await d.execute('mobile: swipe', [{ direction: direction === 'down' ? 'up' : 'down' }]);
      return true;
    },
    log: { type: 'syslog', crash: /Terminating app due to uncaught exception|crashed/ },
    menu: phoneOnlyMenu,
    async record(d) {
      const udid = String(d.capabilities.udid ?? d.capabilities['appium:udid'] ?? '');
      const simulator = !!udid && listSimulators().some((s) => s.udid === udid);
      return (simulator && (await simulatorRecording(udid))) || appiumRecording(d);
    },
    appId: cachedAppId(
      async (d) =>
        launch.bundleId ??
        (d.capabilities['bundleId'] as string | undefined) ??
        String(((await d.execute('mobile: activeAppInfo')) as { bundleId?: string } | null)?.bundleId ?? ''),
    ),
    longPress: async (d, el, ms) =>
      void (await d.execute('mobile: touchAndHold', [{ elementId: el, duration: ms / 1000 }])),
    swipe: async (d, direction, _percent, el) =>
      void (await d.execute('mobile: swipe', [{ direction, ...(el && { elementId: el }) }])),
    async drag(d, from, to) {
      const [a, b] = await Promise.all([d.rect(from), d.rect(to)]);
      await d.execute('mobile: dragFromToForDuration', [
        {
          duration: 1,
          fromX: Math.round(a.x + a.width / 2),
          fromY: Math.round(a.y + a.height / 2),
          toX: Math.round(b.x + b.width / 2),
          toY: Math.round(b.y + b.height / 2),
        },
      ]);
    },
    setLocation: async (d, latitude, longitude) =>
      void (await d.execute('mobile: setSimulatedLocation', [{ latitude, longitude }])),
    async appState(d, action, seconds) {
      const bundleId = await this.appId(d);
      if (action === 'launch') await d.execute('mobile: activateApp', [{ bundleId }]);
      else if (action === 'close') await d.execute('mobile: terminateApp', [{ bundleId }]);
      else if (action === 'reset') await d.execute('mobile: clearApp', [{ bundleId }]);
      else await d.execute('mobile: backgroundApp', [{ seconds: seconds ?? -1 }]);
    },
    async permission(d, name, grant) {
      const service = PERMISSIONS[name.toLowerCase()]?.ios ?? name;
      if (!service)
        throw new StepError(
          'invalid_params',
          `On iOS the app itself asks for the ${name} permission: answer its dialog with the dialog step (Allow)`,
        );
      await d.execute('mobile: setPermission', [
        { bundleId: await this.appId(d), access: { [service]: grant ? 'yes' : 'no' } },
      ]);
    },
    async hideKeyboard(d) {
      if ((await d.execute('mobile: isKeyboardShown').catch(() => true)) === false) return;
      // iOS hides the keyboard through one of its keys.
      try {
        await d.execute('mobile: hideKeyboard', [{ keys: ['done', 'Done', 'return', 'Return'] }]);
      } catch {
        if ((await d.execute('mobile: isKeyboardShown').catch(() => true)) === false) return;
        throw new StepError(
          'unsupported',
          'This keyboard has no Done or Return key to hide it: tap outside the text field instead',
        );
      }
    },
    async queryAppState(d) {
      const s = await d
        .execute('mobile: queryAppState', [{ bundleId: await this.appId(d) }])
        .catch(() => undefined);
      return typeof s === 'number' ? s : undefined;
    },
    dialog: async (d, accept, buttonLabel) =>
      void (await d.execute('mobile: alert', [
        { action: accept ? 'accept' : 'dismiss', ...(buttonLabel && { buttonLabel }) },
      ])),
    async pushNotification(d, title, body) {
      try {
        await d.execute('mobile: pushNotification', [
          { bundleId: await this.appId(d), payload: { aps: { alert: { title, body }, sound: 'default' } } },
        ]);
      } catch (err) {
        if (/not authorized|failed to complete/i.test((err as Error).message))
          throw new StepError(
            'invalid_params',
            'The app may not show notifications: grant the notifications permission first (Permission step), on a simulator',
          );
        throw err;
      }
    },
  };
}

const phoneOnlyMenu = async (): Promise<void> => {
  throw new StepError(
    'unsupported',
    'Menu bars are for desktop apps; in a phone app tap the menu button instead',
  );
};

/** A step that only makes sense on a phone (or a simulator), explained on a desktop. */
const notOnDesktop = (what: string) => async (): Promise<never> => {
  throw new StepError(
    'unsupported',
    `${what} is for phone apps; desktop apps use the mouse, keyboard and menus`,
  );
};

/** W3C key values for the key names steps use; modifiers joined with "+" ("Control+S", "Meta+Shift+N"). */
const W3C_KEYS: Record<string, string> = {
  Enter: '\uE007',
  Return: '\uE007',
  Tab: '\uE004',
  Escape: '\uE00C',
  Backspace: '\uE003',
  Delete: '\uE017',
  Space: ' ',
  ArrowLeft: '\uE012',
  ArrowUp: '\uE013',
  ArrowRight: '\uE014',
  ArrowDown: '\uE015',
  Home: '\uE011',
  End: '\uE010',
  PageUp: '\uE00E',
  PageDown: '\uE00F',
  Shift: '\uE008',
  Control: '\uE009',
  Ctrl: '\uE009',
  Alt: '\uE00A',
  Option: '\uE00A',
  Meta: '\uE03D',
  Command: '\uE03D',
  Cmd: '\uE03D',
  ...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`F${i + 1}`, String.fromCharCode(0xe031 + i)])),
};

/** Presses a key or a shortcut ("Control+S") with W3C key actions: modifiers down, the key, modifiers up. */
export async function pressShortcut(d: WebDriverSession, combo: string): Promise<void> {
  const parts = combo
    .split('+')
    .map((k) => k.trim())
    .filter(Boolean);
  if (!parts.length) throw new StepError('invalid_params', 'Name a key, e.g. Enter or Control+S');
  const keys = parts.map((k) => {
    const v = W3C_KEYS[k] ?? W3C_KEYS[k[0]!.toUpperCase() + k.slice(1)] ?? (k.length === 1 ? k : undefined);
    if (v === undefined) throw new StepError('invalid_params', `Unknown key "${k}" in "${combo}"`);
    return v;
  });
  const down = keys.map((value) => ({ type: 'keyDown', value }));
  const up = [...keys].reverse().map((value) => ({ type: 'keyUp', value }));
  await d.actions([{ type: 'key', id: 'keyboard', actions: [...down, ...up] }]);
}

/** The Appium capabilities for an environment's macOS launch settings. */
export function macCapabilities(launch: MacLaunch): Record<string, unknown> {
  if (!launch.bundleId && !launch.appPath)
    throw new StepError('invalid_params', "Set the app's bundle id or its .app path in the environment");
  return {
    platformName: 'mac',
    'appium:automationName': 'Mac2',
    ...(launch.bundleId && { 'appium:bundleId': launch.bundleId }),
    ...(launch.appPath && { 'appium:appPath': appFile(launch.appPath) }),
    ...(launch.arguments?.length && { 'appium:arguments': launch.arguments }),
    ...(launch.environment &&
      Object.keys(launch.environment).length && { 'appium:environment': launch.environment }),
    'appium:newCommandTimeout': 300,
    // The first test builds Appium's helper (WebDriverAgentMac) with Xcode.
    'appium:serverStartupTimeout': 600_000,
    'appium:skipAppKill': false,
    ...(launch.capabilities ?? {}),
  };
}

export function macPlatform(launch: MacLaunch): NativePlatform {
  const app = () => (launch.bundleId ? { bundleId: launch.bundleId } : { path: appFile(launch.appPath!) });
  return {
    name: 'macOS',
    kind: 'desktop',
    driver: 'mac2',
    capabilities: () => macCapabilities(launch),
    queries: macQueries,
    isChecked: async (d, el) => ['1', 'true'].includes((await d.attribute(el, 'value')) ?? ''),
    async pressKey(d, key, el) {
      if (el) await d.click(el);
      await pressShortcut(d, key);
    },
    deepLink: async (d, url) =>
      void (await d.execute('macos: deepLink', [
        { url, ...(launch.bundleId && { bundleId: launch.bundleId }) },
      ])),
    doubleTap: async (d, el) => void (await d.execute('macos: doubleClick', [{ elementId: el }])),
    async scroll(d, direction) {
      await d.execute('macos: scroll', [
        { x: 400, y: 300, deltaX: 0, deltaY: direction === 'down' ? -200 : 200 },
      ]);
      return true;
    },
    log: { type: '', crash: /$^/ },
    async record(d) {
      try {
        await d.execute('macos: startNativeScreenRecording', [{ fps: 10 }]);
      } catch {
        return null;
      }
      return async () => {
        const b64 = await d.execute('macos: stopNativeScreenRecording', [{}], 120_000).catch(() => null);
        return typeof b64 === 'string' && b64 ? Buffer.from(b64, 'base64') : null;
      };
    },
    appId: async () => launch.bundleId ?? launch.appPath ?? '',
    longPress: async (d, el, ms) =>
      void (await d.execute('macos: press', [{ elementId: el, duration: ms / 1000 }])),
    swipe: async (d, direction, _percent, el) =>
      void (await d.execute('macos: swipe', [{ direction, ...(el && { elementId: el }) }])),
    async drag(d, from, to) {
      const [a, b] = await Promise.all([d.rect(from), d.rect(to)]);
      await d.execute('macos: clickAndDrag', [
        {
          startX: Math.round(a.x + a.width / 2),
          startY: Math.round(a.y + a.height / 2),
          endX: Math.round(b.x + b.width / 2),
          endY: Math.round(b.y + b.height / 2),
          duration: 1,
        },
      ]);
    },
    setLocation: notOnDesktop('Setting the location'),
    async appState(d, action) {
      if (action === 'launch') await d.execute('macos: activateApp', [app()]);
      else if (action === 'close') await d.execute('macos: terminateApp', [app()]);
      else
        throw new StepError('unsupported', `"${action}" is for phone apps; close and launch the app instead`);
    },
    permission: notOnDesktop('Granting permissions'),
    pushNotification: notOnDesktop('Sending notifications'),
    hideKeyboard: async () => {},
    dialog: async (d, accept, buttonLabel) => {
      // macOS dialogs (sheets, alerts) are ordinary elements: press their button. Sheets can report their frame
      // wrongly (several displays), so when a click leaves the dialog open, the keyboard answers it: Return presses
      // the default button, Escape the cancel button.
      const label = buttonLabel ?? (accept ? 'OK' : 'Cancel');
      const dialogs = () => d.findAll('-ios class chain', '**/XCUIElementTypeSheet');
      const byTitle = (t: string) =>
        d.findAll('-ios class chain', `**/XCUIElementTypeButton[\`title == ${predicateLiteral(t)}\`]`);
      let target = (await byTitle(label))[0];
      // No button named OK/Cancel: the dialog's default (first) button, or its cancel button.
      if (!target && !buttonLabel && (await dialogs()).length)
        target = (await d.findAll('accessibility id', accept ? 'action-button-1' : 'action-button-2'))[0];
      if (!target) throw new StepError('timeout', `no such alert: no "${label}" button`);
      const gone = async () => {
        for (let i = 0; i < 6; i++) {
          await new Promise((r) => setTimeout(r, 250));
          if (!(await dialogs()).length) return true;
        }
        return false;
      };
      const open = (await dialogs()).length > 0;
      await d.click(target).catch(() => undefined);
      if (!open || (await gone())) return;
      // Which button is the default one: the element tree says (the first button of an alert).
      const buttons = parseElements(await d.source()).filter((e) =>
        /^action-button-\d+$/.test(e.attrs.identifier ?? ''),
      );
      const titleOf = (id: string) => buttons.find((b) => b.attrs.identifier === id)?.attrs.title;
      const wanted = buttonLabel ?? (accept ? titleOf('action-button-1') : titleOf('action-button-2'));
      if (wanted !== undefined && wanted === titleOf('action-button-1')) await pressShortcut(d, 'Enter');
      else if ((wanted && /^cancel$/i.test(wanted)) || (!accept && !buttonLabel))
        await pressShortcut(d, 'Escape');
      else throw new StepError('unknown', `Pressing "${wanted ?? label}" did not close the dialog`);
      if (!(await gone())) throw new StepError('timeout', 'The dialog did not close');
    },
    async queryAppState(d) {
      const s = await d.execute('macos: queryAppState', [app()]).catch(() => undefined);
      return typeof s === 'number' ? s : undefined;
    },
    async menu(d, path) {
      for (const [i, title] of path.entries()) {
        const type = i === 0 ? 'XCUIElementTypeMenuBarItem' : 'XCUIElementTypeMenuItem';
        const els = await d.findAll(
          '-ios class chain',
          `**/${type}[\`title == ${predicateLiteral(title)}\`]`,
        );
        if (!els.length)
          throw new StepError(
            'element_not_found',
            `No menu ${i === 0 ? '' : 'item '}"${title}" (in ${path.join(' > ')})`,
          );
        await d.click(els[0]!);
      }
    },
  };
}

/** The Appium capabilities for an environment's Windows launch settings. */
export function windowsCapabilities(launch: WindowsLaunch): Record<string, unknown> {
  if (!launch.app)
    throw new StepError('invalid_params', "Set the app's .exe path or its app id in the environment");
  // A path is checked; an app id (AUMID, e.g. Microsoft.WindowsCalculator_8wekyb3d8bbwe!App) is passed as is.
  const isPath = /[\\/]|\.exe$/i.test(launch.app);
  return {
    platformName: 'Windows',
    'appium:automationName': 'NovaWindows',
    'appium:app': isPath ? appFile(launch.app) : launch.app,
    ...(launch.arguments && { 'appium:appArguments': launch.arguments }),
    ...(launch.workingDir && { 'appium:appWorkingDir': launch.workingDir }),
    'appium:newCommandTimeout': 300,
    'ms:waitForAppLaunch': 15,
    'appium:shouldCloseApp': true,
    ...(launch.capabilities ?? {}),
  };
}

export function windowsPlatform(launch: WindowsLaunch): NativePlatform {
  return {
    name: 'Windows',
    kind: 'desktop',
    driver: 'novawindows',
    capabilities: () => windowsCapabilities(launch),
    queries: windowsQueries,
    // UI Automation's toggle state: On / Off.
    isChecked: async (d, el) =>
      /^(on|1|true)$/i.test((await d.attribute(el, 'Toggle.ToggleState').catch(() => null)) ?? ''),
    async pressKey(d, key, el) {
      if (el) await d.click(el);
      await pressShortcut(d, key);
    },
    deepLink: notOnDesktop('Opening a deep link'),
    doubleTap: async (d, el) => {
      await d.click(el);
      await d.click(el);
    },
    async scroll(d, direction) {
      await d.execute('windows: scroll', [{ deltaY: direction === 'down' ? -360 : 360 }]);
      return true;
    },
    log: { type: '', crash: /$^/ },
    record: appiumRecording,
    appId: async () => launch.app ?? '',
    longPress: notOnDesktop('A long press'),
    swipe: notOnDesktop('A swipe'),
    async drag(d, from, to) {
      await d.execute('windows: clickAndDrag', [{ startElementId: from, endElementId: to }]);
    },
    setLocation: notOnDesktop('Setting the location'),
    async appState(d, action) {
      if (action === 'launch') await d.execute('windows: launchApp');
      else if (action === 'close') await d.execute('windows: closeApp');
      else
        throw new StepError('unsupported', `"${action}" is for phone apps; close and launch the app instead`);
    },
    permission: notOnDesktop('Granting permissions'),
    pushNotification: notOnDesktop('Sending notifications'),
    hideKeyboard: async () => {},
    dialog: async (d, accept, buttonLabel) => {
      const label = buttonLabel ?? (accept ? 'OK' : 'Cancel');
      const find = () => d.findAll('xpath', `//Window//Button[@Name=${xpathLiteral(label)}]`);
      if (!(await find()).length) throw new StepError('timeout', `no such alert: no "${label}" button`);
      await pressUntilGone(d, find);
    },
    queryAppState: async () => undefined,
    async menu(d, path) {
      for (const title of path) {
        const els = await d.findAll('xpath', `//MenuItem[@Name=${xpathLiteral(title)}]`);
        if (!els.length)
          throw new StepError('element_not_found', `No menu item "${title}" (in ${path.join(' > ')})`);
        await d.click(els[0]!);
      }
    },
  };
}

/**
 * Presses a dialog's button until the dialog has gone: a sheet that is still sliding in ignores the first press.
 */
async function pressUntilGone(d: WebDriverSession, find: () => Promise<ElementRef[]>): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const els = await find();
    if (!els.length) return;
    await d.click(els[0]!).catch(() => undefined);
    for (let i = 0; i < 8; i++) {
      await new Promise((r) => setTimeout(r, 250));
      if (!(await find()).length) return;
    }
  }
  throw new StepError('timeout', 'The dialog did not close after pressing its button');
}
