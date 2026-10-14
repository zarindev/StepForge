import type { Executor, TestContext } from '@stepforge/core';
import { AndroidSession } from './session.ts';

export * from './android.ts';
export * from './appium.ts';
export * from './doctor.ts';
export { androidQueries, xpathLiteral } from './locators.ts';
export { androidCapabilities } from './session.ts';
export { WebDriverSession, WebDriverError } from './webdriver.ts';

/** UI steps in a native app (Android today), through a local Appium server. */
export function createNativeExecutor(opts: { appiumUrl: () => Promise<string> }): Executor {
  return {
    group: 'ui',
    async createSession(ctx: TestContext) {
      const session = new AndroidSession(ctx, opts.appiumUrl);
      await session.open();
      return session;
    },
  };
}
