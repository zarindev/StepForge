import { fileURLToPath } from 'node:url';
import { DEFAULT_RUN_OPTIONS, newId, runTestCase, type StepInput } from '@stepforge/core';
import { utilExecutor } from '@stepforge/executor-util';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BrowserPool, createUiExecutor } from '../src/index.ts';
import { baselineKey, urlMatcher } from '../src/visual.ts';

const html = readFileSync(new URL('./fixture.html', import.meta.url), 'utf8');
let server: Server;
let baseUrl = '';
const pool = new BrowserPool();

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === '/api/login') return res.writeHead(500).end('{"error":"db down"}');
    if (req.url === '/covered.html')
      return res
        .writeHead(200, { 'content-type': 'text/html' })
        .end(
          '<button data-testid="go">Go</button><div class="sheet" style="position:fixed;inset:0;z-index:9">Rate us</div>',
        );
    if (req.url === '/secure.html') {
      // HTTP basic auth (user ana / pw s3cret), and the extra header echoed back.
      if (req.headers.authorization !== `Basic ${Buffer.from('ana:s3cret').toString('base64')}`)
        return res.writeHead(401, { 'www-authenticate': 'Basic realm="x"' }).end('no');
      return res.writeHead(200, { 'content-type': 'text/html' }).end(
        `<p id="h">${String(req.headers['x-feature'] ?? '')}</p><p id="env"></p><p id="geo"></p>
<script>document.getElementById('env').textContent = [navigator.language, Intl.DateTimeFormat().resolvedOptions().timeZone, matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'].join(' ');
navigator.geolocation.getCurrentPosition(p => document.getElementById('geo').textContent = p.coords.latitude + ',' + p.coords.longitude)</script>`,
      );
    }
    if (req.url === '/app.js')
      return res
        .writeHead(200, { 'content-type': 'text/javascript' })
        .end('window.loaded = true;'.repeat(50));
    if (req.url === '/pixel.png')
      return res
        .writeHead(200, { 'content-type': 'image/png' })
        .end(
          Buffer.from(
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
            'base64',
          ),
        );
    if (req.url === '/net.html') {
      // A script, an image from another host (localhost vs 127.0.0.1: a "third party"), and a request that fails (500).
      const port = (server.address() as { port: number }).port;
      return res
        .writeHead(200, { 'content-type': 'text/html' })
        .end(
          `<script src="/app.js"></script><img src="http://localhost:${port}/pixel.png"><script>fetch('/api/login')</script>`,
        );
    }
    if (req.url === '/report.csv')
      return res
        .writeHead(200, {
          'content-type': 'text/csv',
          'content-disposition': 'attachment; filename="report.csv"',
        })
        .end('id,name\n1,Ana\n');
    if (req.url?.startsWith('/api/items'))
      return res.writeHead(200, { 'content-type': 'application/json' }).end('{"items":[{"id":7}],"total":1}');
    if (req.url === '/web.html')
      return res.writeHead(200, { 'content-type': 'text/html' }).end(
        `<title>Web</title><a href="/report.csv" download>Export</a>
<button id="load" onclick="fetch('/api/items?page=1').then(r => r.json()).then(j => document.getElementById('out').textContent = 'total ' + j.total).catch(() => document.getElementById('out').textContent = 'offline')">Load</button>
<p id="out"></p><p id="now"></p><button id="time" onclick="document.getElementById('now').textContent = new Date().toISOString().slice(0, 10)">Today</button>
<canvas id="c" width="200" height="100" style="background:#eee" onclick="document.getElementById('out').textContent = 'canvas ' + event.offsetX + ',' + event.offsetY"></canvas>
<div id="box" style="width:120px;height:60px;background:rgb(30,120,200)"></div>
<p id="ua"></p><script>document.getElementById('ua').textContent = (navigator.userAgent.includes('Mobile') ? 'mobile' : 'desktop') + ('ontouchstart' in window ? ' touch' : '')</script>`,
      );
    if (req.url === '/more.html')
      // "Load more" adds an item and disappears once there are 3.
      return res
        .writeHead(200, { 'content-type': 'text/html' })
        .end(
          `<ul id="list"></ul><button id="more" onclick="const l = document.getElementById('list'); l.insertAdjacentHTML('beforeend', '<li>Item ' + (l.children.length + 1) + '</li>'); if (l.children.length === 3) this.remove();">Load more</button>`,
        );
    if (req.url?.startsWith('/api/orders'))
      return res.writeHead(200, { 'content-type': 'application/json' }).end('{"from":"server"}');
    if (req.url === '/mock.html') {
      const send = (id: string, init: string) =>
        `<button id="${id}" onclick="fetch('/api/orders?page=1'${init}).then(r => r.text()).then(t => out.textContent = '${id} ' + t).catch(() => out.textContent = 'offline')">${id}</button>`;
      return res
        .writeHead(200, { 'content-type': 'text/html' })
        .end(`${send('get', '')}${send('post', ", { method: 'POST' }")}<p id="out"></p>`);
    }
    if (req.url === '/other.html')
      return res.writeHead(200, { 'content-type': 'text/html' }).end('<title>Help</title><h1>Help page</h1>');
    res.writeHead(200, { 'content-type': 'text/html' }).end(html);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => {
  await pool.closeAll();
  server.close();
});

const steps = (...s: StepInput[]) =>
  s.map((x) => ({
    enabled: true,
    continueOnFail: false,
    retries: 0,
    params: {},
    locators: [],
    assertions: [],
    id: newId(),
    ...x,
  }));
const run = (s: ReturnType<typeof steps>, opts: Partial<typeof DEFAULT_RUN_OPTIONS> = {}) => {
  const artifactsDir = mkdtempSync(join(tmpdir(), 'sf-ui-'));
  return runTestCase({
    runId: 'R',
    steps: s,
    data: { email: 'ana@clinic.test' },
    env: { baseUrl },
    executors: [createUiExecutor(pool), utilExecutor],
    options: {
      ...DEFAULT_RUN_OPTIONS,
      // Generous: a cold browser start on a busy Windows CI runner can take several seconds.
      defaultTimeoutMs: 8000,
      video: 'off',
      trace: 'off',
      screenshots: 'off',
      baseUrl,
      ...opts,
    },
    artifactsDir,
  }).then((r) => ({ ...r, artifactsDir }));
};

describe('URL patterns and baseline keys', () => {
  it('a glob starting with / is a path on any host; **/ also matches no segment; a query string is fine', () => {
    const m = (pattern: string, url: string) => urlMatcher(pattern)(url);
    expect(m('/api/orders*', 'http://h:3000/api/orders?page=1')).toBe(true);
    expect(m('/api/*', 'https://shop.test/api/cart')).toBe(true);
    expect(m('/api/*', 'https://shop.test/web/cart')).toBe(false);
    expect(m('**/a/**/b', 'http://h/a/b')).toBe(true);
    expect(m('**/a/**/b', 'http://h/a/x/y/b')).toBe(true);
    expect(m('**/api/items', 'http://h/api/items?page=2')).toBe(true);
    expect(m('**/api/items', 'http://h/api/items/7')).toBe(false);
    expect(m('**/api/items?page=*', 'http://h/api/items?page=2')).toBe(true);
    expect(m('/api/items', 'http://h/v1/api/items?x')).toBe(true);
  });

  it('long step ids keep a readable start and a hash of the whole id, so similar ids never share a baseline', () => {
    const key = (id: string) => baselineKey({ stepId: id, browser: 'chromium', width: 1280, height: 720 });
    const long = 'step-'.repeat(40);
    expect(key(`${long}a`)).not.toBe(key(`${long}b`));
    expect(key(`${long}a`).length).toBeLessThan(120);
    expect(key(`${long}a`)).toMatch(/^step-step-/);
    expect(key('home')).toBe('home-chromium-1280x720.png');
  });
});

describe('UI executor', () => {
  // The first test also starts the browser, which can be slow on a busy Windows runner.
  it(
    'logs in with label/testId/role locators, select, check and waits for async text',
    { timeout: 60_000 },
    async () => {
      const r = await run(
        steps(
          {
            type: 'ui.navigate',
            params: { url: '/' },
            assertions: [{ target: 'title', operator: 'equals', expected: 'Fixture Login' }],
          },
          {
            type: 'ui.fill',
            params: { value: '{{data.email}}' },
            locators: [{ strategy: 'label', value: 'Email' }],
          },
          {
            type: 'ui.fill',
            params: { value: 'secret' },
            locators: [{ strategy: 'label', value: 'Password' }],
          },
          { type: 'ui.check', locators: [{ strategy: 'label', value: 'Remember me' }] },
          {
            type: 'ui.select',
            params: { label: 'Doctor' },
            locators: [{ strategy: 'role', value: 'combobox', name: 'Role' }],
          },
          { type: 'ui.click', locators: [{ strategy: 'testId', value: 'login-btn' }] },
          {
            type: 'ui.assert',
            params: { check: 'textContains', expected: 'Welcome ana@clinic.test (doctor)' },
            locators: [{ strategy: 'role', value: 'status' }],
          },
          {
            type: 'ui.extract',
            params: { from: 'text', regex: 'Welcome (\\S+)' },
            locators: [{ strategy: 'css', value: '#msg' }],
            captureAs: 'who',
          },
        ),
      );
      expect(
        r.steps.map(
          (s) => `${s.type}:${s.status}${s.message && s.status !== 'passed' ? ` ${s.message}` : ''}`,
        ),
      ).toEqual(r.steps.map((s) => `${s.type}:passed`));
      expect(r.vars.who).toBe('ana@clinic.test');
    },
  );

  it('heals a broken primary locator with the next strategy', async () => {
    const r = await run(
      steps(
        { type: 'ui.navigate', params: { url: '/' } },
        {
          type: 'ui.click',
          locators: [
            { strategy: 'testId', value: 'old-login-button' },
            { strategy: 'role', value: 'button', name: 'Sign in' },
          ],
        },
      ),
    );
    expect(r.status).toBe('passed');
    expect(r.steps[1]!.healedLocator).toEqual({
      from: { strategy: 'testId', value: 'old-login-button' },
      to: { strategy: 'role', value: 'button', name: 'Sign in' },
    });
  });

  it('handles dialogs, new tabs and iframes', async () => {
    const r = await run(
      steps(
        { type: 'ui.navigate', params: { url: '/' } },
        { type: 'ui.handleDialog', params: { action: 'accept' } },
        { type: 'ui.click', locators: [{ strategy: 'text', value: 'Delete record' }] },
        {
          type: 'ui.assert',
          params: { check: 'text', expected: 'Deleted' },
          locators: [{ strategy: 'css', value: '#msg' }],
        },
        { type: 'ui.click', locators: [{ strategy: 'text', value: 'Delete record' }] },
        {
          type: 'ui.assert',
          params: { check: 'text', expected: 'Kept' },
          locators: [{ strategy: 'css', value: '#msg' }],
        },
        { type: 'ui.switchFrame', params: { selector: '#frm' } },
        { type: 'ui.click', locators: [{ strategy: 'role', value: 'button', name: 'Frame button' }] },
        {
          type: 'ui.assert',
          params: { check: 'visible' },
          locators: [{ strategy: 'text', value: 'Clicked in frame' }],
        },
        { type: 'ui.switchFrame', params: { main: true } },
        { type: 'ui.click', locators: [{ strategy: 'role', value: 'link', name: 'Open help' }] },
        { type: 'ui.switchTab', params: { urlContains: 'other.html' } },
        { type: 'ui.assert', params: { check: 'title', expected: 'Help' } },
        { type: 'ui.closeTab' },
        { type: 'ui.assert', params: { check: 'title', expected: 'Fixture Login' } },
      ),
    );
    expect(r.steps.filter((s) => s.status !== 'passed').map((s) => `${s.position}:${s.message}`)).toEqual([]);
  });

  it('fails clearly and keeps evidence: screenshot, DOM, console, network, video, trace', async () => {
    const r = await run(
      steps(
        { type: 'ui.navigate', params: { url: '/' } },
        { type: 'ui.click', locators: [{ strategy: 'css', value: '#boom' }] },
        { type: 'ui.click', locators: [{ strategy: 'testId', value: 'login-btn' }] },
        {
          type: 'ui.assert',
          params: { check: 'text', expected: 'Welcome back' },
          locators: [{ strategy: 'css', value: '#msg' }],
          timeoutMs: 1500,
        },
      ),
      { video: 'onFailure', trace: 'onFailure', screenshots: 'everyStep' },
    );
    expect(r.status).toBe('failed');
    expect(r.errorKind).toBe('assertion');
    expect(r.error).toMatch(/Expected text "Welcome back", but got "Welcome/);
    expect(r.steps[0]!.screenshotPath).toMatch(/step-01\.jpg$/);
    expect(r.steps[3]!.screenshotPath).toMatch(/step-04-failed\.png$/);
    const kinds = r.artifacts.map((a) => a.kind).sort();
    expect(kinds).toEqual(['console', 'dom', 'network', 'trace', 'video']);
    for (const a of r.artifacts) expect(existsSync(a.path)).toBe(true);
    const consoleLog = JSON.parse(readFileSync(join(r.artifactsDir, 'console.json'), 'utf8'));
    expect(consoleLog.some((c: { type: string }) => c.type === 'pageerror')).toBe(true);
    const network = JSON.parse(readFileSync(join(r.artifactsDir, 'network.json'), 'utf8'));
    expect(
      network.some((n: { url: string; status: number }) => n.url.endsWith('/api/login') && n.status === 500),
    ).toBe(true);
  }, 30_000);

  it('discards video and trace for passing tests in onFailure mode', async () => {
    const r = await run(steps({ type: 'ui.navigate', params: { url: '/' } }), {
      video: 'onFailure',
      trace: 'onFailure',
    });
    expect(r.status).toBe('passed');
    expect(r.artifacts.map((a) => a.kind).sort()).toEqual(['console', 'network']);
    expect(existsSync(join(r.artifactsDir, 'video.webm'))).toBe(false);
  });

  it('reports a missing element with every strategy tried', async () => {
    const r = await run(
      steps(
        { type: 'ui.navigate', params: { url: '/' } },
        {
          type: 'ui.click',
          locators: [
            { strategy: 'testId', value: 'nope' },
            { strategy: 'text', value: 'Nope' },
          ],
          timeoutMs: 600,
        },
      ),
    );
    expect(r.errorKind).toBe('element_not_found');
    expect(r.error).toContain('testId=nope | text=Nope');
  });

  it('says which element covers the one it could not click', async () => {
    const r = await run(
      steps(
        { type: 'ui.navigate', params: { url: '/covered.html' } },
        { type: 'ui.click', locators: [{ strategy: 'testId', value: 'go' }], timeoutMs: 1200 },
      ),
    );
    expect(r.status).toBe('failed');
    expect(r.error).toMatch(/<div class="sheet"[^>]*>Rate us<\/div> intercepts pointer events/);
  });

  it('page conditions: repeat while an element is visible, and branch on what the page shows', async () => {
    const more = [{ strategy: 'role' as const, value: 'button', name: 'Load more' }];
    const items = [{ strategy: 'css' as const, value: '#list li' }];
    const log = (message: string) => ({ type: 'util.log', params: { message } });
    const r = await run(
      steps(
        { type: 'ui.navigate', params: { url: '/more.html' } },
        {
          type: 'util.loop',
          locators: more,
          params: {
            while: { type: 'element', check: 'visible', timeoutMs: 500 },
            count: 10,
            steps: [{ type: 'ui.click', locators: more }],
          },
        },
        {
          type: 'util.if',
          locators: items,
          params: {
            condition: { type: 'element', check: 'count', expected: 3 },
            steps: [log('three items')],
            else: [log('wrong count')],
          },
        },
        {
          type: 'util.if',
          locators: more,
          params: {
            condition: { type: 'element', check: 'present', timeoutMs: 300 },
            steps: [log('button still there')],
            else: [log('button gone')],
          },
        },
        {
          type: 'util.if',
          locators: [{ strategy: 'css', value: '#list' }],
          params: {
            condition: { type: 'element', check: 'textContains', expected: 'Item 3' },
            steps: [log('has item 3')],
          },
        },
      ),
    );
    const byType = r.steps.map(
      (s) => `${s.type}:${s.status}${s.type.startsWith('util.') ? ` ${s.message}` : ''}`,
    );
    expect(r.status, byType.join('\n')).toBe('passed');
    const loop = r.steps.find((s) => s.type === 'util.loop')!;
    expect(loop.message).toMatch(/^Repeated 3 time\(s\) while the condition held/);
    const notes = r.steps.filter((s) => s.type === 'util.log').map((s) => s.message);
    expect(notes).toEqual(['three items', 'button gone', 'has item 3']);
  });

  it('web app steps: download, wait for / mock API responses, offline, storage, clock, canvas clicks', async () => {
    const css = (value: string) => [{ strategy: 'css' as const, value }];
    const r = await run(
      steps(
        { type: 'ui.setClock', params: { action: 'install', time: '2030-01-15T10:00:00Z' } },
        { type: 'ui.navigate', params: { url: '/web.html' } },
        {
          type: 'ui.download',
          locators: [{ strategy: 'text', value: 'Export' }],
          captureAs: 'file',
          assertions: [
            { target: 'fileName', operator: 'equals', expected: 'report.csv' },
            { target: 'content', operator: 'contains', expected: '1,Ana' },
          ],
        },
        { type: 'ui.click', locators: css('#load') },
        {
          type: 'ui.waitForResponse',
          params: { url: '**/api/items*' },
          captureAs: 'items',
          assertions: [
            { target: 'status', operator: 'equals', expected: 200 },
            { target: '$.items[0].id', operator: 'equals', expected: 7 },
          ],
        },
        { type: 'ui.assert', params: { check: 'text', expected: 'total 1' }, locators: css('#out') },
        { type: 'ui.mockRoute', params: { url: '/api/items', status: 200, body: '{"items":[],"total":42}' } },
        { type: 'ui.click', locators: css('#load') },
        { type: 'ui.assert', params: { check: 'text', expected: 'total 42' }, locators: css('#out') },
        { type: 'ui.mockRoute', params: { url: '/api/items', action: 'remove' } },
        { type: 'ui.setOffline', params: { offline: true } },
        { type: 'ui.click', locators: css('#load') },
        { type: 'ui.assert', params: { check: 'text', expected: 'offline' }, locators: css('#out') },
        { type: 'ui.setOffline', params: { offline: false } },
        { type: 'ui.storage', params: { kind: 'local', action: 'set', name: 'theme', value: 'dark' } },
        { type: 'ui.storage', params: { kind: 'local', action: 'get', name: 'theme' }, captureAs: 'theme' },
        { type: 'ui.storage', params: { kind: 'cookie', action: 'set', name: 'consent', value: 'yes' } },
        {
          type: 'ui.storage',
          params: { kind: 'cookie', action: 'get', name: 'consent' },
          assertions: [{ target: 'value', operator: 'equals', expected: 'yes' }],
        },
        { type: 'ui.click', locators: css('#time') },
        { type: 'ui.assert', params: { check: 'text', expected: '2030-01-15' }, locators: css('#now') },
        { type: 'ui.click', params: { x: 30, y: 40 }, locators: css('#c') },
        { type: 'ui.assert', params: { check: 'text', expected: 'canvas 30,40' }, locators: css('#out') },
        { type: 'ui.tap', locators: css('#c') },
      ),
    );
    const lines = r.steps.map((s) => `${s.type}:${s.status} ${s.message ?? ''}`);
    // Tapping needs a touch screen: on the desktop size the last step fails with a clear message.
    expect(lines.slice(0, -1), lines.join('\n')).toEqual(
      r.steps.slice(0, -1).map((s) => expect.stringMatching(new RegExp(`^${s.type}:passed`))),
    );
    expect(r.steps.at(-1)!.message).toMatch(/Tapping needs a touch screen/);
    expect((r.vars.file as { fileName: string }).fileName).toBe('report.csv');
    expect(r.vars.items).toEqual({ items: [{ id: 7 }], total: 1 });
    expect(r.vars.theme).toBe('dark');
  });

  it('phone size: touch and a mobile browser identity; tapping works', async () => {
    const r = await run(
      steps(
        { type: 'ui.navigate', params: { url: '/web.html' } },
        {
          type: 'ui.assert',
          params: { check: 'text', expected: 'mobile touch' },
          locators: [{ strategy: 'css', value: '#ua' }],
        },
        { type: 'ui.tap', locators: [{ strategy: 'css', value: '#time' }] },
        {
          type: 'ui.assert',
          params: { check: 'text', expected: new Date().toISOString().slice(0, 10) },
          locators: [{ strategy: 'css', value: '#now' }],
        },
      ),
      { viewport: { width: 390, height: 844 }, device: 'mobile' },
    );
    expect(r.status, r.steps.map((s) => `${s.type} ${s.message}`).join('\n')).toBe('passed');
  });

  it('visual checkpoints: the first run saves the baseline, a changed page fails with a difference image', async () => {
    const baselineDir = mkdtempSync(join(tmpdir(), 'sf-baselines-'));
    const id = newId();
    const check = () =>
      runTestCase({
        runId: 'R',
        steps: [
          ...steps({ type: 'ui.navigate', params: { url: '/web.html' } }),
          {
            ...steps({
              type: 'ui.visualCheckpoint',
              locators: [{ strategy: 'css', value: '#box' }],
              params: { maxDiffPercent: 1 },
            })[0]!,
            id, // the same step in every run, so the same baseline
          },
        ],
        env: { baseUrl },
        executors: [createUiExecutor(pool, { baselineDir }), utilExecutor],
        options: {
          ...DEFAULT_RUN_OPTIONS,
          defaultTimeoutMs: 4000,
          video: 'off',
          trace: 'off',
          screenshots: 'off',
          baseUrl,
        },
        artifactsDir: mkdtempSync(join(tmpdir(), 'sf-ui-')),
      });
    const first = await check();
    expect(first.status).toBe('passed');
    expect(first.steps.at(-1)!.visual).toMatchObject({ status: 'new' });
    const second = await check();
    expect(second.steps.at(-1)!.visual).toMatchObject({ status: 'match', diffPercent: 0 });
    // Change the approved baseline so the page no longer matches it (as if the page had changed).
    const baseline = second.steps.at(-1)!.visual!.baseline;
    const { PNG } = await import('pngjs');
    const png = PNG.sync.read(readFileSync(baseline));
    for (let i = 0; i < png.data.length; i += 4) png.data[i] = 255;
    writeFileSync(baseline, PNG.sync.write(png));
    const third = await check();
    expect(third.status).toBe('failed');
    expect(third.steps.at(-1)!.visual).toMatchObject({ status: 'changed', diffPercent: 100 });
    expect(existsSync(third.steps.at(-1)!.visual!.diff!)).toBe(true);
    expect(third.steps.at(-1)!.message).toMatch(/100% of pixels differ from the baseline \(1% allowed\)/);
  });

  it('environment browser settings: basic auth, extra headers, language, time zone, dark mode, location', async () => {
    const text = (id: string, expected: string) => ({
      type: 'ui.assert',
      params: { check: 'text', expected },
      locators: [{ strategy: 'css' as const, value: `#${id}` }],
    });
    const r = await run(
      steps(
        { type: 'ui.navigate', params: { url: '/secure.html' } },
        text('h', 'on'),
        text('env', 'de-DE Asia/Dhaka dark'),
        text('geo', '23.81,90.41'),
      ),
      {
        browserSettings: {
          httpCredentials: { username: 'ana', password: 's3cret' },
          extraHTTPHeaders: { 'X-Feature': 'on' },
          locale: 'de-DE',
          timezoneId: 'Asia/Dhaka',
          colorScheme: 'dark',
          geolocation: { latitude: 23.81, longitude: 90.41 },
          permissions: ['geolocation'],
        },
      },
    );
    expect(r.status, r.steps.map((s) => `${s.type} ${s.message}`).join('\n')).toBe('passed');
  });

  it('network summary: requests, bytes, types, third-party hosts and failures, as checks', async () => {
    const r = await run(
      steps(
        { type: 'ui.navigate', params: { url: '/net.html' } },
        {
          type: 'ui.networkSummary',
          params: { since: 'lastNavigation' },
          captureAs: 'traffic',
          assertions: [
            { target: 'requests', operator: 'equals', expected: 4 },
            { target: 'requests:script', operator: 'equals', expected: 1 },
            { target: 'failed', operator: 'equals', expected: 1 },
            { target: 'thirdPartyHosts', operator: 'equals', expected: 1 },
            { target: 'bytes', operator: 'gt', expected: 1000 },
          ],
        },
      ),
    );
    expect(r.status, r.steps.map((s) => `${s.type} ${s.message}`).join('\n')).toBe('passed');
    expect(r.steps[1]!.message).toMatch(/^4 requests, [\d.]+ (B|kB), 1 failed, 1 third-party host\(s\)/);
  });

  it('mocks per method on one URL; "times" counts only requests the mock answers; offline and back online', async () => {
    const css = (value: string) => [{ strategy: 'css' as const, value }];
    const out = (expected: string) => ({
      type: 'ui.assert',
      params: { check: 'text', expected },
      locators: css('#out'),
    });
    const r = await run(
      steps(
        { type: 'ui.navigate', params: { url: '/mock.html' } },
        { type: 'ui.mockRoute', params: { url: '/api/orders*', method: 'GET', body: '{"m":"get"}' } },
        {
          type: 'ui.mockRoute',
          params: { url: '/api/orders*', method: 'POST', body: '{"m":"post"}', times: 1 },
        },
        // The GET passes through the POST mock first (it falls back): that must not use up its one time.
        { type: 'ui.click', locators: css('#get') },
        out('get {"m":"get"}'),
        { type: 'ui.click', locators: css('#post') },
        out('post {"m":"post"}'),
        { type: 'ui.click', locators: css('#post') },
        out('post {"from":"server"}'),
        { type: 'ui.click', locators: css('#get') },
        out('get {"m":"get"}'),
        { type: 'ui.mockRoute', params: { url: '/api/orders*', action: 'remove' } },
        { type: 'ui.click', locators: css('#get') },
        out('get {"from":"server"}'),
        { type: 'ui.setOffline', params: { state: 'offline' } },
        { type: 'ui.click', locators: css('#get') },
        out('offline'),
        // An unticked "offline" used to vanish and mean offline again; "state" wins.
        { type: 'ui.setOffline', params: { state: 'online', offline: true } },
        { type: 'ui.click', locators: css('#post') },
        out('post {"from":"server"}'),
      ),
    );
    expect(r.status, r.steps.map((s) => `${s.type} ${s.status} ${s.message}`).join('\n')).toBe('passed');
    expect(r.steps.at(-3)!.message).toBe('The browser is back online');
  });

  it('clear messages: storage before a page is open, and a visual threshold that is not a number', async () => {
    const r = await run(
      steps(
        { type: 'ui.storage', params: { kind: 'local', action: 'get', name: 'theme' }, continueOnFail: true },
        { type: 'ui.navigate', params: { url: '/web.html' } },
        {
          type: 'ui.visualCheckpoint',
          locators: [{ strategy: 'css', value: '#box' }],
          params: { maxDiffPercent: '5%' },
          continueOnFail: true,
        },
        {
          type: 'ui.visualCheckpoint',
          locators: [{ strategy: 'css', value: '#box' }],
          params: { threshold: 2 },
        },
      ),
    );
    expect(r.steps.map((s) => s.status)).toEqual(['broken', 'passed', 'broken', 'broken']);
    expect(r.steps[0]!.message).toBe('Open a page before using localStorage');
    expect(r.steps[2]!.message).toMatch(/"maxDiffPercent" must be a number/);
    expect(r.steps[3]!.message).toMatch(/"threshold" must be a number from 0 to 1/);
  });

  it('network summary: when requests went unrecorded it says so and fails, since budgets cannot be trusted', async () => {
    const r = await runTestCase({
      runId: 'R',
      steps: steps(
        { type: 'ui.navigate', params: { url: '/net.html' } },
        {
          type: 'ui.networkSummary',
          assertions: [{ target: 'bytes', operator: 'lt', expected: 1_000_000 }],
        },
      ),
      env: { baseUrl },
      executors: [createUiExecutor(pool, { maxNetworkEntries: 2 }), utilExecutor],
      options: {
        ...DEFAULT_RUN_OPTIONS,
        defaultTimeoutMs: 8000,
        video: 'off',
        trace: 'off',
        screenshots: 'off',
        baseUrl,
      },
      artifactsDir: mkdtempSync(join(tmpdir(), 'sf-ui-')),
    });
    const summary = r.steps[1]!;
    expect(summary.status).toBe('failed');
    expect(summary.message).toMatch(/^Incomplete: 2 more requests were not recorded \(over 2 in this test\)/);
    expect(summary.assertions.find((a) => a.target === 'truncated')).toMatchObject({ passed: false });
  });

  it('Electron desktop app: the app’s windows are the test’s pages (a new window is like a tab), with video', async () => {
    const appPath = fileURLToPath(new URL('../../../../demo/desktop-app', import.meta.url));
    const css = (value: string) => [{ strategy: 'css' as const, value }];
    const r = await run(
      steps(
        {
          type: 'ui.fill',
          params: { value: 'Buy milk' },
          locators: [{ strategy: 'placeholder', value: 'Write a note' }],
        },
        { type: 'ui.click', locators: [{ strategy: 'testId', value: 'add-note' }] },
        {
          type: 'ui.assert',
          params: { check: 'text', expected: '1 note' },
          locators: [{ strategy: 'role', value: 'status' }],
        },
        {
          type: 'ui.assert',
          params: { check: 'title', expected: 'Notes' },
        },
        { type: 'ui.click', locators: css('#about') },
        { type: 'ui.switchTab', params: { urlContains: 'about.html' } },
        {
          type: 'ui.assert',
          params: { check: 'textContains', expected: 'demo desktop app' },
          locators: css('p'),
        },
      ),
      { electron: { appPath }, video: 'always' },
    );
    expect(r.status, r.steps.map((s) => `${s.type} ${s.status} ${s.message}`).join('\n')).toBe('passed');
    expect(r.artifacts.some((a) => a.kind === 'video' && existsSync(a.path))).toBe(true);
  }, 60_000);

  it('Electron: a missing app gives a clear error', async () => {
    const r = await run(steps({ type: 'ui.click', locators: [{ strategy: 'css', value: '#x' }] }), {
      electron: { appPath: '/nowhere/app' },
    });
    expect(r.status).toBe('broken');
    expect(r.steps[0]!.message).toContain('The app folder was not found: /nowhere/app');
  });
});
