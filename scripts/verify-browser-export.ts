/**
 * Proves that the newer steps run in exported code (StepForge by Md Zarin Tasnim): touch taps, downloads, waiting for
 * a response, faked routes, offline mode, cookies and storage, the page clock, the network summary, page conditions
 * and "repeat while" loops, SOAP with XPath checks, OAuth2 tokens and JSON Schema checks. A small local web app made
 * for the purpose answers them (CareClinic has no downloads or SOAP service).
 *
 *   npx tsx scripts/verify-browser-export.ts                                  # Playwright (TypeScript)
 *   npx tsx scripts/verify-browser-export.ts --targets playwright-ts,playwright-py
 *
 * Each target is run twice: the suite as written must pass, and a copy with one wrong expectation per test must fail
 * in every test (so passing results are not vacuous). Exits 1 otherwise. A target whose tools are missing is reported
 * as skipped, never as passed.
 */
import { generate, type CodegenInput, type CodegenStep, type TargetId } from '@stepforge/codegen';
import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: { targets: { type: 'string', default: 'playwright-ts' } } });

const CLIENT_SECRET = 'lab-client-secret'; // the lab app's own test credential (no real service)
const TOKEN = 'lab-token-123';

// ─── The lab app ────────────────────────────────────────────────────────────

const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>Lab</title></head>
<body>
  <p data-testid="today"></p>
  <p data-testid="clock"></p>
  <p data-testid="stock">loading</p>
  <p data-testid="ads">loading</p>
  <button id="menu">Menu</button> <p data-testid="menu-state">closed</p>
  <a href="/export.csv">Export CSV</a>
  <div id="banner"><button>Accept cookies</button></div>
  <ul id="items"><li class="item">Item 1</li></ul>
  <button id="more">Load more</button>
  <p data-testid="net">online</p>
  <script>
    const $ = (id) => document.querySelector('[data-testid="' + id + '"]');
    $('today').textContent = 'Today ' + new Date().toISOString().slice(0, 10);
    const tick = () => ($('clock').textContent = 'Now ' + new Date().toISOString());
    tick();
    setInterval(tick, 500);
    fetch('/api/products').then((r) => r.json()).then((j) => document.title = 'Lab: ' + j.items.length + ' products');
    fetch('/api/stock').then((r) => r.json()).then((j) => ($('stock').textContent = j.inStock ? 'In stock' : 'Sold out'))
      .catch(() => ($('stock').textContent = 'Stock unknown'));
    fetch('/api/ads').then(() => ($('ads').textContent = 'Ads shown')).catch(() => ($('ads').textContent = 'Ads blocked'));
    document.getElementById('menu').addEventListener('touchend', () => ($('menu-state').textContent = 'opened by touch'));
    document.querySelector('#banner button').addEventListener('click', () => document.getElementById('banner').remove());
    document.getElementById('more').addEventListener('click', () => {
      const list = document.getElementById('items');
      const li = document.createElement('li');
      li.className = 'item';
      li.textContent = 'Item ' + (list.children.length + 1);
      list.appendChild(li);
      if (list.children.length >= 4) document.getElementById('more').disabled = true;
    });
    addEventListener('offline', () => ($('net').textContent = 'You are offline'));
    addEventListener('online', () => ($('net').textContent = 'Back online'));
  </script>
</body></html>`;

const body = (req: IncomingMessage) =>
  new Promise<string>((r) => {
    let s = '';
    req.on('data', (c) => (s += c));
    req.on('end', () => r(s));
  });

const soapReply = (inner: string) =>
  `<?xml version="1.0"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>${inner}</soap:Body></soap:Envelope>`;

function startLab(): Promise<{ url: string; close: () => void }> {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://lab');
    const send = (status: number, type: string, text: string, extra: Record<string, string> = {}) => {
      res.writeHead(status, { 'content-type': type, ...extra });
      res.end(text);
    };
    const json = (status: number, x: unknown) => send(status, 'application/json', JSON.stringify(x));
    switch (url.pathname) {
      case '/':
        return send(200, 'text/html; charset=utf-8', PAGE);
      case '/api/products':
        return json(200, { items: [{ sku: 'A-1' }, { sku: 'B-2' }] });
      case '/api/stock':
        return json(200, { inStock: false });
      case '/api/ads':
        return json(200, { ad: 'buy now' });
      case '/export.csv':
        return send(200, 'text/csv', 'sku,price\nA-1,10\nB-2,20\n', {
          'content-disposition': 'attachment; filename="products.csv"',
        });
      case '/soap/prices': {
        const xml = await body(req);
        if (req.method !== 'POST' || !(req.headers['content-type'] ?? '').startsWith('text/xml'))
          return send(415, 'text/plain', 'SOAP 1.1 only');
        if (xml.includes('<m:Sku>BAD</m:Sku>'))
          return send(
            500,
            'text/xml',
            soapReply(
              '<soap:Fault><faultcode>soap:Client</faultcode><faultstring>Unknown SKU</faultstring></soap:Fault>',
            ),
          );
        return send(
          200,
          'text/xml',
          soapReply(
            `<ns:GetPriceResponse xmlns:ns="urn:prices"><ns:Price>12.5</ns:Price><ns:Line>a</ns:Line><ns:Line>b</ns:Line><ns:Action>${String(req.headers.soapaction ?? '')}</ns:Action></ns:GetPriceResponse>`,
          ),
        );
      }
      case '/oauth/token': {
        const form = new URLSearchParams(await body(req));
        const basic = `Basic ${Buffer.from(`lab-client:${CLIENT_SECRET}`).toString('base64')}`;
        if (req.headers.authorization !== basic || form.get('grant_type') !== 'client_credentials')
          return json(401, { error: 'invalid_client' });
        return json(200, {
          access_token: TOKEN,
          token_type: 'bearer',
          expires_in: 300,
          scope: form.get('scope'),
        });
      }
      case '/api/me':
        if (req.headers.authorization !== `Bearer ${TOKEN}`) return json(401, { error: 'no token' });
        return json(200, { id: 7, name: 'Ana', email: 'ana@lab.test', roles: ['nurse'] });
      default:
        return send(404, 'text/plain', 'not found');
    }
  });
  return new Promise((r) =>
    server.listen(0, '127.0.0.1', () =>
      r({
        url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
        close: () => server.close(),
      }),
    ),
  );
}

// ─── The suite ──────────────────────────────────────────────────────────────

const s = (type: string, extra: Partial<CodegenStep> = {}): CodegenStep => ({
  type,
  params: {},
  locators: [],
  assertions: [],
  ...extra,
});
const L = (strategy: string, value: string, name?: string) => [{ strategy, value, ...(name && { name }) }];
const see = (testId: string, text: string) =>
  s('ui.assert', { params: { check: 'textContains', expected: text }, locators: L('testId', testId) });

/**
 * The suite. `bad`: one wrong expectation (in the browser test, the API test or both), which must then fail.
 * `omit`: step types the target does not export; they are left out together with the checks that depend on them.
 */
function suite(bad: string[] = [], omit = new Set<string>()): CodegenInput {
  const wrong = <T>(name: string, good: T, notGood: T) => (bad.includes(name) ? notGood : good);
  // A step and the checks that need it.
  const g = (type: string, steps: CodegenStep[]) => (omit.has(type) ? [] : steps);
  const browser: CodegenStep[] = [
    ...g('ui.setClock', [s('ui.setClock', { params: { action: 'install', time: '2026-03-01T09:00:00Z' } })]),
    ...g('ui.mockRoute', [
      s('ui.mockRoute', {
        params: { url: '**/api/stock', method: 'GET', action: 'fulfill', body: { inStock: true } },
      }),
      s('ui.mockRoute', { params: { url: '/api/ads', action: 'abort' } }),
    ]),
    s('ui.navigate', { params: { url: '/' } }),
    ...g('ui.waitForResponse', [
      s('ui.waitForResponse', {
        params: { url: '/api/products', method: 'GET' },
        assertions: [
          { target: 'status', operator: 'equals', expected: wrong('response', 200, 201) },
          { target: '$.items[0].sku', operator: 'equals', expected: 'A-1' },
          { target: 'header:content-type', operator: 'contains', expected: 'json' },
          { target: 'url', operator: 'contains', expected: '/api/products' },
        ],
        captureAs: 'products',
      }),
    ]),
    ...g('ui.setClock', [see('today', 'Today 2026-03-01')]),
    ...g('ui.mockRoute', [see('stock', 'In stock'), see('ads', 'Ads blocked')]),
    ...g('ui.tap', [
      s('ui.tap', { locators: L('role', 'button', 'Menu') }),
      see('menu-state', 'opened by touch'),
    ]),
    ...g('ui.download', [
      s('ui.download', {
        locators: L('role', 'link', 'Export CSV'),
        assertions: [
          { target: 'fileName', operator: 'equals', expected: 'products.csv' },
          { target: 'size', operator: 'gt', expected: 10 },
          { target: 'content', operator: 'contains', expected: wrong('download', 'B-2,20', 'C-3,30') },
        ],
        captureAs: 'csv',
      }),
    ]),
    ...g('ui.storage', [
      s('ui.storage', { params: { kind: 'cookie', action: 'set', name: 'consent', value: 'yes' } }),
      s('ui.storage', {
        params: { kind: 'cookie', action: 'get', name: 'consent' },
        assertions: [{ target: 'value', operator: 'equals', expected: wrong('storage', 'yes', 'no') }],
      }),
      s('ui.storage', { params: { kind: 'cookie', action: 'remove', name: 'consent' } }),
      s('ui.storage', {
        params: { kind: 'cookie', action: 'get', name: 'consent' },
        assertions: [{ target: 'exists', operator: 'equals', expected: false }],
      }),
      s('ui.storage', { params: { kind: 'local', action: 'set', name: 'cart', value: { items: 2 } } }),
      s('ui.storage', {
        params: { kind: 'local', action: 'get', name: 'cart' },
        assertions: [{ target: 'value', operator: 'equals', expected: '{"items":2}' }],
        captureAs: 'cart',
      }),
      s('ui.storage', { params: { kind: 'session', action: 'set', name: 'step', value: '{{vars.cart}}' } }),
      s('ui.storage', {
        params: { kind: 'session', action: 'get', name: 'step' },
        assertions: [{ target: 'value', operator: 'contains', expected: 'items' }],
      }),
      s('ui.storage', { params: { kind: 'session', action: 'clear' } }),
    ]),
    ...g('ui.setOffline', [
      s('ui.setOffline', { params: { state: 'offline' } }),
      see('net', 'You are offline'),
      s('ui.setOffline', { params: { state: 'online' } }),
      see('net', 'Back online'),
    ]),
    ...g('ui.setClock', [
      s('ui.setClock', { params: { action: 'fastForward', ms: 3_600_000 } }),
      see('clock', 'Now 2026-03-01T10:'),
      s('ui.setClock', { params: { action: 'set', time: '2030-01-02T03:04:05Z' } }),
      see('clock', 'Now 2030-01-02T03:04:05'),
    ]),
    ...g('util.if', [
      s('util.if', {
        locators: L('role', 'button', 'Accept cookies'),
        params: {
          condition: { type: 'element', check: 'visible' },
          steps: [s('ui.click', { locators: L('role', 'button', 'Accept cookies') })],
          else: [s('util.setVariable', { params: { name: 'banner', value: 'missing' } })],
        },
      }),
      s('ui.assert', { params: { check: 'hidden' }, locators: L('role', 'button', 'Accept cookies') }),
      // Gone now: the else branch runs (and a false condition costs only its short wait).
      s('util.if', {
        locators: L('role', 'button', 'Accept cookies'),
        params: {
          condition: { type: 'element', check: 'present', timeoutMs: 300 },
          steps: [s('util.setVariable', { params: { name: 'banner', value: 'still there' } })],
          else: [s('util.setVariable', { params: { name: 'banner', value: 'gone' } })],
        },
      }),
    ]),
    ...g('util.loop', [
      s('util.loop', {
        locators: L('role', 'button', 'Load more'),
        params: {
          while: { type: 'element', check: 'enabled', timeoutMs: 300 },
          // The button is disabled after three clicks; a limit of 2 fails the loop.
          count: wrong('while', 10, 2),
          steps: [s('ui.click', { locators: L('role', 'button', 'Load more') })],
        },
      }),
      s('ui.assert', { params: { check: 'count', expected: 4 }, locators: L('css', '#items .item') }),
    ]),
    ...g('util.if', [
      s('util.if', {
        locators: L('css', '#items .item'),
        params: {
          condition: { type: 'element', check: 'count', expected: 4 },
          steps: [s('util.setVariable', { params: { name: 'items', value: 'four' } })],
        },
      }),
    ]),
    ...g('util.loop', [
      s('util.loop', {
        params: {
          while: { value: '{{vars.index}}', operator: 'lt', expected: 3 },
          count: 5,
          steps: [s('util.setVariable', { params: { name: 'passes', value: '{{vars.index}}' } })],
        },
      }),
    ]),
    ...(omit.has('util.if') || omit.has('util.loop')
      ? []
      : [
          s('util.if', {
            params: {
              condition: {
                value: '{{vars.banner}}{{vars.items}}{{vars.passes}}',
                operator: 'equals',
                expected: 'gonefour2',
              },
              else: [s('ui.assert', { params: { check: 'title', expected: 'control flow went wrong' } })],
            },
          }),
        ]),
    ...g('ui.networkSummary', [
      s('ui.networkSummary', {
        params: { since: 'lastNavigation' },
        assertions: [
          { target: 'requests', operator: 'gte', expected: wrong('traffic', 3, 300) },
          { target: 'failed', operator: 'gte', expected: 1 },
          { target: 'thirdPartyHosts', operator: 'equals', expected: 0 },
          { target: 'requests:fetch', operator: 'gte', expected: 2 },
        ],
      }),
    ]),
  ];
  const api: CodegenStep[] = [
    ...g('api.soap', [
      s('api.soap', {
        params: {
          url: '/soap/prices',
          action: 'urn:GetPrice',
          body: `<m:GetPrice xmlns:m="urn:prices"><m:Sku>${wrong('soap', 'A-1', 'BAD')}</m:Sku></m:GetPrice>`,
          namespaces: { p: 'urn:prices' },
        },
        assertions: [
          { target: 'status', operator: 'equals', expected: 200 },
          { target: '//p:Price', operator: 'equals', expected: '12.5' },
          { target: 'count(//p:Line)', operator: 'equals', expected: 2 },
          { target: '//ns:Action', operator: 'equals', expected: '"urn:GetPrice"' },
        ],
      }),
      s('api.extract', { params: { from: 'body', path: '//p:Price' }, captureAs: 'price' }),
      s('api.soap', {
        label: 'A fault the step allows',
        params: {
          url: '/soap/prices',
          body: '<m:GetPrice xmlns:m="urn:prices"><m:Sku>BAD</m:Sku></m:GetPrice>',
          allowFault: true,
        },
        assertions: [
          { target: 'status', operator: 'equals', expected: 500 },
          { target: '//faultstring', operator: 'equals', expected: 'Unknown SKU' },
        ],
      }),
      s('util.if', {
        params: {
          condition: { value: '{{vars.price}}', operator: 'equals', expected: '12.5' },
          else: [
            s('api.request', {
              params: { method: 'GET', url: '/the-extract-went-wrong' },
              assertions: [{ target: 'status', operator: 'equals', expected: 200 }],
            }),
          ],
        },
      }),
    ]),
    ...g('api.request', [
      s('api.request', {
        params: {
          method: 'GET',
          url: '/api/me',
          auth: {
            type: 'oauth2',
            tokenUrl: '{{env.baseUrl}}/oauth/token',
            clientId: 'lab-client',
            clientSecret: '{{secret.clientSecret}}',
            scope: 'profile',
          },
        },
        assertions: [
          { target: 'status', operator: 'equals', expected: 200 },
          {
            target: '$',
            operator: 'matchesSchema',
            expected: {
              type: 'object',
              required: wrong('schema', ['id', 'name', 'email'], ['id', 'name', 'phone']),
              properties: {
                id: { type: 'integer' },
                email: { type: 'string', format: 'email' },
                roles: { type: 'array', items: { type: 'string' } },
              },
            },
          },
          { target: '$.roles', operator: 'matchesSchema', expected: { type: 'array', minItems: 1 } },
        ],
      }),
    ]),
  ];
  const scenario = (id: string, name: string, steps: CodegenStep[]) => ({
    id,
    name,
    modulePath: ['Lab'],
    priority: 'P1',
    tags: [],
    testCases: [],
    steps,
  });
  return {
    application: { name: 'Lab', slug: 'lab' },
    environment: {
      name: 'Local',
      baseUrl: 'http://127.0.0.1:1',
      variables: {},
      secretKeys: ['clientSecret'],
    },
    connections: [],
    inboxes: [],
    blocks: {},
    library: {},
    scenarios: [scenario('B', 'Browser steps', browser), scenario('A', 'SOAP OAuth2 and schema', api)],
    author: 'Md Zarin Tasnim',
    generatedAt: new Date().toISOString(),
  };
}

/**
 * The runs that must fail: each puts one wrong expectation into the browser test and/or the API test, and the step
 * type that carries it (a run is left out when the target does not export that step).
 */
const WRONG: { bad: string[]; needs: string[] }[] = [
  { bad: ['download', 'soap'], needs: ['ui.download', 'api.soap'] },
  { bad: ['response', 'schema'], needs: ['ui.waitForResponse', 'api.request'] },
  { bad: ['storage'], needs: ['ui.storage'] },
  { bad: ['while'], needs: ['util.loop'] },
  { bad: ['traffic'], needs: ['ui.networkSummary'] },
];
const API_ONLY = ['pytest-requests', 'rest-assured', 'curl', 'postman'];

// ─── Runners ────────────────────────────────────────────────────────────────

type Runner = { tool: string[]; steps: (dir: string) => [string, string[]][] };
const venv = (dir: string) => join(dir, '.venv', process.platform === 'win32' ? 'Scripts' : 'bin');
const python = (extra: string[] = []): Runner => ({
  tool: ['python3'],
  steps: (d) => [
    ['python3', ['-m', 'venv', '.venv']],
    [join(venv(d), 'pip'), ['install', '-q', '-r', 'requirements.txt']],
    ...extra.map((x): [string, string[]] => [join(venv(d), 'python'), x.split(' ')]),
    [join(venv(d), 'python'), ['-m', 'pytest', '-q']],
  ],
});
const RUNNERS: Record<string, Runner> = {
  'playwright-ts': {
    tool: ['npm'],
    steps: () => [
      ['npm', ['install', '--no-audit', '--no-fund']],
      ['npx', ['playwright', 'install', 'chromium']],
      ['npx', ['playwright', 'test']],
    ],
  },
  'playwright-py': python(['-m playwright install chromium']),
  'selenium-py': python(),
  'pytest-requests': python(),
  'cypress-js': {
    tool: ['npm'],
    steps: () => [
      ['npm', ['install', '--no-audit', '--no-fund']],
      ['npx', ['cypress', 'run']],
    ],
  },
  'selenium-java': { tool: ['mvn', 'java'], steps: () => [['mvn', ['-B', '-q', 'test']]] },
  'rest-assured': { tool: ['mvn', 'java'], steps: () => [['mvn', ['-B', '-q', 'test']]] },
  curl: { tool: ['bash', 'curl', 'jq'], steps: () => [['bash', ['requests.sh']]] },
  postman: {
    tool: ['npx'],
    steps: () => [
      [
        'npx',
        [
          '-y',
          'newman@6',
          'run',
          'lab.postman_collection.json',
          '--env-var',
          `clientSecret=${CLIENT_SECRET}`,
          '--env-var',
          'baseUrl=__BASE_URL__',
        ],
      ],
    ],
  },
};

const has = (cmd: string) =>
  spawnSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { stdio: 'ignore' }).status === 0;

function run(cmd: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((done) => {
    const child = spawn(cmd, args, { cwd, env, stdio: 'inherit', shell: process.platform === 'win32' });
    child.on('exit', (code) => done(code ?? 1));
    child.on('error', () => done(1));
  });
}

/** Tests and failures in the JUnit files a project wrote (any *.xml under results/ or target/surefire-reports/). */
function junit(dir: string): { tests: number; failed: number } | null {
  const files: string[] = [];
  const walk = (d: string) => {
    if (!existsSync(d)) return;
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (f.endsWith('.xml')) files.push(p);
    }
  };
  walk(join(dir, 'results'));
  walk(join(dir, 'target', 'surefire-reports'));
  if (!files.length) return null;
  let tests = 0;
  let failed = 0;
  for (const f of files) {
    const xml = readFileSync(f, 'utf8');
    for (const m of xml.matchAll(/<testcase\b[\s\S]*?(?:\/>|<\/testcase>)/g)) {
      tests++;
      if (/<(failure|error)\b/.test(m[0])) failed++;
    }
  }
  return { tests, failed };
}

async function main() {
  const targets = values.targets!.split(',').map((t) => t.trim());
  for (const t of targets)
    if (!RUNNERS[t]) throw new Error(`No runner for "${t}" (known: ${Object.keys(RUNNERS).join(', ')})`);
  const work = mkdtempSync(join(tmpdir(), 'stepforge-verify-browser-'));
  console.log(`Work folder: ${work}`);
  const lab = await startLab();
  const results: { target: string; result: string; ok: boolean | null }[] = [];
  const env = {
    ...process.env,
    CI: process.env.CI ?? '1',
    BASE_URL: lab.url,
    CLIENT_SECRET,
    ELECTRON_RUN_AS_NODE: undefined, // set by some editors; Cypress (Electron) must not inherit it
  };
  try {
    for (const target of targets) {
      const runner = RUNNERS[target]!;
      const missing = runner.tool.filter((t) => !has(t));
      if (missing.length) {
        results.push({ target, result: `skipped (${missing.join(', ')} not installed)`, ok: null });
        continue;
      }
      const outcome: string[] = [];
      let ok = true;
      // Steps the target does not export are left out (with the checks that need them), and reported.
      const first = await generate(suite(), { target: target as TargetId });
      const omit = new Set(first.warnings.flatMap((w) => (w.step ? [w.step] : [])));
      if (omit.size) outcome.push(`not exported: ${[...omit].join(', ')}`);
      const runs = [
        { name: 'as written', bad: [] as string[] },
        ...WRONG.filter((w) => w.needs.some((n) => !omit.has(n))).map((w, i) => ({
          name: `wrong copy ${i + 1} (${w.bad.join(', ')})`,
          bad: w.bad.filter((b, k) => !omit.has(w.needs[k]!)),
        })),
      ].filter(
        (r) =>
          !API_ONLY.includes(target) ||
          r.bad.length === 0 ||
          r.bad.some((b) => ['soap', 'schema'].includes(b)),
      );
      for (const [i, r] of runs.entries()) {
        const project = await generate(suite(r.bad, omit), { target: target as TargetId });
        const dir = join(work, `${target}-${i}`);
        for (const [path, content] of Object.entries(project.files)) {
          mkdirSync(dirname(join(dir, path)), { recursive: true });
          writeFileSync(join(dir, path), content);
        }
        console.log(`\n━━ ${target}, ${r.name}: ${dir}`);
        let code = 0;
        for (const [cmd, args] of runner.steps(dir)) {
          code = await run(
            cmd,
            args.map((a) => a.replace('__BASE_URL__', lab.url)),
            dir,
            env,
          );
          if (code !== 0) break;
        }
        const j = junit(dir);
        const counts = j ? ` ${r.bad.length ? j.failed : j.tests - j.failed}/${j.tests}` : '';
        if (!r.bad.length) {
          ok &&= code === 0;
          outcome.push(code === 0 ? `passed${counts}` : 'FAILED');
        } else {
          // Every test that holds a wrong expectation fails (an API-only target has only the API test).
          const failing =
            r.bad.some((b) => ['soap', 'schema'].includes(b)) &&
            r.bad.some((b) => !['soap', 'schema'].includes(b))
              ? API_ONLY.includes(target)
                ? 1
                : 2
              : 1;
          const right = code !== 0 && (!j || j.failed === failing);
          ok &&= right;
          outcome.push(`${r.name}: ${right ? 'failed as it should' : 'DID NOT FAIL AS IT SHOULD'}${counts}`);
        }
      }
      results.push({ target, result: outcome.join('; '), ok });
    }
  } finally {
    lab.close();
  }
  console.log('\nNewer steps in exported code, against the lab app:');
  for (const r of results)
    console.log(`  ${r.ok === null ? '-' : r.ok ? '✓' : '✗'} ${r.target.padEnd(16)} ${r.result}`);
  console.log(`Work folder (kept for inspection): ${work}`);
  process.exitCode = results.some((r) => r.ok === false) || !results.some((r) => r.ok) ? 1 : 0;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
