// Browser steps for Cypress tests exported by StepForge (by Md Zarin Tasnim): faked routes, responses, storage,
// downloads, page conditions and the fixed clock. Each does what StepForge's own step does.
/* global cy, Cypress, beforeEach */
import {
  queryAllByLabelText,
  queryAllByPlaceholderText,
  queryAllByRole,
  queryAllByTestId,
  queryAllByText,
} from '@testing-library/dom';
import { jsonPath } from './helpers.js';

/**
 * A URL pattern as StepForge reads it: a glob with `*` (within a path segment) / `**` (anything; `**` then a slash
 * also matches no segment at all), else a part of the URL. A glob starting with `/` is a path (any host), and a query
 * string after the matched part is fine unless the glob itself has a `?`.
 */
export function urlMatcher(pattern) {
  const p = String(pattern).trim();
  if (p.includes('*')) {
    const glob = p.startsWith('/') ? `**${p}` : p;
    let re = '';
    for (let i = 0; i < glob.length;) {
      if (glob.startsWith('**/', i)) [re, i] = [re + '(?:.*/)?', i + 3];
      else if (glob.startsWith('**', i)) [re, i] = [re + '.*', i + 2];
      else if (glob[i] === '*') [re, i] = [re + '[^/]*', i + 1];
      else [re, i] = [re + glob[i].replace(/[.+?^${}()|[\]\\]/g, '\\$&'), i + 1];
    }
    const rx = new RegExp(`^${re}${glob.includes('?') ? '' : '(?:[?#].*)?'}$`);
    return (u) => rx.test(u);
  }
  return (u) => u.includes(p);
}

// ─── Responses and mocks ────────────────────────────────────────────────────

/** Every response the page received since the test started (mocked ones too), and the mocks in force. */
let responses = [];
let mocks = new Map();
let clock = null;
beforeEach(() => {
  responses = [];
  mocks = new Map();
  clock = null;
});

const record = (req, status, headers, body) => {
  let parsed = body;
  if (typeof body === 'string')
    try {
      parsed = JSON.parse(body);
    } catch {
      // not JSON: keep the text
    }
  const text = typeof body === 'string' ? body : JSON.stringify(body ?? '');
  responses.push({
    taken: false,
    method: req.method,
    url: req.url,
    res: { status, headers: headers ?? {}, body: parsed, text, ms: 0, size: text.length, url: req.url },
  });
};

/** Call at the start of the test: records every response, for "wait for response". */
export function watchNetwork() {
  cy.intercept({ url: /.*/ }, (req) => {
    req.on('response', (res) => record(req, res.statusCode, res.headers, res.body));
  });
}

/**
 * The first response since the test started to a matching URL (and method, status) that no earlier step took, else
 * the next one; yields it in the shape `pick` reads (status, headers, body, text, url).
 */
export function waitForResponse(o) {
  const match = urlMatcher(o.url);
  const deadline = Date.now() + (o.timeoutMs ?? 15000);
  const fits = (r) =>
    !r.taken &&
    match(r.url) &&
    (!o.method || r.method === o.method.toUpperCase()) &&
    (o.status === undefined || r.res.status === o.status);
  const attempt = () =>
    cy.wrap(null, { log: false }).then(() => {
      const found = responses.find(fits);
      if (found) {
        found.taken = true;
        return found.res;
      }
      if (Date.now() >= deadline)
        throw new Error(
          `No response from ${o.url}${o.method ? ` (${o.method})` : ''}${o.status !== undefined ? ` with status ${o.status}` : ''} within ${o.timeoutMs ?? 15000} ms`,
        );
      return cy.wait(100, { log: false }).then(attempt);
    });
  return attempt();
}

/**
 * Answers matching requests with a fixed response, an error or a delay until the test ends; `remove` lets them reach
 * the server again. A new mock for the same URL and method replaces the old one; requests of another method, or
 * beyond `times`, pass on (to an older mock, or the server).
 */
export function mockRoute(o) {
  const method = o.method ? o.method.toUpperCase() : undefined;
  const key = `${method ?? '*'} ${o.url}`;
  cy.then(() => {
    if (o.action === 'remove') {
      for (const [k, m] of [...mocks]) if (method ? k === key : m.pattern === o.url) mocks.delete(k);
      return;
    }
    const match = urlMatcher(o.url);
    const body =
      o.body === undefined || o.body === null
        ? ''
        : typeof o.body === 'string'
          ? o.body
          : JSON.stringify(o.body);
    const contentType = o.contentType ?? (/^\s*[[{]/.test(body) ? 'application/json' : 'text/plain');
    const mock = { pattern: o.url, used: 0 };
    mocks.set(key, mock);
    cy.intercept({ url: /.*/ }, (req) => {
      // Removed or replaced since; another method; used up: the request passes on.
      if (mocks.get(key) !== mock || !match(req.url) || (method && req.method !== method)) return;
      if (o.times !== undefined) {
        if (mock.used >= o.times) return;
        mock.used++;
      }
      const delay = o.delayMs ?? 0;
      if (o.action === 'abort') return req.destroy();
      if (o.action === 'delay') return req.on('response', (res) => res.setDelay(delay));
      record(req, o.status ?? 200, { 'content-type': contentType }, body);
      req.reply({ statusCode: o.status ?? 200, body, headers: { 'content-type': contentType }, delay });
    });
  });
}

// ─── Storage, downloads, clock ──────────────────────────────────────────────

/** Cookies, localStorage and sessionStorage: set, get, remove one, or clear. `get` yields { value, exists }. */
export function storage(o) {
  const none = { value: null, exists: false };
  if (o.kind === 'cookie') {
    if (o.action === 'set') return cy.setCookie(o.name, o.value ?? '').then(() => none);
    if (o.action === 'remove') return cy.clearCookie(o.name).then(() => none);
    if (o.action === 'clear') return cy.clearCookies().then(() => none);
    return cy.getCookie(o.name).then((c) => ({ value: c ? c.value : null, exists: !!c }));
  }
  return cy.window({ log: false }).then((win) => {
    const store = o.kind === 'session' ? win.sessionStorage : win.localStorage;
    if (o.action === 'set') store.setItem(o.name, o.value ?? '');
    else if (o.action === 'remove') store.removeItem(o.name);
    else if (o.action === 'clear') store.clear();
    else {
      const value = store.getItem(o.name);
      return { value, exists: value !== null };
    }
    return none;
  });
}

/**
 * Clicks the element (`element`: a function giving it) and yields the file it downloads (fileName, size, path, content up to 5 MB), read from
 * Cypress's downloads folder by a Node task.
 */
export function download(element) {
  return cy.task('downloads:list', null, { log: false }).then((before) => {
    element().click();
    return cy.task('downloads:wait', { before, timeoutMs: 30000 }, { timeout: 35000 });
  });
}

/** Fixes the page's Date at `time` while its timers keep running (StepForge's "set the clock"). */
export function fixClock(time) {
  cy.then(() => {
    if (clock) clock.setSystemTime(time);
    else cy.clock(time, ['Date']).then((c) => (clock = c));
  });
}

/** A clock time as StepForge reads it: epoch milliseconds (a number or digits) or a date text. */
export function clockTime(value) {
  const d = new Date(
    typeof value === 'string' && value.trim() !== '' && !isNaN(Number(value)) ? Number(value) : value,
  );
  if (isNaN(d.getTime())) throw new Error(`Not a date: ${String(value)}`);
  return d;
}

// ─── Page conditions ────────────────────────────────────────────────────────

/** Element queries with the same meaning as the test's Testing Library locators (no waiting: they may find none). */
export const byTestId = (id) => (doc) => queryAllByTestId(doc.body, id);
export const byRole = (role, name) => (doc) =>
  queryAllByRole(doc.body, role, name === undefined ? {} : { name });
export const byLabelText = (text) => (doc) => queryAllByLabelText(doc.body, text);
export const byPlaceholderText = (text) => (doc) => queryAllByPlaceholderText(doc.body, text);
export const byText = (text) => (doc) => queryAllByText(doc.body, text);
export const byCss = (selector) => (doc) => [...doc.querySelectorAll(selector)];
export const byXPath = (xpath) => (doc) => {
  const r = doc.evaluate(xpath, doc, null, 7 /* ORDERED_NODE_SNAPSHOT_TYPE */, null);
  return Array.from({ length: r.snapshotLength }, (_, i) => r.snapshotItem(i));
};

/**
 * A page condition (if / repeat while): tried every 100 ms for up to `timeoutMs` before it counts as false; yields
 * true or false and never fails the test by itself.
 */
export function pageCondition(query, check, expected, timeoutMs = 2000) {
  const want = expected === undefined || expected === null ? '' : String(expected);
  const deadline = Date.now() + Math.max(0, timeoutMs);
  const holds = (els) => {
    const first = els[0];
    const visible = !!first && Cypress.dom.isVisible(first);
    switch (check) {
      case 'present':
        return els.length > 0;
      case 'absent':
        return els.length === 0;
      case 'visible':
        return visible;
      case 'hidden':
        return !visible;
      case 'enabled':
        return !!first && !first.matches(':disabled');
      case 'textContains':
        return !!first && (first.textContent ?? '').includes(want);
      case 'count':
        return els.length === Number(want);
      default:
        return false;
    }
  };
  const attempt = () =>
    cy.document({ log: false }).then((doc) => {
      let ok = false;
      try {
        ok = holds(query(doc));
      } catch {
        // not ready yet
      }
      if (ok || Date.now() >= deadline) return ok;
      return cy.wait(100, { log: false }).then(attempt);
    });
  return attempt();
}

/** Reads an assertion target from a Kafka message: key, value, `$…` (in the value), header:<name>, partition, offset. */
export function pickMessage(m, target) {
  if (target.startsWith('$')) return jsonPath(m.value ?? null, target);
  if (target.startsWith('header:')) return m.headers?.[target.slice(7)];
  return m[target];
}
