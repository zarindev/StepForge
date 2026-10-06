// Tab handling for tests exported by StepForge (by Md Zarin Tasnim).
import type { BrowserContext, Page } from '@playwright/test';

/** Waits for the tab to exist (it may still be opening), brings it to the front and returns it. */
export async function switchTab(
  context: BrowserContext,
  o: { index?: number; urlContains?: string } = {},
): Promise<Page> {
  const deadline = Date.now() + 10_000;
  const before = context.pages().length;
  for (;;) {
    const pages = context.pages();
    const found =
      o.index !== undefined
        ? pages[o.index]
        : o.urlContains !== undefined
          ? pages.find((p) => p.url().includes(o.urlContains!))
          : pages.length > 1 || Date.now() > deadline - 9_000
            ? pages.at(-1)
            : undefined;
    if (found) {
      await found.bringToFront();
      await found.waitForLoadState();
      return found;
    }
    if (Date.now() > deadline) throw new Error(`No tab matching ${JSON.stringify(o)} (open tabs: ${before})`);
    await new Promise((r) => setTimeout(r, 100));
  }
}
