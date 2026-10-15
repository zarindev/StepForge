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
import { camel, envName, parseString, snake, val } from '../src/values.ts';
import { parseAllDocuments } from 'yaml';
import { KITCHEN_SINK, NATIVE_APP, PLANTED_SECRET } from './fixtures.ts';

const hasPython = spawnSync('python3', ['--version']).status === 0;
const hasBash = spawnSync('bash', ['--version']).status === 0;

const RUNTIME =
  /(^|\/)support\/(helpers|api|db|mail|tabs|browser|app)\.(ts|py)$|find\.js$|support\/(Checks|J|Api|Fake|Db|Mail|Browser|App)\.java$|cypress\/support\/(helpers|mail)\.js$|cypress\/plugins\/.*\.cjs$|tools\/stepforge_atspi\.py$/;

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
        'auth type "oauth2" is not exported; set the header yourself',
        'the JSON Schema check on "$" is not exported',
        'MongoDB steps are not exported; use the MongoDB driver of the target language',
        'SQL Server helpers are not generated; the SQL file is exported for reference',
        'the data-quality audit runs only in StepForge',
        'IMAP inboxes are not exported; the helper reads a Mailpit server (MAILPIT_URL)',
        'performance measurements run only in StepForge',
        'load tests are not part of functional tests; export the scenario to k6 instead',
        expect.stringContaining('the "unknown" connection is not set up'),
        '“repeat while” loops are not exported yet; write the loop by hand',
        'page conditions (if the element is …) are not exported yet; write the check by hand',
      ]),
    );
    // Page objects: grouped by page, steps after a tab switch or inside a frame stay inline.
    expect([...plan.pages.keys()]).toEqual(['Login', 'Products']);
    expect(plan.pages.get('Login')!.elements.map((e) => e.name)).toEqual([
      'emailField',
      'passwordField',
      'signInButton',
    ]);
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
  it.each(cases)('%s on %s: valid code, no secret value', async (target, platform) => {
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
  });
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
    expect(ws.rowCount).toBe(1 + 2 + 1 + 1);
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
