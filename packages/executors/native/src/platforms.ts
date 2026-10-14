import { StepError, type AndroidLaunch, type IosLaunch, type Locator } from '@stepforge/core';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { listSimulators } from './ios.ts';
import { androidQueries, iosQueries, type Query } from './locators.ts';
import type { ElementRef, WebDriverSession } from './webdriver.ts';

/** What differs between Android and iOS for the same steps. */
export type NativePlatform = {
  name: 'Android' | 'iOS';
  /** The Appium driver this platform needs. */
  driver: 'uiautomator2' | 'xcuitest';
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
};

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
  if (launch.app) caps['appium:app'] = appFile(launch.app);
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
      const size = (await d.execute('mobile: deviceScreenInfo').catch(() => null)) as {
        realDisplaySize?: string;
      } | null;
      const [w, h] = (size?.realDisplaySize ?? '1080x2400').split('x').map(Number) as [number, number];
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
    record: appiumRecording,
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
  };
  if (launch.app) caps['appium:app'] = appFile(launch.app);
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
    async record(d) {
      const udid = String(d.capabilities.udid ?? d.capabilities['appium:udid'] ?? '');
      const simulator = !!udid && listSimulators().some((s) => s.udid === udid);
      return (simulator && (await simulatorRecording(udid))) || appiumRecording(d);
    },
  };
}
