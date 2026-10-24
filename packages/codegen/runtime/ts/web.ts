// Browser steps for tests exported by StepForge (by Md Zarin Tasnim): network, downloads, storage, page conditions.
// Each does what StepForge's own step does, so a test behaves the same here and there.
import type { BrowserContext, Locator, Page, Response, Route } from '@playwright/test';
import { readFileSync, statSync } from 'node:fs';
import type { ApiLike } from './helpers';

/**
 * A URL pattern as StepForge reads it: a glob with `*` (within a path segment) / `**` (anything; `**` then a slash
 * also matches no segment at all), else a part of the URL. A glob starting with `/` is a path (any host), and a query
 * string after the matched part is fine unless the glob itself has a `?`.
 */
export function urlMatcher(pattern: string): (url: string) => boolean {
  const p = pattern.trim();
  if (p.includes('*')) {
    const glob = p.startsWith('/') ? `**${p}` : p;
    let re = '';
    for (let i = 0; i < glob.length;) {
      if (glob.startsWith('**/', i)) [re, i] = [re + '(?:.*/)?', i + 3];
      else if (glob.startsWith('**', i)) [re, i] = [re + '.*', i + 2];
      else if (glob[i] === '*') [re, i] = [re + '[^/]*', i + 1];
      else [re, i] = [re + glob[i]!.replace(/[.+?^${}()|[\]\\]/g, '\\$&'), i + 1];
    }
    const rx = new RegExp(`^${re}${glob.includes('?') ? '' : '(?:[?#].*)?'}$`);
    return (u) => rx.test(u);
  }
  return (u) => u.includes(p);
}

// ─── Mocks ──────────────────────────────────────────────────────────────────

type Mock = { pattern: string; matcher: (u: URL) => boolean; handler: (route: Route) => Promise<void> };
const mocksOf = new WeakMap<BrowserContext, Map<string, Mock>>();

export type MockOptions = {
  url: string;
  action?: 'fulfill' | 'abort' | 'delay' | 'remove';
  method?: string;
  status?: number;
  /** Text as it is; any other value is sent as JSON. */
  body?: unknown;
  contentType?: string;
  delayMs?: number;
  /** Only this many matching requests (then they reach the server again). */
  times?: number;
};

/**
 * Answers matching requests with a fixed response, an error or a delay until the test ends; `remove` lets them reach
 * the server again. A new mock for the same URL and method replaces the old one.
 */
export async function mockRoute(context: BrowserContext, o: MockOptions): Promise<void> {
  const mocks = mocksOf.get(context) ?? new Map<string, Mock>();
  mocksOf.set(context, mocks);
  const method = o.method?.toUpperCase();
  const key = `${method ?? '*'} ${o.url}`;
  const drop = async (k: string) => {
    const old = mocks.get(k);
    if (!old) return;
    mocks.delete(k);
    await context.unroute(old.matcher, old.handler).catch(() => {});
  };
  if (o.action === 'remove') {
    // Without a method, every mock of that URL goes.
    const keys = method ? [key] : [...mocks].filter(([, m]) => m.pattern === o.url).map(([k]) => k);
    for (const k of keys) await drop(k);
    return;
  }
  await drop(key);
  const match = urlMatcher(o.url);
  const matcher = (u: URL) => match(u.toString());
  const body =
    o.body === undefined || o.body === null
      ? ''
      : typeof o.body === 'string'
        ? o.body
        : JSON.stringify(o.body);
  const contentType = o.contentType ?? (/^\s*[[{]/.test(body) ? 'application/json' : 'text/plain');
  let used = 0;
  const handler = async (route: Route) => {
    // Requests of another method fall through and do not use up the count.
    if (method && route.request().method() !== method) return route.fallback();
    if (o.times !== undefined) {
      if (used >= o.times) return route.fallback();
      if (++used >= o.times && mocks.get(key)?.handler === handler) void drop(key);
    }
    if ((o.delayMs ?? 0) > 0) await new Promise((r) => setTimeout(r, o.delayMs));
    if (o.action === 'abort') return route.abort('failed');
    if (o.action === 'delay') return route.fallback();
    return route.fulfill({ status: o.status ?? 200, body, contentType });
  };
  await context.route(matcher, handler);
  mocks.set(key, { pattern: o.url, matcher, handler });
}

// ─── Responses and traffic ──────────────────────────────────────────────────

type Entry = { url: string; type: string; status?: number; bytes: number; failed: boolean; mark: number };

/** The page traffic as StepForge's network summary reports it. */
export type Traffic = {
  requests: number;
  bytes: number;
  kb: number;
  failed: number;
  thirdPartyRequests: number;
  thirdPartyHosts: number;
  hosts: string[];
  thirdPartyHostNames: string[];
  /** Per resource type (script, image, fetch, document…): requests and bytes. */
  byType: Record<string, { requests: number; bytes: number }>;
};

const SECOND_LEVEL = new Set(
  'co com org net ac gov edu ne or ltd plc sch nhs go gob mil nic gv gen biz info nom ind res'.split(' '),
);
/** cdn.example.com belongs to example.com, www.example.co.uk to example.co.uk, app.localhost to localhost. */
function site(host: string): string {
  const h = host.replace(/:\d+$/, '').toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost')) return 'localhost';
  if (/^[\d.]+$/.test(h) || h.startsWith('[') || !h.includes('.')) return h;
  const parts = h.split('.');
  const twoLevel = parts.length > 2 && parts.at(-1)!.length === 2 && SECOND_LEVEL.has(parts.at(-2)!);
  return parts.slice(twoLevel ? -3 : -2).join('.');
}
const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
};

/**
 * Records the responses and the traffic of every page of the context from the start of the test, for "wait for
 * response" (the first matching response no earlier step took) and the network summary.
 */
export function watchNetwork(context: BrowserContext, baseUrl: string) {
  const responses: { response: Response; taken: boolean }[] = [];
  const entries: Entry[] = [];
  const pending = new Set<Promise<void>>();
  let mark = 0;
  context.on('response', (response) => void responses.push({ response, taken: false }));
  context.on('requestfinished', (request) => {
    const done = (async () => {
      const res = await request.response().catch(() => null);
      const sizes = await request.sizes().catch(() => null);
      entries.push({
        url: request.url(),
        type: request.resourceType(),
        status: res?.status(),
        bytes: sizes ? sizes.responseBodySize + sizes.responseHeadersSize : 0,
        failed: (res?.status() ?? 0) >= 400,
        mark,
      });
    })();
    pending.add(done);
    void done.finally(() => pending.delete(done));
  });
  context.on(
    'requestfailed',
    (request) =>
      void entries.push({ url: request.url(), type: request.resourceType(), bytes: 0, failed: true, mark }),
  );

  return {
    /** Call before opening a page: the summary "since the last navigation" starts here. */
    navigated() {
      mark++;
    },

    /** The first matching response since the test started that no earlier step took, else the next one. */
    async waitForResponse(o: {
      url: string;
      method?: string;
      status?: number;
      timeoutMs?: number;
    }): Promise<ApiLike & { url: string }> {
      const match = urlMatcher(o.url);
      const fits = (r: Response) =>
        match(r.url()) &&
        (!o.method || r.request().method() === o.method.toUpperCase()) &&
        (o.status === undefined || r.status() === o.status);
      const deadline = Date.now() + (o.timeoutMs ?? 15_000);
      let found: (typeof responses)[number] | undefined;
      while (!(found = responses.find((x) => !x.taken && fits(x.response)))) {
        if (Date.now() >= deadline)
          throw new Error(
            `No response from ${o.url}${o.method ? ` (${o.method})` : ''}${o.status !== undefined ? ` with status ${o.status}` : ''} within ${o.timeoutMs ?? 15_000} ms`,
          );
        await new Promise((r) => setTimeout(r, 100));
      }
      found.taken = true;
      const r = found.response;
      const text = await r.text().catch(() => '');
      let body: unknown = text;
      try {
        body = JSON.parse(text);
      } catch {
        // not JSON: keep the text
      }
      const t = r.request().timing();
      return {
        status: r.status(),
        headers: await r.allHeaders().catch(() => ({})),
        body,
        text,
        ms: t.responseEnd > 0 ? Math.round(t.responseEnd) : 0,
        size: text.length,
        url: r.url(),
      };
    },

    /** The traffic since the test started (or since the last navigation), once the page is quiet. */
    async summary(page: Page, since: 'test' | 'lastNavigation' = 'test'): Promise<Traffic> {
      await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
      await Promise.all([...pending]);
      const list = entries.filter((e) => /^https?:/.test(e.url) && (since === 'test' || e.mark === mark));
      const own = site(hostOf(baseUrl) || hostOf(list[0]?.url ?? ''));
      const hosts = [...new Set(list.map((e) => hostOf(e.url)))];
      const third = hosts.filter((h) => own && site(h) !== own);
      const byType: Traffic['byType'] = {};
      for (const e of list) {
        const g = (byType[e.type] ??= { requests: 0, bytes: 0 });
        g.requests++;
        g.bytes += e.bytes;
      }
      const bytes = list.reduce((n, e) => n + e.bytes, 0);
      return {
        requests: list.length,
        bytes,
        kb: Math.round(bytes / 100) / 10,
        failed: list.filter((e) => e.failed).length,
        thirdPartyRequests: list.filter((e) => third.includes(hostOf(e.url))).length,
        thirdPartyHosts: third.length,
        hosts,
        thirdPartyHostNames: third,
        byType,
      };
    },
  };
}

// ─── Downloads, storage, page conditions, clock ─────────────────────────────

export type Download = { fileName: string; size: number; path: string };

/** Clicks the element and keeps the file it downloads (in the test's output folder). */
export async function download(page: Page, element: Locator, folder: string): Promise<Download> {
  const [file] = await Promise.all([page.waitForEvent('download'), element.click()]);
  const fileName = file.suggestedFilename();
  const path = `${folder}/${fileName.replace(/[^\w.-]+/g, '_')}`;
  await file.saveAs(path);
  const failure = await file.failure();
  if (failure) throw new Error(`The download failed: ${failure}`);
  return { fileName, size: statSync(path).size, path };
}

/** A downloaded file's text (up to 5 MB, as StepForge reads it). */
export const fileText = (file: Download) => (file.size <= 5_000_000 ? readFileSync(file.path, 'utf8') : '');

/** Cookies, localStorage and sessionStorage: set, get, remove one, or clear. `get` gives the value (or null). */
export async function storage(
  page: Page,
  o: {
    kind: 'cookie' | 'local' | 'session';
    action: 'get' | 'set' | 'remove' | 'clear';
    name?: string;
    value?: string;
  },
): Promise<{ value: string | null; exists: boolean }> {
  const context = page.context();
  const name = o.name ?? '';
  if (o.kind === 'cookie') {
    if (o.action === 'set') {
      const url = /^https?:/.test(page.url()) ? page.url() : undefined;
      if (!url) throw new Error('Open a page before setting a cookie');
      await context.addCookies([{ name, value: o.value ?? '', url }]);
    } else if (o.action === 'clear') await context.clearCookies();
    else if (o.action === 'remove') await context.clearCookies({ name });
    else {
      const c = (await context.cookies()).find((x) => x.name === name);
      return { value: c?.value ?? null, exists: !!c };
    }
    return { value: null, exists: false };
  }
  const area = o.kind === 'session' ? 'sessionStorage' : 'localStorage';
  // about:blank has no origin: the browser would throw a SecurityError nobody understands.
  if (!/^https?:/.test(page.url())) throw new Error(`Open a page before using ${area}`);
  type Store = {
    setItem(k: string, v: string): void;
    getItem(k: string): string | null;
    removeItem(k: string): void;
    clear(): void;
  };
  const value = await page.evaluate(
    ([a, act, k, v]) => {
      const store = (globalThis as unknown as Record<string, Store>)[a]!;
      if (act === 'set') store.setItem(k, v);
      else if (act === 'remove') store.removeItem(k);
      else if (act === 'clear') store.clear();
      else return store.getItem(k);
      return null;
    },
    [area, o.action, name, o.value ?? ''] as const,
  );
  return { value, exists: value !== null };
}

/**
 * A page condition (if / repeat while): tried every 100 ms for up to `timeoutMs` before it counts as false. It
 * never fails the test by itself.
 */
export async function pageCondition(
  element: Locator,
  check: 'visible' | 'hidden' | 'present' | 'absent' | 'enabled' | 'textContains' | 'count',
  expected?: unknown,
  timeoutMs = 2000,
): Promise<boolean> {
  const want = expected === undefined || expected === null ? '' : String(expected);
  const holds = async () => {
    const n = await element.count();
    const first = element.first();
    switch (check) {
      case 'present':
        return n > 0;
      case 'absent':
        return n === 0;
      case 'visible':
        return n > 0 && (await first.isVisible());
      case 'hidden':
        return !(n > 0 && (await first.isVisible()));
      case 'enabled':
        return n > 0 && (await first.isEnabled());
      case 'textContains':
        return n > 0 && ((await first.textContent()) ?? '').includes(want);
      case 'count':
        return n === Number(want);
    }
  };
  const deadline = Date.now() + Math.max(0, timeoutMs);
  for (;;) {
    const ok = await holds().catch(() => false);
    if (ok || Date.now() >= deadline) return ok;
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** A clock time as StepForge reads it: epoch milliseconds (a number or digits) or a date text. */
export function clockTime(value: unknown): Date {
  const d = new Date(
    typeof value === 'string' && value.trim() !== '' && !isNaN(Number(value))
      ? Number(value)
      : (value as string),
  );
  if (isNaN(d.getTime())) throw new Error(`Not a date: ${String(value)}`);
  return d;
}
