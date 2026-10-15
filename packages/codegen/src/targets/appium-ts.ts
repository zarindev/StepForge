import { CREDIT, day, envExample, headerLines, readme, runtime, testPath } from '../common.ts';
import type { Plan, TestPlan } from '../ir.ts';
import { jsJson, jsKey, jsStr, jsVal } from '../lang/js.ts';
import {
  APP_KEY,
  capabilities,
  driverSetup,
  GITLAB_NATIVE,
  linuxHelper,
  nativeCi,
  nativeNotes,
  PLATFORM_NAMES,
} from '../native.ts';
import type { CodegenOptions, GeneratedProject } from '../types.ts';
import { envName, kebab } from '../values.ts';
import { needs, printOps, usedHelpers, type State } from './playwright-ts.ts';

/**
 * Appium + WebdriverIO (TypeScript, Mocha): phone and desktop apps. Steps are printed by the Playwright generator's
 * printer in its Appium flavour; the app part goes through support/app.ts.
 */
const DEPS = {
  webdriverio: '^9.20.0',
  mocha: '^11.7.0',
  tsx: '^4.20.0',
  typescript: '^5.9.0',
  '@types/mocha': '^10.0.10',
  '@types/node': '^22.0.0',
  '@faker-js/faker': '^10.0.0',
  dotenv: '^17.0.0',
};

function specFile(plan: Plan, t: TestPlan, path: string): string {
  const up = '../'.repeat(path.split('/').length - 1);
  const n = needs(t);
  const s: State = {
    flavor: 'appium',
    lines: [],
    pageVar: 'app',
    root: 'app',
    n: {},
    usesUi: t.usesUi,
    pomVars: new Map(),
    imports: new Set(),
  };
  printOps(t.ops, s, '    ');
  const body = s.lines.join('\n');
  const cases = t.scenario.testCases;
  const dataUsed = /(?<![.\w])data\.|\(data[,)]|, data\)/.test(body.replace(/\/\/.*$/gm, ''));
  const helpers = usedHelpers(body);
  const config = [
    ...(t.usesUi ? ['APPIUM_URL', 'CAPABILITIES', 'PLATFORM'] : []),
    ...['env', 'secret'].filter((x) => new RegExp(`\\b${x}\\b`).test(body)),
  ];
  // Mocha has no tags: they go in the title, so `npx mocha --grep @smoke` picks them.
  const tags = [...t.scenario.tags.map((x) => `@${kebab(x)}`), `@${t.scenario.priority.toLowerCase()}`].join(
    ' ',
  );
  const title = [...t.scenario.modulePath, t.scenario.name].join(' › ');
  const head = [
    ...headerLines(plan.input, t.scenario).map((l) => `// ${l}`),
    ...(t.usesUi ? [`import { startApp, type App } from '${up}support/app';`] : []),
    ...(config.length ? [`import { ${config.join(', ')} } from '${up}support/config';`] : []),
    ...(helpers.length ? [`import { ${helpers.join(', ')} } from '${up}support/helpers';`] : []),
    ...(n.api
      ? [`import { api${/basicAuth\(/.test(body) ? ', basicAuth' : ''} } from '${up}support/api';`]
      : []),
    ...(n.db ? [`import * as db from '${up}support/db';`] : []),
    ...(n.mail ? [`import * as mail from '${up}support/mail';`] : []),
    '',
    'type Vars = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any',
    '',
  ];
  const testBody = [
    ...(n.mail ? ['    const testStart = new Date();'] : []),
    '    const vars: Vars = {};',
    ...s.lines,
  ];
  const hooks = t.usesUi
    ? [
        '  let app: App;',
        '  beforeEach(async () => {',
        '    app = await startApp(APPIUM_URL, CAPABILITIES, PLATFORM);',
        '  });',
        '  afterEach(async function () {',
        '    await app?.end(this.currentTest);',
        '  });',
        '',
      ]
    : [];
  if (cases.length)
    return [
      ...head,
      'const testCases: { code: string; title: string; data: Vars }[] = [',
      ...cases.map((c) => `  { code: ${jsStr(c.code)}, title: ${jsStr(c.title)}, data: ${jsJson(c.data)} },`),
      '];',
      '',
      `describe(${jsStr(title)}, function () {`,
      ...hooks,
      '  for (const { code, title, data } of testCases) {',
      `    it(\`\${code} \${title} ${tags}\`, async () => {`,
      ...testBody.map((l) => (l ? `  ${l}` : l)),
      '    });',
      '  }',
      '});',
      '',
    ].join('\n');
  return [
    ...head,
    `describe(${jsStr(title)}, function () {`,
    ...hooks,
    `  it(${jsStr(`${t.scenario.name} ${tags}`)}, async () => {`,
    ...(dataUsed ? ['    const data: Vars = {};'] : []),
    ...testBody,
    '  });',
    '});',
    '',
  ].join('\n');
}

function configFile(plan: Plan): string {
  const { input } = plan;
  const platform = plan.native!;
  const key = jsStr(APP_KEY[platform]);
  return [
    `// ${CREDIT}`,
    "import 'dotenv/config';",
    "import { existsSync } from 'node:fs';",
    "import { resolve } from 'node:path';",
    "import type { Platform } from './app';",
    '',
    '/** Environment variables; defaults come from the exported environment. */',
    'export const env: Record<string, string> & { baseUrl: string } = {',
    `  baseUrl: process.env.BASE_URL ?? ${jsStr(input.environment.baseUrl)},`,
    ...plan.variables.map(
      (v) => `  ${jsKey(v)}: process.env.${envName(v)} ?? ${jsStr(input.environment.variables[v] ?? '')},`,
    ),
    '};',
    '',
    '/** A secret from the environment (.env locally, CI secrets in pipelines). Never stored in the code. */',
    'export function secret(name: string): string {',
    '  const value = process.env[name];',
    '  if (!value) throw new Error(`Set the ${name} environment variable (see .env.example)`);',
    '  return value;',
    '}',
    '',
    `/** ${PLATFORM_NAMES[platform]}: the capabilities StepForge starts the app with (from the ${input.environment.name} environment). */`,
    `export const PLATFORM: Platform = ${jsStr(platform)};`,
    "export const APPIUM_URL = process.env.APPIUM_URL ?? 'http://127.0.0.1:4723';",
    `export const CAPABILITIES: Record<string, unknown> = ${jsVal(capabilities(platform, input.environment.launch))};`,
    `if (process.env.APP) CAPABILITIES[${key}] = process.env.APP;`,
    `const app = CAPABILITIES[${key}];`,
    `if (typeof app === 'string' && app && existsSync(app)) CAPABILITIES[${key}] = resolve(app);`,
    '',
  ].join('\n');
}

export function generateAppiumTs(plan: Plan, o: CodegenOptions): GeneratedProject {
  const files: Record<string, string> = {};
  const warnings = [...plan.warnings];
  const platform = plan.native!;
  const slug = kebab(plan.input.application.slug || plan.input.application.name);
  for (const t of plan.tests) {
    const path = testPath(t, (b) => `${b}.test.ts`);
    files[path] = specFile(plan, t, path);
  }
  const engines = new Set(plan.tests.flatMap((t) => t.ops.flatMap((x) => (x.op === 'db' ? [x.engine] : []))));
  const any = engines.has('any');
  files['package.json'] = `${JSON.stringify(
    {
      name: `${slug}-appium-tests`,
      private: true,
      type: 'module',
      description: `${plan.input.application.name} tests (${PLATFORM_NAMES[platform]}). ${CREDIT}.`,
      scripts: { test: 'mocha' },
      devDependencies: {
        ...DEPS,
        ...((any || engines.has('pg')) && { pg: '^8.16.0', '@types/pg': '^8.15.0' }),
        ...((any || engines.has('mysql')) && { mysql2: '^3.14.0' }),
        ...((any || engines.has('sqlite')) && {
          'better-sqlite3': '^12.0.0',
          '@types/better-sqlite3': '^7.6.13',
        }),
      },
    },
    null,
    2,
  )}\n`;
  files['.mocharc.json'] = `${JSON.stringify(
    {
      spec: 'tests/**/*.test.ts',
      import: 'tsx',
      // A test starts the app, and the first one builds or installs the driver's helper app: allow minutes.
      timeout: 600_000,
      reporter: 'spec',
    },
    null,
    2,
  )}\n`;
  files['tsconfig.json'] = `${JSON.stringify(
    {
      compilerOptions: {
        target: 'ES2022',
        module: 'ESNext',
        moduleResolution: 'Bundler',
        strict: true,
        esModuleInterop: true,
        skipLibCheck: true,
        types: ['node', 'mocha'],
      },
    },
    null,
    2,
  )}\n`;
  files['.env.example'] = envExample(plan);
  files['.gitignore'] = ['node_modules/', '.env', 'results/', 'screenshots/', ''].join('\n');
  files['support/config.ts'] = configFile(plan);
  files['support/app.ts'] = runtime('ts/app.ts');
  files['support/helpers.ts'] = runtime('ts/helpers.ts');
  if (plan.tests.some((t) => needs(t).api)) files['support/api.ts'] = runtime('ts/api-fetch.ts');
  if (plan.tests.some((t) => needs(t).db)) files['support/db.ts'] = runtime('ts/db.ts');
  if (plan.tests.some((t) => needs(t).mail)) files['support/mail.ts'] = runtime('ts/mail.ts');
  if (platform === 'linux') files['tools/stepforge_atspi.py'] = linuxHelper();
  Object.assign(files, plan.sqlFiles);
  Object.assign(
    files,
    nativeCi(
      plan,
      platform,
      {
        setup: [
          '      - uses: actions/setup-node@v4',
          '        with:',
          '          node-version: 22',
          '      - run: npm install',
        ],
        test: 'npm test',
      },
      o.ci,
      platform !== 'linux',
    ),
  );
  if (o.ci?.includes('gitlab')) warnings.push(GITLAB_NATIVE);
  files['README.md'] = readme(
    { ...plan, warnings },
    {
      title: `Appium tests (WebdriverIO + Mocha, TypeScript) — ${PLATFORM_NAMES[platform]}`,
      install: ['npm install', ...driverSetup(platform)],
      run: ['npm test                         # all tests', 'npx mocha --grep @smoke         # one tag'],
      layout: [
        '`tests/` — one file per scenario, grouped by module; one test per test case',
        '`support/` — configuration (environment variables, secrets, Appium capabilities) and helpers; `app.ts` does each step as StepForge does',
        ...(platform === 'linux' ? ["`tools/` — StepForge's Linux helper"] : []),
        ...(Object.keys(plan.sqlFiles).length ? ['`sql/` — the SQL of each database step'] : []),
      ],
      notes: [
        ...nativeNotes(platform),
        `Exported on ${day(plan.input)}; re-export from StepForge after changing the scenarios.`,
      ],
    },
  );
  return { target: 'appium-ts', files, warnings, run: 'npm install && npm test' };
}
