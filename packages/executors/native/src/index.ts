import type { Executor, TestContext } from '@stepforge/core';
import { NativeSession } from './session.ts';

export * from './android.ts';
export * from './appium.ts';
export * from './doctor.ts';
export * from './ios.ts';
export {
  androidQueries,
  iosQueries,
  macQueries,
  predicateLiteral,
  windowsQueries,
  xpathLiteral,
} from './locators.ts';
export { androidCapabilities, iosCapabilities, macCapabilities, windowsCapabilities } from './platforms.ts';
export { WebDriverSession, WebDriverError } from './webdriver.ts';

/** UI steps in a native app (Android, iOS, macOS, Windows), through a local Appium server. */
export function createNativeExecutor(opts: {
  appiumUrl: () => Promise<string>;
  /** Whether an Appium driver ("uiautomator2", "xcuitest") is installed; a missing one is explained up front. */
  hasDriver?: (driver: string) => boolean;
}): Executor {
  return {
    group: 'ui',
    async createSession(ctx: TestContext) {
      const session = new NativeSession(ctx, opts.appiumUrl, opts.hasDriver);
      await session.open();
      return session;
    },
  };
}
export {
  androidPlatform,
  iosPlatform,
  macPlatform,
  pressShortcut,
  windowsPlatform,
  type Direction,
  type NativePlatform,
} from './platforms.ts';
export {
  elementAt,
  locatorsFor,
  NativeRecordingSession,
  parseElements,
  type NativeRecordedStep,
  type NativeRecorderSnapshot,
  type ScreenElement,
} from './recorder.ts';
