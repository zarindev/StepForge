import type { Executor, RunOptions, TestContext } from '@stepforge/core';
import { chromium, firefox, webkit, type Browser } from 'playwright';
import { UiSession } from './session.ts';

export { buildLocator, describeLocator, resolveLocator } from './locators.ts';

/** One browser process per (type, headed) for a whole run; each test case gets a fresh context. */
export class BrowserPool {
  private browsers = new Map<string, Promise<Browser>>();
  private versions = new Map<string, string>();

  /** Version of a browser this pool launched (for bug reports), e.g. "chromium 141.0.7390.37". */
  versionOf(browser: string): string | undefined {
    return this.versions.get(browser);
  }

  get(options: Pick<RunOptions, 'browser' | 'headed'>): Promise<Browser> {
    const key = `${options.browser}:${options.headed}`;
    let b = this.browsers.get(key);
    if (!b) {
      const type = { chromium, firefox, webkit }[options.browser];
      b = type.launch({ headless: !options.headed });
      void b
        .then((x) => this.versions.set(options.browser, `${options.browser} ${x.version()}`))
        .catch(() => undefined);
      this.browsers.set(key, b);
      b.catch(() => this.browsers.delete(key));
    }
    return b;
  }

  async closeAll(): Promise<void> {
    const all = [...this.browsers.values()];
    this.browsers.clear();
    await Promise.all(all.map(async (b) => (await b.catch(() => null))?.close().catch(() => {})));
  }
}

export function createUiExecutor(pool: BrowserPool): Executor {
  return {
    group: 'ui',
    async createSession(ctx: TestContext) {
      const browser = await pool.get(ctx.options);
      const session = new UiSession(browser, ctx);
      await session.open();
      return session;
    },
  };
}
