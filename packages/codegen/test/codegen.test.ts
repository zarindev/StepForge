import ExcelJS from 'exceljs';
import { transformSync } from 'esbuild';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import {
  buildPlan,
  generate,
  TARGETS,
  zipProject,
  type GeneratedProject,
  type TargetId,
} from '../src/index.ts';
import { walk, type Op } from '../src/ir.ts';
import { camel, envName, parseString, snake, uniquer, val } from '../src/values.ts';
import { jsVal } from '../src/lang/js.ts';
import { javaBlock } from '../src/lang/java.ts';
import { pyBlock, pyVal } from '../src/lang/py.ts';
import { jsonPath, pick } from '../runtime/ts/helpers.ts';
import { parse, parseAllDocuments } from 'yaml';
import { HOSTILE, KITCHEN_SINK, NATIVE_APP, PLANTED_SECRET } from './fixtures.ts';

const hasPython = spawnSync('python3', ['--version']).status === 0;
const hasBash = spawnSync('bash', ['--version']).status === 0;

const RUNTIME =
  /(^|\/)support\/(helpers|api|db|mail|tabs|browser|app|web|kafka|ftp|mongo|schema|xml)\.(ts|py)$|find\.js$|support\/(Checks|J|Api|Fake|Db|Mail|Browser|App)\.java$|cypress\/support\/(helpers|mail)\.js$|cypress\/plugins\/.*\.cjs$|tools\/stepforge_atspi\.py$/;

/** Snapshot of every generated text file (one file per output file, readable in review). */
async function snapshot(target: TargetId, project: GeneratedProject, variant = '') {
  const listing: string[] = [];
  for (const [path, content] of Object.entries(project.files).sort(([a], [b]) => a.localeCompare(b))) {
    listing.push(
      `${path} (${typeof content === 'string' ? `${content.split('\n').length} lines` : 'binary'})`,
    );
    // Runtime helpers are copied verbatim from packages/codegen/runtime (tested there); only generated code is snapshotted.
    if (typeof content === 'string' && !RUNTIME.test(path))
      await expect(content).toMatchFileSnapshot(`__snapshots__/${target}${variant}/${path}.snap`);
  }
  listing.push(
    '',
    'Warnings:',
    ...project.warnings.map((w) => `- ${w.scenario ?? ''} | ${w.step ?? ''} | ${w.message}`),
  );
  await expect(`${listing.join('\n')}\n`).toMatchFileSnapshot(
    `__snapshots__/${target}${variant}/_files.snap`,
  );
}

describe('values', () => {
  it('parses placeholders into references and keeps whole-placeholder types', () => {
    expect(parseString('Hi {{data.name}}, run {{run.id}}!')).toEqual({
      t: 'str',
      parts: ['Hi ', { scope: 'data', name: 'name' }, ', run ', { scope: 'run', name: 'id' }, '!'],
    });
    expect(val('{{vars.count}}')).toEqual({ t: 'ref', ref: { scope: 'vars', name: 'count' } });
    expect(val('{{env.baseUrl}}/x')).toEqual({
      t: 'str',
      parts: [{ scope: 'baseUrl', name: 'baseUrl' }, '/x'],
    });
    expect(val('{{unknown.x}} stays')).toEqual({ t: 'str', parts: ['{{unknown.x}} stays'] });
  });

  it('names things for each language', () => {
    expect(camel('Sign in — admin')).toBe('signInAdmin');
    expect(snake('Checkout flow 2')).toBe('checkout_flow_2');
    expect(envName('apiToken')).toBe('API_TOKEN');
    expect(envName('api-version')).toBe('API_VERSION');
    expect(camel('2FA code')).toBe('_2FaCode');
  });

  it('never gives the same name twice', () => {
    const unique = uniquer();
    expect(['save', 'save', 'save2', 'save2'].map(unique)).toEqual(['save', 'save2', 'save22', 'save23']);
  });
});

describe('plan', () => {
  it('leaves image locators out of exports; a step with only a picture becomes a TODO', () => {
    const base = KITCHEN_SINK.scenarios[0]!;
    const plan = buildPlan({
      ...KITCHEN_SINK,
      scenarios: [
        {
          ...base,
          steps: [
            {
              id: 's1',
              type: 'ui.click',
              params: {},
              assertions: [],
              locators: [
                { strategy: 'image', value: 'data:image/png;base64,AAAA' },
                { strategy: 'testId', value: 'pin' },
              ],
            },
            {
              id: 's2',
              type: 'ui.click',
              params: {},
              assertions: [],
              locators: [{ strategy: 'image', value: 'data:image/png;base64,AAAA' }],
            },
          ] as never,
        },
      ],
    });
    expect(JSON.stringify(plan.tests[0]!.ops)).not.toContain('data:image');
    expect(plan.warnings.map((w) => w.message)).toContain(
      'image locators (pictures) are not exported; add an id, text or CSS locator',
    );
  });

  it('warns that UI tests of a desktop (Electron) app are exported as browser tests', () => {
    const desktop = buildPlan({
      ...KITCHEN_SINK,
      application: { ...KITCHEN_SINK.application, platform: 'electron' },
    });
    expect(desktop.warnings.map((w) => w.message)).toContainEqual(
      expect.stringContaining('_electron.launch()'),
    );
    expect(buildPlan(KITCHEN_SINK).warnings.map((w) => w.message)).not.toContainEqual(
      expect.stringContaining('_electron.launch()'),
    );
    const android = buildPlan({
      ...KITCHEN_SINK,
      application: { ...KITCHEN_SINK.application, platform: 'android' },
    });
    expect(android.warnings.map((w) => w.message)).toContainEqual(
      expect.stringContaining('This is an Android app'),
    );
    const ios = buildPlan({ ...KITCHEN_SINK, application: { ...KITCHEN_SINK.application, platform: 'ios' } });
    expect(ios.warnings.map((w) => w.message)).toContainEqual(expect.stringContaining('This is an iOS app'));
  });
  it('inlines blocks and called scenarios, collects secrets and variables, and reports what cannot be exported', () => {
    const plan = buildPlan(KITCHEN_SINK, { pom: true });
    expect(plan.secrets).toEqual(['adminPassword', 'apiToken']);
    expect(plan.variables).toEqual(['api-version', 'region']);
    const s1 = plan.tests[0]!;
    expect(
      s1.ops
        .filter((o) => o.op === 'comment')
        .map((o) => (o as { text: string }).text)
        .slice(0, 3),
    ).toEqual(['Block: Sign in as admin', 'Open /login', 'Type "{{data.user}}" into the "Email" field']);
    expect(s1.ops.some((o) => o.op === 'goto' && JSON.stringify(o.url).includes('/cart'))).toBe(true); // called scenario
    const messages = plan.warnings.map((w) => w.message);
    expect(messages).toEqual(
      expect.arrayContaining([
        'visual checkpoints are not exported; add a screenshot comparison in the target framework',
        'SQL Server helpers are not generated; the SQL file is exported for reference',
        'the data-quality audit runs only in StepForge',
        'IMAP inboxes are not exported; the helper reads a Mailpit server (MAILPIT_URL)',
        'performance measurements run only in StepForge',
        'load tests are not part of functional tests; export the scenario to k6 instead',
        expect.stringContaining('the "unknown" connection is not set up'),
      ]),
    );
    // A plan without a target keeps every feature.
    expect(messages.join('\n')).not.toMatch(/not exported to/);
    // Page objects: grouped by page, steps after a tab switch or inside a frame stay inline.
    expect([...plan.pages.keys()]).toEqual(['Login', 'Products']);
    expect(plan.pages.get('Login')!.elements.map((e) => e.name)).toEqual([
      'emailField',
      'passwordField',
      'signInButton',
    ]);
  });
});

describe('features', () => {
  const kinds = (plan: ReturnType<typeof buildPlan>) => {
    const out = new Set<string>();
    for (const t of plan.tests) walk(t.ops, (o) => out.add(o.op));
    return out;
  };

  it('turns the steps of a feature the target lacks into TODOs naming the target', () => {
    const plan = buildPlan(KITCHEN_SINK, { features: {}, label: 'Some export' });
    for (const k of ['download', 'waitResponse', 'mockRoute', 'offline', 'storage', 'clock', 'netSummary'])
      expect(kinds(plan).has(k), k).toBe(false);
    expect(kinds(plan).has('ifPage') || kinds(plan).has('while') || kinds(plan).has('kafka')).toBe(false);
    const messages = plan.warnings.map((w) => w.message);
    expect(messages).toEqual(
      expect.arrayContaining([
        'this browser step is not exported to Some export; write it with the framework’s own API',
        'page conditions (if the element is …) are not exported to Some export; write the check by hand',
        '“repeat while” loops are not exported to Some export; write the loop by hand',
        'SOAP steps are not exported to Some export; send the envelope with an HTTP client',
        'the JSON Schema check on "$" is not exported to Some export',
        'auth type "oauth2" is not exported to Some export; set the header yourself',
        'Kafka steps are not exported to Some export; use a Kafka client of the target language',
        'FTP steps are not exported to Some export; use an FTP client of the target language',
        'MongoDB steps are not exported to Some export; use the MongoDB driver of the target language',
      ]),
    );
    // A reason of the target's own replaces the default one.
    const own = buildPlan(KITCHEN_SINK, { features: { kafka: 'no Kafka here' }, label: 'X' });
    expect(own.warnings.map((w) => w.message)).toContain('no Kafka here');
  });

  it('exports every newer step with all features, as StepForge runs it', () => {
    const plan = buildPlan(KITCHEN_SINK);
    const all = plan.tests.flatMap((t) => {
      const ops: Op[] = [];
      walk(t.ops, (o) => ops.push(o));
      return ops;
    });
    const one = <K extends Op['op']>(k: K, f: (o: Extract<Op, { op: K }>) => boolean = () => true) =>
      all.find((o): o is Extract<Op, { op: K }> => o.op === k && f(o as Extract<Op, { op: K }>));
    expect(one('act', (o) => o.action === 'tap')?.el.loc).toEqual({
      strategy: 'role',
      value: 'button',
      name: 'Menu',
    });
    expect(one('download')?.asserts.map((a) => a.target)).toEqual(['fileName', 'size', 'content']);
    expect(one('waitResponse')).toMatchObject({
      method: 'GET',
      status: 200,
      timeoutMs: 15000,
      into: 'products',
    });
    expect(one('mockRoute', (o) => o.action === 'delay')).toMatchObject({ delayMs: 500, times: 2 });
    expect(one('offline', (o) => !o.offline)).toBeTruthy();
    // A value that is not text is stored as JSON.
    expect(one('storage', (o) => o.kind === 'local' && o.action === 'set')?.value).toEqual({
      t: 'str',
      parts: ['{"items":2}'],
    });
    expect(one('clock', (o) => o.action === 'set')?.time).toEqual({ t: 'num', v: 1772355600000 });
    expect(one('netSummary')?.since).toBe('lastNavigation');
    expect(one('ifPage', (o) => o.cond.check === 'visible')?.cond.timeoutMs).toBe(1000);
    // "Repeat while": the count is the limit (default 100); a value condition works too.
    expect(one('while', (o) => o.cond.kind === 'page' && o.cond.check === 'enabled')?.max).toBe(20);
    expect(one('while', (o) => o.cond.kind === 'page' && o.cond.check === 'visible')?.max).toBe(100);
    expect(one('while', (o) => o.cond.kind === 'value')?.max).toBe(5);
    // SOAP: wrapped in a 1.1 envelope with its SOAPAction; a whole 1.2 envelope is sent as written.
    const soap = one('api', (o) => !!o.soap && o.label === 'Get the price')!;
    expect(soap.headers.map(([k]) => k)).toEqual(['content-type', 'soapaction']);
    expect(JSON.stringify(soap.body)).toContain('<soap:Header><auth:Token');
    expect(soap.soap).toEqual({ namespaces: { p: 'urn:prices' }, allowFault: false });
    const soap12 = one('api', (o) => o.label === 'SOAP 1.2 envelope')!;
    expect(soap12.headers).toEqual([
      ['content-type', { t: 'str', parts: ['application/soap+xml; charset=utf-8; action="urn:Ping"'] }],
    ]);
    expect(one('api', (o) => o.auth?.type === 'oauth2')?.auth).toMatchObject({
      tokenUrl: { t: 'str', parts: ['https://id.test/token'] },
      clientSecret: { t: 'ref', ref: { scope: 'secret', name: 'apiToken' } },
    });
    expect(one('kafka', (o) => o.action === 'consume')?.timeoutMs).toBe(20000);
    expect(one('ftp', (o) => o.action === 'list')).toBeTruthy();
    // MongoDB: a find step becomes the command StepForge runs; a JSON query is kept as text.
    expect(JSON.stringify(one('mongo', (o) => o.command.t === 'obj')?.command)).toContain('"find"');
    expect(one('mongo', (o) => o.command.t === 'str')).toBeTruthy();
  });
});

const ALL = TARGETS.filter((t) => !t.platforms).map((t) => t.id);
const NATIVE = TARGETS.filter((t) => t.platforms);

describe.each(ALL)('%s', (target) => {
  it('matches the snapshot, is valid code, and never contains a secret value', async () => {
    const project = await generate(KITCHEN_SINK, { target, pom: false, ci: ['github', 'gitlab'] });
    expect(Object.keys(project.files).length).toBeGreaterThan(0);
    for (const [path, content] of Object.entries(project.files)) {
      const text = typeof content === 'string' ? content : content.toString('latin1');
      expect(text, path).not.toContain(PLANTED_SECRET);
      if (typeof content !== 'string') continue;
      if (/\.(ts|js|cjs|mjs)$/.test(path) && !path.endsWith('find.js'))
        expect(
          () => transformSync(content, { loader: path.endsWith('.ts') ? 'ts' : 'js', format: 'esm' }),
          path,
        ).not.toThrow();
      if (path.endsWith('.json')) expect(() => JSON.parse(content), path).not.toThrow();
    }
    if (target !== 'docs-xlsx') await snapshot(target, project);
  });
});

describe('phone and desktop apps (Appium, Maestro)', () => {
  const ops = (platform: 'android' | 'ios' | 'macos' = 'android') =>
    buildPlan({ ...NATIVE_APP, application: { ...NATIVE_APP.application, platform } }, { native: true });

  it('turns phone and desktop steps into app actions, with the Appium selectors StepForge itself uses', () => {
    const plan = ops();
    const gestures = plan.tests[1]!.ops;
    const methods = gestures.flatMap((o) => (o.op === 'app' ? [o.method] : []));
    expect(methods).toEqual(
      expect.arrayContaining([
        'deepLink',
        'scrollTo',
        'swipe',
        'swipeOn',
        'drag',
        'longPress',
        'hideKeyboard',
        'back',
        'rotate',
        'backgroundApp',
        'closeApp',
        'launchApp',
        'resetApp',
        'setLocation',
        'permission',
        'pushNotification',
        'handleDialog',
        'menu',
        'select',
      ]),
    );
    const fill = plan.tests[0]!.ops.find((o) => o.op === 'act' && o.action === 'fill');
    expect(fill && 'el' in fill && fill.el?.queries).toEqual([
      { using: 'xpath', value: "//*[@hint='Email']" },
    ]);
    // CSS has no Appium equivalent: dropped, and a step with only CSS (or only a picture) becomes a TODO.
    const messages = plan.warnings.map((w) => w.message);
    expect(messages).toEqual(
      expect.arrayContaining([
        'its locators (CSS) do not exist in phone and desktop apps; add an id, text, label or XPath locator',
        'image locators (pictures) are not exported; add an id, text, label locator',
        'this is a web-page step; phone and desktop apps have no equivalent',
        'phone and desktop apps have no pages to open; use a deep link (myapp://…) instead',
        'phone and desktop apps have no URL or page title to check',
      ]),
    );
    const mixed = gestures.find(
      (o) => o.op === 'act' && o.action === 'click' && o.el.loc.strategy === 'xpath',
    ) as Extract<(typeof gestures)[number], { op: 'act' }>;
    expect(mixed.el.queries).toEqual([{ using: 'xpath', value: '//*[@text="Save"]' }]);
    // iOS: the same locator becomes its own selectors.
    const ios = ops('ios').tests[0]!.ops.find((o) => o.op === 'act' && o.action === 'fill');
    expect(ios && 'el' in ios && ios.el?.queries?.[0]?.using).toBe('-ios predicate string');
  });

  it('keeps the browser export for a phone app (with a warning), and refuses Appium for a web app', async () => {
    const web = await generate(NATIVE_APP, { target: 'playwright-ts' });
    expect(web.warnings.map((w) => w.message)).toContainEqual(
      expect.stringContaining('Use the Appium or Maestro export'),
    );
    await expect(generate(KITCHEN_SINK, { target: 'appium-py' })).rejects.toThrow(
      'is for phone and desktop apps; this application is a web app',
    );
    await expect(
      generate(
        { ...NATIVE_APP, application: { ...NATIVE_APP.application, platform: 'windows' } },
        { target: 'maestro' },
      ),
    ).rejects.toThrow('is for Android and iOS apps');
  });

  const cases = NATIVE.flatMap((t) => t.platforms!.map((platform) => [t.id, platform] as const));
  it.each(cases)(
    '%s on %s: valid code, no secret value',
    async (target, platform) => {
      const project = await generate(
        { ...NATIVE_APP, application: { ...NATIVE_APP.application, platform } },
        { target, ci: ['github', 'gitlab'] },
      );
      const dir = mkdtempSync(join(tmpdir(), `sf-${target}-${platform}-`));
      const py: string[] = [];
      for (const [path, content] of Object.entries(project.files)) {
        const text = typeof content === 'string' ? content : content.toString('latin1');
        expect(text, path).not.toContain(PLANTED_SECRET);
        if (/\.(ts|js)$/.test(path))
          expect(
            () => transformSync(text, { loader: path.endsWith('.ts') ? 'ts' : 'js', format: 'esm' }),
            path,
          ).not.toThrow();
        if (path.endsWith('.json')) expect(() => JSON.parse(text), path).not.toThrow();
        if (/\.ya?ml$/.test(path))
          for (const doc of parseAllDocuments(text)) expect(doc.errors, path).toEqual([]);
        if (path.endsWith('.py')) {
          mkdirSync(dirname(join(dir, path)), { recursive: true });
          writeFileSync(join(dir, path), text);
          py.push(join(dir, path));
        }
      }
      if (py.length && hasPython)
        expect(() => execFileSync('python3', ['-m', 'py_compile', ...py], { stdio: 'pipe' })).not.toThrow();
      // Linux: StepForge's own helper ships with the project (Appium has no Linux driver).
      expect('tools/stepforge_atspi.py' in project.files).toBe(platform === 'linux' && target !== 'maestro');
      expect(project.warnings.map((w) => w.message)).toContainEqual(
        expect.stringContaining('GitLab CI is not generated'),
      );
      if (platform === 'android') await snapshot(target, project);
    },
    60_000,
  ); // compiles a whole Python project: slow on Windows runners
});

describe('Electron apps (Playwright)', () => {
  it('starts the app from the environment instead of opening a browser', async () => {
    const input = {
      ...KITCHEN_SINK,
      application: { ...KITCHEN_SINK.application, platform: 'electron' as const },
      environment: {
        ...KITCHEN_SINK.environment,
        launch: { appPath: '{{env.region}}/app', args: ['--debug'], env: { NODE_ENV: 'test' } },
      },
    };
    const project = await generate(input, { target: 'playwright-ts', ci: ['github'] });
    const electron = project.files['support/electron.ts'] as string;
    expect(electron).toContain('_electron.launch(');
    expect(electron).toContain('/\\.(c|m)?js$/.test(p)');
    expect(electron).toContain("install it in the app's project");
    expect(electron).toContain('appPath: `${env.region}/app`');
    expect(electron).toContain("import { env } from './config';");
    expect(() => transformSync(electron, { loader: 'ts', format: 'esm' })).not.toThrow();
    const spec = Object.entries(project.files).find(([p]) => p.endsWith('.spec.ts'))![1] as string;
    expect(spec).toContain("from '../../../support/electron';");
    expect(project.files['playwright.config.ts']).toContain("projects: [{ name: 'electron' }]");
    expect(project.files['.github/workflows/stepforge-tests.yml']).toContain(
      'xvfb-run -a npx playwright test',
    );
    expect(project.warnings.map((w) => w.message)).not.toContainEqual(
      expect.stringContaining('_electron.launch()'),
    );
    // Without launch settings, the browser export (with its warning) as before.
    const plain = await generate(
      { ...input, environment: KITCHEN_SINK.environment },
      { target: 'playwright-ts' },
    );
    expect('support/electron.ts' in plain.files).toBe(false);
    expect(plain.warnings.map((w) => w.message)).toContainEqual(
      expect.stringContaining('_electron.launch()'),
    );
  });
});

describe('page objects', () => {
  it.each(['playwright-ts', 'playwright-py', 'cypress-js', 'selenium-py', 'selenium-java'] as TargetId[])(
    '%s',
    async (target) => {
      const project = await generate(KITCHEN_SINK, { target, pom: true });
      await snapshot(target, project, '-pom');
    },
  );
});

describe.skipIf(!hasPython)('generated Python compiles', () => {
  it.each(['playwright-py', 'selenium-py', 'pytest-requests'] as TargetId[])('%s', async (target) => {
    for (const pom of [false, true]) {
      const project = await generate(KITCHEN_SINK, { target, pom });
      const dir = mkdtempSync(join(tmpdir(), `sf-py-${target}-`));
      const py: string[] = [];
      for (const [path, content] of Object.entries(project.files)) {
        mkdirSync(dirname(join(dir, path)), { recursive: true });
        writeFileSync(join(dir, path), content);
        if (path.endsWith('.py')) py.push(join(dir, path));
      }
      expect(() => execFileSync('python3', ['-m', 'py_compile', ...py], { stdio: 'pipe' })).not.toThrow();
    }
  });
});

describe.skipIf(!hasBash)('generated shell script', () => {
  it('passes bash -n', async () => {
    const project = await generate(KITCHEN_SINK, { target: 'curl' });
    const dir = mkdtempSync(join(tmpdir(), 'sf-sh-'));
    writeFileSync(join(dir, 'requests.sh'), project.files['requests.sh']!);
    expect(() => execFileSync('bash', ['-n', join(dir, 'requests.sh')], { stdio: 'pipe' })).not.toThrow();
  });
});

describe('Excel test cases and zip', () => {
  it('writes one row per test case with plain-English steps and the author', async () => {
    const project = await generate(KITCHEN_SINK, { target: 'docs-xlsx' });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(project.files['shopdesk-test-cases.xlsx'] as never);
    const ws = wb.getWorksheet('Test cases')!;
    expect(ws.rowCount).toBe(1 + 2 + 1 + 1 + 1 + 1);
    expect(ws.getRow(2).getCell(1).value).toBe('TC-CHE-001');
    expect(String(ws.getRow(2).getCell(8).value)).toContain('1. Do “Sign in as admin”:');
    expect(String(ws.getRow(2).getCell(9).value)).toBe('user = ana@shop.test; qty = 2');
    expect(wb.creator).toBe('Md Zarin Tasnim');
    expect(wb.getWorksheet('About')!.getRow(6).values).toEqual([
      undefined,
      'Generated by',
      'Generated by StepForge — by Md Zarin Tasnim',
    ]);
  });

  it('zips a project inside a folder', async () => {
    const project = await generate(KITCHEN_SINK, { target: 'playwright-ts' });
    const zip = await JSZip.loadAsync(await zipProject(project, 'shopdesk-playwright'));
    expect(Object.keys(zip.files)).toContain('shopdesk-playwright/playwright.config.ts');
    expect(await zip.file('shopdesk-playwright/README.md')!.async('string')).toContain(
      'Generated by StepForge — by Md Zarin Tasnim',
    );
  });
});

/** Runs Python code with the runtime helpers importable (Faker stubbed: it is not needed here). */
const python = (code: string) =>
  execFileSync(
    'python3',
    [
      '-I',
      '-c',
      `import sys, types\nsys.modules['faker'] = types.SimpleNamespace(Faker=lambda: None)\nsys.path.insert(0, ${JSON.stringify(join(import.meta.dirname, '../runtime/py'))})\n${code}`,
    ],
    { encoding: 'utf8' },
  ).trim();

describe('text and names that once broke the exports', () => {
  const targets = ALL.filter((t) => t !== 'docs-xlsx');
  const projects = new Map<TargetId, Promise<GeneratedProject>>(
    targets.map((t) => [t, generate(HOSTILE, { target: t, ci: ['github', 'gitlab'] })]),
  );
  const files = async (target: TargetId) => (await projects.get(target)!).files as Record<string, string>;
  const file = async (target: TargetId, path: string) => {
    const f = await files(target);
    expect(Object.keys(f), path).toContain(path);
    return f[path]!;
  };

  it.each(targets)('%s stays valid code', async (target) => {
    const dir = mkdtempSync(join(tmpdir(), `sf-hostile-${target}-`));
    const py: string[] = [];
    for (const [path, text] of Object.entries(await files(target))) {
      if (/\.(ts|js|cjs)$/.test(path) && !path.endsWith('find.js'))
        expect(
          () => transformSync(text, { loader: path.endsWith('.ts') ? 'ts' : 'js', format: 'esm' }),
          path,
        ).not.toThrow();
      if (path.endsWith('.json')) expect(() => JSON.parse(text), path).not.toThrow();
      if (/\.ya?ml$/.test(path))
        for (const doc of parseAllDocuments(text)) expect(doc.errors, path).toEqual([]);
      // Comments and headers stay on their line (the description has \n, \r\n and U+2028 in it).
      if (/\.(ts|js|py|java|ya?ml|sh)$/.test(path))
        expect(text, path).not.toMatch(/^\s*(line two|line three|four|done|now)\b/m);
      if (path.endsWith('.py')) {
        mkdirSync(dirname(join(dir, path)), { recursive: true });
        writeFileSync(join(dir, path), text);
        py.push(join(dir, path));
        // Before Python 3.12 an f-string expression cannot hold its own quote, a backslash or a #.
        for (const m of text.matchAll(/\bf"((?:[^"\\]|\\.)*)"/g))
          for (const expr of m[1]!.matchAll(/\{([^{}]*)\}/g)) expect(expr[1], path).not.toMatch(/["\\#]/);
      }
      if (path.endsWith('.sh') && hasBash)
        expect(() => execFileSync('bash', ['-n', '-c', text], { stdio: 'pipe' }), path).not.toThrow();
    }
    if (py.length && hasPython)
      expect(() => execFileSync('python3', ['-m', 'py_compile', ...py], { stdio: 'pipe' })).not.toThrow();
  });

  it('writes one test file per scenario, even when names read the same or have no Latin letters', async () => {
    const tests = (f: Record<string, string>, re: RegExp) =>
      Object.keys(f)
        .filter((p) => re.test(p))
        .sort();
    expect(tests(await files('playwright-ts'), /\.spec\.ts$/)).toEqual([
      'tests/class/new.spec.ts',
      'tests/default/save-order.spec.ts',
      'tests/default/save-order2.spec.ts',
      'tests/default/save-order3.spec.ts',
      'tests/module/scenario.spec.ts',
      'tests/module/scenario2.spec.ts',
    ]);
    expect(tests(await files('playwright-py'), /\/test_[^/]+\.py$/)).toEqual([
      'tests/class/test_new.py',
      'tests/default/test_save_order.py',
      'tests/default/test_save_order2.py',
      'tests/default/test_save_order3.py',
      'tests/module/test_scenario.py',
      'tests/module/test_scenario2.py',
    ]);
    expect(tests(await files('cypress-js'), /\.cy\.js$/)).toHaveLength(6);
    expect(tests(await files('selenium-java'), /tests\/.*Test\d*\.java$/)).toHaveLength(6);
  });

  it('keeps Java keywords out of package and method names, and \\u out of comments', async () => {
    const cls = await file('selenium-java', 'src/test/java/tests/class_/NewTest.java');
    expect(cls).toContain('package tests.class_;');
    expect(cls).toContain('void new_() throws Exception {');
    const save = await file('selenium-java', 'src/test/java/tests/default_/SaveOrderTest.java');
    expect(save).toContain('package tests.default_;');
    expect(save).toContain('// Preconditions: C:\\\\users\\new done');
    expect(save).toContain('// Create C:\\\\users\\new order');
    // javac reads \u everywhere: every one left must be a real escape or have an even run of backslashes before it.
    expect(save).not.toMatch(/(?<!\\)(\\\\)*\\u(?![0-9a-fA-F]{4})/);
  });

  it('writes vars[...] for variable names that are not identifiers', async () => {
    for (const [target, path] of [
      ['playwright-ts', 'tests/default/save-order.spec.ts'],
      ['cypress-js', 'cypress/e2e/default/save-order.cy.js'],
      ['k6', 'script.js'],
    ] as const) {
      const code = await file(target, path);
      expect(code, target).toContain("vars['order-id'] = 7;");
      expect(code, target).toContain("vars['my var'] = data.qty;");
      expect(code, target).toContain("vars['res-body'] =");
      expect(code, target).not.toMatch(/vars\.(order-id|my var|res-body)/);
    }
  });

  it('quotes CI values as YAML strings, keeping #, :, quotes, backslashes and line breaks', async () => {
    const note = 'a #b: c\\d\ne $HOME';
    const gh = parse(await file('playwright-ts', '.github/workflows/stepforge-tests.yml'));
    expect(gh.name).toBe('Odd: "Shop" #1 tests');
    expect(gh.jobs.tests.env.NOTE).toBe(`\${{ vars.NOTE || '${note}' }}`);
    expect(gh.jobs.tests.env.TAG).toBe("${{ vars.TAG || 'red #1' }}");
    // GitLab expands $ in variables; $$ is a literal $.
    const gl = parse(await file('playwright-ts', '.gitlab-ci.yml'));
    expect(gl.tests.variables.NOTE).toBe(note.split('$').join('$$'));
    expect(gl.tests.variables.TAG).toBe('red #1');
    const native = await generate(
      { ...NATIVE_APP, application: { ...NATIVE_APP.application, name: 'Care: #1' } },
      { target: 'appium-py', ci: ['github'] },
    );
    expect(parse(native.files['.github/workflows/stepforge-tests.yml'] as string).name).toBe(
      'Care: #1 tests (Android)',
    );
  });

  it('quotes .env.example values that a " #" or the shell would change', async () => {
    const env = await file('playwright-ts', '.env.example');
    expect(env).toContain("TAG='red #1'");
    expect(env).toContain('NOTE="a #b: c\\\\d\\ne $HOME"');
    expect(env).toContain("BASE_URL='https://odd.test/$(touch pwned)`id`\"'");
  });

  it('escapes SQL ending in a quote, and CR, in multi-line strings', () => {
    const sql = 'SELECT 1\nFROM t\r\nWHERE a = "x"';
    expect(javaBlock(sql)).toBe('"""\nSELECT 1\nFROM t\\r\nWHERE a = \\"x\\""""');
    if (hasPython) {
      expect(python(`print(repr(${pyBlock(sql)}))`)).toBe(`'SELECT 1\\nFROM t\\r\\nWHERE a = "x"'`);
      const v = parseString('a\r"{{vars.x}}"');
      expect(python(`text = str\nvars = {'x': 1}\nprint(repr(${pyVal(v)}))`)).toBe(`'a\\r"1"'`);
    }
    expect(new Function('vars', `return ${jsVal(parseString('a\r`{{vars.x}}'))};`)({ x: 1 })).toBe('a\r`1');
  });

  it('joins references whose names need quotes with +, not inside an f-string; the auth header too', async () => {
    const code = await file('pytest-requests', 'tests/default/test_save_order.py');
    expect(code).toContain('"x-note": ("n=" + text(data.get("it\'s")) + "!")');
    expect(code).toContain('"Authorization": "Bearer " + secret("API_TOKEN")');
  });

  it('compares a status code as StepForge does: "201" is 201, a placeholder goes through check()', async () => {
    const pw = await file('playwright-ts', 'tests/default/save-order.spec.ts');
    expect(pw).toContain("expect(res1.status, 'status').toBe(201);");
    expect(pw).toContain("check(pick(res1, 'status'), 'equals', data.status, 'status equals');");
    expect(await file('cypress-js', 'cypress/e2e/default/save-order.cy.js')).toContain(
      "expect(res.status, 'status').to.eq(201);",
    );
    const py = await file('pytest-requests', 'tests/default/test_save_order.py');
    expect(py).toContain('assert res1["status"] == 201, "status"');
    expect(py).toContain('check(pick(res1, "status"), "equals", data.get("status"), "status equals")');
    const java = await file('rest-assured', 'src/test/java/tests/default_/SaveOrderTest.java');
    expect(java).toContain('assertEquals(201, res1.status(), "status");');
    expect(java).toContain('check(pick(res1, "status"), "equals", data.get("status"), "status equals");');
    const sh = await file('curl', 'requests.sh');
    expect(sh).toContain('expect_status "${DATA_STATUS}"');
    expect(sh).not.toContain('{{data.status}}');
  });

  it('sends numbers as numbers and adds query parameters with & when the URL has a ?', async () => {
    const pm = JSON.parse(await file('postman', 'odd.postman_collection.json'));
    const req = pm.item[0].item[0].item[0].request;
    expect(req.url).toBe('{{baseUrl}}/orders?x=1&a%20b=c%26d&n={{qty}}');
    expect(req.body.raw).toContain('"qty": {{qty}}');
    const k6 = await file('k6', 'script.js');
    expect(k6).toContain("withQuery(url('/orders?x=1'), `a%20b=${encodeURIComponent('c&d')}");
    const sh = await file('curl', 'requests.sh');
    expect(sh).toContain('--argjson a0 "${DATA_QTY}" --argjson a1 "$(json who)"');
    expect(sh).toContain("save order_id '7'");
  });

  it.skipIf(!hasBash)(
    'quotes the cURL script for bash: nothing in a name or default value runs',
    async () => {
      const sh = await file('curl', 'requests.sh');
      expect(sh).toContain("scenario 'Save order'");
      const start = sh.indexOf('[ -n "${BASE_URL:-}" ]');
      const defaults = sh.slice(start, sh.indexOf('API_TOKEN=', start));
      const out = execFileSync('bash', ['-c', `set -u\n${defaults}\nprintf '%s|%s' "$BASE_URL" "$NOTE"`], {
        encoding: 'utf8',
        env: { PATH: process.env.PATH ?? '' },
      });
      expect(out).toBe('https://odd.test/$(touch pwned)`id`"|a #b: c\\d\ne $HOME');
    },
  );

  it('defaults generated data to a name, as StepForge does', () => {
    const gen = buildPlan(HOSTILE).tests[0]!.ops.find((o) => o.op === 'gen');
    expect(gen && 'kind' in gen && gen.kind).toBe('name');
  });
});

describe('Maestro conditions', () => {
  it('exports gt, lt, gte, lte and matches', async () => {
    const step = (operator: string) => ({
      type: 'util.if',
      params: { condition: { value: '{{data.n}}', operator, expected: 2 }, steps: [] },
      locators: [],
      assertions: [],
    });
    const project = await generate(
      {
        ...NATIVE_APP,
        scenarios: [
          {
            ...NATIVE_APP.scenarios[0]!,
            testCases: [],
            steps: ['gt', 'lt', 'gte', 'lte', 'matches'].map(step),
          },
        ],
      },
      { target: 'maestro' },
    );
    const flow = Object.entries(project.files).find(
      ([p]) => p.startsWith('flows/') && !p.includes('steps'),
    )![1] as string;
    expect(flow).toContain('true: ${Number(String(n)) > Number(2)}');
    expect(flow).toContain('true: ${Number(String(n)) <= Number(2)}');
    expect(flow).toContain('true: ${new RegExp(2).test(String(String(n)))}');
    expect(flow).not.toContain('not exported to Maestro');
  });
});

describe('runtime helpers', () => {
  const body = {
    items: [
      { id: 1, p: 5 },
      { id: 2, p: 15, name: 'two' },
      { id: '3', p: 9 },
    ],
  };
  const res = { status: 201, headers: { 'x-trace': 'abc' }, body, text: '', ms: 42, size: 0 };

  it('JSONPath filters and slices, and timeMs / headers.X targets (TypeScript)', () => {
    expect(jsonPath(body, '$.items[?(@.id==2)].name')).toEqual(['two']);
    expect(jsonPath(body, "$.items[?(@.id=='3')].p")).toEqual([9]);
    expect(jsonPath(body, '$.items[?(@.p<10)].id')).toEqual([1, '3']);
    expect(jsonPath(body, '$.items[?(@.p>=15)].id')).toEqual([2]);
    expect(jsonPath(body, '$.items[?(@.id!=1)].id')).toEqual([2, '3']);
    expect(jsonPath(body, '$.items[?(@.name)].id')).toEqual([2]);
    expect(jsonPath(body, '$.items[0:1].id')).toEqual([1]);
    expect(jsonPath(body, '$.items[-1:].id')).toEqual(['3']);
    expect(pick(res, 'timeMs')).toBe(42);
    expect(pick(res, 'headers.X-Trace')).toBe('abc');
  });

  it.skipIf(!hasPython)('the same in Python, with 1 == 1.0 == Decimal("1")', () => {
    const out = python(
      [
        'import json',
        'from decimal import Decimal',
        'import helpers as h',
        `body = json.loads(${JSON.stringify(JSON.stringify(body))})`,
        'res = {"status": 201, "headers": {"x-trace": "abc"}, "body": body, "text": "", "ms": 42, "size": 0}',
        'print(json.dumps([',
        '  h.json_path(body, "$.items[?(@.id==2)].name"),',
        '  h.json_path(body, "$.items[?(@.id==\'3\')].p"),',
        '  h.json_path(body, "$.items[?(@.p<10)].id"),',
        '  h.json_path(body, "$.items[0:1].id"),',
        '  h.json_path(body, "$.items[-1:].id"),',
        '  h.pick(res, "timeMs"),',
        '  h.pick(res, "headers.X-Trace"),',
        '  h.compare(1, "equals", 1.0),',
        '  h.compare(Decimal("10"), "equals", 10),',
        '  h.compare(True, "equals", 1),',
        '  h.compare(Decimal("2.50"), "equals", "2.5"),',
        ']))',
      ].join('\n'),
    );
    expect(JSON.parse(out)).toEqual([['two'], [9], [1, '3'], [1], ['3'], 42, 'abc', true, true, false, true]);
  });

  it.skipIf(!hasPython)('Python DB helper: no parameters means no % formatting; $N binds by number', () => {
    const out = python(
      [
        'import json, db',
        'print(json.dumps([',
        `  db._prepare("SELECT '50%'", [], "pg"),`,
        `  db._prepare("SELECT $2, $1, $2 WHERE a LIKE '5%'", ["a", "b"], "pg"),`,
        `  db._prepare("SELECT ?, '?', $1", [1], "mysql"),`,
        `  db._prepare("SELECT ?, $2", [1, 2], "sqlite"),`,
        `  db._prepare("SELECT x ? 'k', $1", [5], "pg"),`,
        ']))',
      ].join('\n'),
    );
    expect(JSON.parse(out)).toEqual([
      ["SELECT '50%'", null],
      ["SELECT %s, %s, %s WHERE a LIKE '5%%'", ['b', 'a', 'b']],
      ["SELECT %s, '?', %s", [1, 1]],
      ['SELECT ?, ?', [1, 2]],
      ["SELECT x ? 'k', %s", [5]],
    ]);
  });
});
