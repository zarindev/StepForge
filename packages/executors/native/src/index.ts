import type { Executor, TestContext } from '@stepforge/core';
import { NativeSession, type NativeSessionOptions } from './session.ts';

export * from './android.ts';
export * from './appium.ts';
export * from './doctor.ts';
export * from './ios.ts';
export * from './linux.ts';
export {
  androidQueries,
  iosQueries,
  linuxQueries,
  macQueries,
  predicateLiteral,
  windowsQueries,
  xpathLiteral,
} from './locators.ts';
export {
  androidCapabilities,
  iosCapabilities,
  linuxCapabilities,
  macCapabilities,
  windowsCapabilities,
} from './platforms.ts';
export { WebDriverSession, WebDriverError } from './webdriver.ts';

/** UI steps in a native app (Android, iOS, macOS, Windows, Linux), through a local Appium server or the Linux helper. */
export function createNativeExecutor(
  opts: {
    appiumUrl: () => Promise<string>;
  } & NativeSessionOptions,
): Executor {
  return {
    group: 'ui',
    async createSession(ctx: TestContext) {
      const session = new NativeSession(ctx, opts.appiumUrl, opts);
      await session.open();
      return session;
    },
  };
}
export {
  androidPlatform,
  iosPlatform,
  linuxPlatform,
  macPlatform,
  hasFfmpeg,
  pointerActions,
  pressShortcut,
  windowsPlatform,
  x11Recording,
  type Direction,
  type NativePlatform,
} from './platforms.ts';
export {
  elementAt,
  kindOf,
  locatorsFor,
  NativeRecordingSession,
  parseElements,
  type NativeRecordedStep,
  type NativeRecorderSnapshot,
  type ScreenElement,
} from './recorder.ts';
export { NativeManualSession, type ManualAction } from './manual.ts';
export { appWindows, desktopCrop, union, type AppView, type Area } from './view.ts';
