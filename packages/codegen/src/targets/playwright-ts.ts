import { CREDIT, ciFiles, day, envExample, headerLines, readme, runtime, testPath } from '../common.ts';
import type { El, Loc, Op, Plan, TestPlan } from '../ir.ts';
import { jsNum, jsBlock, jsJson, jsKey, jsStr, jsText, jsVal } from '../lang/js.ts';
import type { CodegenOptions, GeneratedProject } from '../types.ts';
import { camel, envName, kebab, parseString, val } from '../values.ts';

/** Playwright Test (TypeScript): UI with locators or page objects, API through the request fixture, DB and email helpers. */

const DEPS = {
  '@playwright/test': '^1.63.0',
  '@faker-js/faker': '^10.0.0',
  '@types/node': '^22.0.0',
  dotenv: '^17.0.0',
};

export function locatorTs(root: string, l: Loc): string {
  const v = (s: string) => jsText(parseString(s));
  switch (l.strategy) {
    case 'testId':
      return `${root}.getByTestId(${v(l.value)})`;
    case 'role':
      return l.name
        ? `${root}.getByRole(${jsStr(l.value)}, { name: ${v(l.name)}, exact: true })`
        : `${root}.getByRole(${jsStr(l.value)})`;
    case 'label':
      return `${root}.getByLabel(${v(l.value)}, { exact: true })`;
    case 'placeholder':
      return `${root}.getByPlaceholder(${v(l.value)}, { exact: true })`;
    case 'text':
      return `${root}.getByText(${v(l.value)}, { exact: true })`;
    case 'xpath':
      return `${root}.locator(${v(`xpath=${l.value}`)})`;
    default:
      return `${root}.locator(${v(l.value)})`;
  }
}

export type State = {
  /** Playwright (browser), or Appium through WebdriverIO (phone and desktop apps, see appium-ts.ts). */
  flavor?: 'playwright' | 'appium';
  lines: string[];
  pageVar: string;
  root: string;
  n: Record<string, number>;
  lastApi?: string;
  lastDb?: string;
  lastMail?: string;
  usesUi: boolean;
  pomVars: Map<string, string>;
  imports: Set<string>;
};

export const next = (s: State, k: string) => `${k}${(s.n[k] = (s.n[k] ?? 0) + 1)}`;

function loc(s: State, e: El): string {
  if (e.pom && s.root === s.pageVar) {
    const v = `${camel(e.pom.page)}Page`;
    s.pomVars.set(e.pom.page, v);
    return `${v}.${e.pom.name}`;
  }
  return locatorTs(s.root, e.loc);
}

const ASSERT: Record<string, (l: string, e: string, attr?: string) => string> = {
  visible: (l) => `${l}).toBeVisible()`,
  hidden: (l) => `${l}).toBeHidden()`,
  text: (l, e) => `${l}).toHaveText(${e})`,
  textContains: (l, e) => `${l}).toContainText(${e})`,
  textMatches: (l, e) => `${l}).toHaveText(new RegExp(${e}))`,
  value: (l, e) => `${l}).toHaveValue(${e})`,
  count: (l, e) => `${l}).toHaveCount(${e})`,
  attribute: (l, e, a) => `${l}).toHaveAttribute(${jsStr(a ?? '')}, ${e})`,
  enabled: (l) => `${l}).toBeEnabled()`,
  disabled: (l) => `${l}).toBeDisabled()`,
  checked: (l) => `${l}).toBeChecked()`,
  unchecked: (l) => `${l}).not.toBeChecked()`,
  url: (l, e) => `${l}).toHaveURL(${e})`,
  urlContains: (l, e) => `${l}).toHaveURL(containing(${e}))`,
  urlMatches: (l, e) => `${l}).toHaveURL(new RegExp(${e}))`,
  title: (l, e) => `${l}).toHaveTitle(${e})`,
  titleContains: (l, e) => `${l}).toHaveTitle(containing(${e}))`,
};

/** Appium selectors as [strategy, value] pairs for support/app.ts. */
export const queriesTs = (e: El) =>
  `[${(e.queries ?? []).map((q) => `[${jsStr(q.using)}, ${jsText(parseString(q.value))}]`).join(', ')}]`;

/** Phone and desktop-app steps (WebdriverIO + support/app.ts); false for the steps shared with the web. */
function appiumOp(op: Op, out: (line: string) => void): boolean {
  const q = queriesTs;
  switch (op.op) {
    case 'act': {
      const v = op.value ? jsText(op.value) : "''";
      const call: Record<string, string> = {
        click: `click(${q(op.el)})`,
        dblclick: `doubleClick(${q(op.el)})`,
        fill: `fill(${q(op.el)}, ${v})`,
        type: `type(${q(op.el)}, ${v})`,
        clear: `clear(${q(op.el)})`,
        check: `setChecked(${q(op.el)}, true)`,
        uncheck: `setChecked(${q(op.el)}, false)`,
        scrollIntoView: `scrollTo(${q(op.el)})`,
      };
      out(
        call[op.action]
          ? `await app.${call[op.action]};`
          : `// TODO(StepForge): ${op.action} is not available in phone and desktop apps`,
      );
      return true;
    }
    case 'press':
      out(`await app.press(${jsStr(op.key)}${op.el ? `, ${q(op.el)}` : ''});`);
      return true;
    case 'assert': {
      const args = [
        jsStr(op.check),
        op.el ? q(op.el) : '[]',
        ...(op.expected || op.attribute
          ? [op.expected ? (op.check === 'count' ? jsNum(op.expected) : jsText(op.expected)) : 'undefined']
          : []),
        ...(op.attribute ? [jsStr(op.attribute)] : []),
      ];
      out(`await app.expect(${args.join(', ')});`);
      return true;
    }
    case 'read': {
      const value = `await app.read(${jsStr(op.source)}, ${op.el ? q(op.el) : '[]'}${op.attribute ? `, ${jsStr(op.attribute)}` : ''})`;
      out(`vars.${op.into} = ${op.regex ? `capture(String(${value}), ${jsStr(op.regex)})` : value};`);
      return true;
    }
    case 'waitFor':
      out(`await app.waitFor(${q(op.el)}, ${jsStr(op.state)});`);
      return true;
    case 'screenshot':
      out(`await app.screenshot(${jsStr(op.name)}${op.el ? `, ${q(op.el)}` : ''});`);
      return true;
    case 'app':
      out(`await app.${op.method}(${[...op.els.map(q), ...op.args.map((a) => jsVal(a))].join(', ')});`);
      return true;
    case 'goto':
    case 'select':
    case 'upload':
    case 'drag':
    case 'scroll':
    case 'waitUrl':
    case 'waitLoad':
    case 'dialog':
    case 'frame':
    case 'tab':
    case 'closeTab':
      out(`// TODO(StepForge): ${op.op} is a web-page step; phone and desktop apps have no equivalent`);
      return true;
    default:
      return false;
  }
}

export function printOps(ops: Op[], s: State, ind: string): void {
  const out = (line: string) => s.lines.push(`${ind}${line}`);
  const appium = s.flavor === 'appium';
  for (const op of ops) {
    if (appium && appiumOp(op, out)) continue;
    switch (op.op) {
      case 'comment':
        out(`// ${op.text}`);
        break;
      case 'todo':
        out(`// TODO(StepForge): ${op.text}`);
        break;
      case 'goto':
        out(`await ${s.pageVar}.goto(${jsVal(op.url)});`);
        break;
      case 'act': {
        const l = loc(s, op.el);
        const call: Record<string, string> = {
          click: 'click()',
          dblclick: 'dblclick()',
          rightclick: "click({ button: 'right' })",
          hover: 'hover()',
          clear: 'clear()',
          check: 'check()',
          uncheck: 'uncheck()',
          scrollIntoView: 'scrollIntoViewIfNeeded()',
          fill: `fill(${op.value ? jsText(op.value) : "''"})`,
          type: `pressSequentially(${op.value ? jsText(op.value) : "''"})`,
        };
        out(`await ${l}.${call[op.action]};`);
        break;
      }
      case 'press':
        out(
          op.el
            ? `await ${loc(s, op.el)}.press(${jsStr(op.key)});`
            : `await ${s.pageVar}.keyboard.press(${jsStr(op.key)});`,
        );
        break;
      case 'select': {
        const v =
          op.by === 'index'
            ? `{ index: ${jsNum(op.value)} }`
            : op.by === 'label'
              ? `{ label: ${jsText(op.value)} }`
              : jsText(op.value);
        out(`await ${loc(s, op.el)}.selectOption(${v});`);
        break;
      }
      case 'upload':
        out(`await ${loc(s, op.el)}.setInputFiles([${op.files.map((f) => jsText(f)).join(', ')}]);`);
        break;
      case 'drag':
        out(`await ${loc(s, op.el)}.dragTo(${loc(s, op.to)});`);
        break;
      case 'scroll':
        out(`await ${s.pageVar}.mouse.wheel(${op.x}, ${op.y});`);
        break;
      case 'waitFor':
        out(`await ${loc(s, op.el)}.waitFor({ state: ${jsStr(op.state)} });`);
        break;
      case 'waitUrl':
        out(`await ${s.pageVar}.waitForURL(${jsVal(op.url)});`);
        break;
      case 'waitLoad':
        out(`await ${s.pageVar}.waitForLoadState(${jsStr(op.state)});`);
        break;
      case 'assert': {
        const subject = op.el ? loc(s, op.el) : s.pageVar;
        const e = op.expected ? (op.check === 'count' ? jsNum(op.expected) : jsText(op.expected)) : "''";
        out(`await ${op.soft ? 'expect.soft' : 'expect'}(${ASSERT[op.check]!(subject, e, op.attribute)};`);
        break;
      }
      case 'read': {
        const l = op.el ? loc(s, op.el) : '';
        const read: Record<string, string> = {
          text: `((await ${l}.textContent()) ?? '').trim()`,
          value: `await ${l}.inputValue()`,
          attribute: `await ${l}.getAttribute(${jsStr(op.attribute ?? '')})`,
          count: `await ${l}.count()`,
          url: `${s.pageVar}.url()`,
          title: `await ${s.pageVar}.title()`,
        };
        const value = read[op.source]!;
        out(`vars.${op.into} = ${op.regex ? `capture(${value}, ${jsStr(op.regex)})` : value};`);
        break;
      }
      case 'screenshot':
        out(
          `await ${op.el ? loc(s, op.el) : s.pageVar}.screenshot({ path: test.info().outputPath(${jsStr(`${op.name}.png`)})${!op.el && op.fullPage ? ', fullPage: true' : ''} });`,
        );
        break;
      case 'dialog':
        out(
          `${s.pageVar}.once('dialog', (dialog) => dialog.${op.accept ? `accept(${op.promptText ? jsText(op.promptText) : ''})` : 'dismiss()'});`,
        );
        break;
      case 'frame':
        if (op.selector === null) s.root = s.pageVar;
        else {
          const f = next(s, 'frame');
          out(`const ${f} = ${s.pageVar}.frameLocator(${jsStr(op.selector)});`);
          s.root = f;
        }
        break;
      case 'tab':
        s.imports.add('tabs');
        out(
          `current = await switchTab(page.context()${op.index !== undefined ? `, { index: ${op.index} }` : op.urlContains !== undefined ? `, { urlContains: ${jsStr(op.urlContains)} }` : ''});`,
        );
        s.root = s.pageVar;
        break;
      case 'closeTab':
        out('await current.close();');
        out('current = page.context().pages().at(-1)!;');
        s.root = s.pageVar;
        break;
      case 'api': {
        const r = next(s, 'res');
        const headers: string[] = op.headers.map(([k, v]) => `${jsKey(k)}: ${jsText(v)}`);
        const params: string[] = op.query.map(([k, v]) => `${jsKey(k)}: ${jsVal(v)}`);
        if (op.auth?.type === 'bearer')
          headers.push(`Authorization: \`Bearer \${${jsText(op.auth.token)}}\``);
        if (op.auth?.type === 'basic')
          headers.push(`Authorization: basicAuth(${jsText(op.auth.username)}, ${jsText(op.auth.password)})`);
        if (op.auth?.type === 'apiKey')
          (op.auth.in === 'query' ? params : headers).push(
            `${jsKey(op.auth.name)}: ${jsText(op.auth.value)}`,
          );
        if (op.auth?.type === 'cookie')
          headers.push(`Cookie: \`${op.auth.name}=\${${jsText(op.auth.value)}}\``);
        const i2 = `${ind}  `;
        const body =
          op.body === null || op.bodyType === 'none'
            ? []
            : op.bodyType === 'form'
              ? [`form: ${jsVal(op.body, i2)},`]
              : op.bodyType === 'multipart'
                ? [`multipart: ${jsVal(op.body, i2)},`]
                : op.bodyType === 'raw'
                  ? [`data: ${jsText(op.body)},`]
                  : [`json: ${jsVal(op.body, i2)},`];
        out(appium ? `const ${r} = await api({` : `const ${r} = await api(request, {`);
        out(`  method: ${jsStr(op.method)},`);
        out(`  url: ${jsVal(op.url)},`);
        if (headers.length) out(`  headers: { ${headers.join(', ')} },`);
        if (params.length) out(`  params: { ${params.join(', ')} },`);
        for (const b of body) out(`  ${b}`);
        out('});');
        for (const a of op.asserts) {
          if (a.target === 'status' && a.operator === 'equals' && !appium)
            out(`expect(${r}.status, 'status').toBe(${jsVal(a.expected)});`);
          else
            out(
              `check(pick(${r}, ${jsStr(a.target)}), ${jsStr(a.operator)}, ${jsVal(a.expected)}, ${jsStr(`${a.target} ${a.operator}`)});`,
            );
        }
        if (op.into) out(`vars.${op.into} = ${r}.body;`);
        s.lastApi = r;
        break;
      }
      case 'apiExtract': {
        const target =
          op.from === 'status'
            ? 'status'
            : op.from === 'header'
              ? `header:${op.name ?? ''}`
              : (op.path ?? 'body');
        out(
          s.lastApi
            ? `vars.${op.into} = pick(${s.lastApi}, ${jsStr(target)});`
            : '// TODO(StepForge): api.extract without an earlier request',
        );
        break;
      }
      case 'setVar':
        out(`vars.${op.name} = ${jsVal(op.value, ind)};`);
        break;
      case 'gen':
        out(
          `vars.${op.into} = fake(${jsStr(op.kind)}${Object.keys(op.opts).length ? `, ${jsJson(op.opts)}` : ''});`,
        );
        break;
      case 'wait':
        out(
          s.usesUi && !appium
            ? `await ${s.pageVar}.waitForTimeout(${op.ms});`
            : `await new Promise((resolve) => setTimeout(resolve, ${op.ms}));`,
        );
        break;
      case 'log':
        out(`console.log(${jsVal(op.message)});`);
        break;
      case 'script':
        out(`${op.into ? `vars.${op.into} = ` : ''}await (async (vars: Vars, data: Vars) => {`);
        for (const l of op.code.split('\n')) out(`  ${l}`);
        out('})(vars, data);');
        break;
      case 'if':
        out(`if (compare(${jsVal(op.value)}, ${jsStr(op.operator)}, ${jsVal(op.expected)})) {`);
        printOps(op.then, s, `${ind}  `);
        if (op.else.length) {
          out('} else {');
          printOps(op.else, s, `${ind}  `);
        }
        out('}');
        break;
      case 'loop':
        if (op.over) {
          out(`for (const [index, ${camel(op.as)}] of (${jsVal(op.over)} as unknown[]).entries()) {`);
          out(`  vars.${op.as} = ${camel(op.as)};`);
          out('  vars.index = index;');
        } else {
          out(`for (let index = 0; index < ${jsNum(op.count!)}; index++) {`);
          out('  vars.index = index;');
        }
        printOps(op.body, s, `${ind}  `);
        out('}');
        break;
      case 'check':
        out(
          `check(${jsVal(op.actual)}, ${jsStr(op.operator)}, ${jsVal(op.expected)}, ${jsStr(op.message)});`,
        );
        break;
      case 'db': {
        const r = next(s, 'db');
        out(`// SQL also in ${op.sqlFile}`);
        out(
          op.kind === 'script'
            ? `const ${r} = await db.script(${jsStr(op.connection)}, ${jsBlock(op.sql)});`
            : `const ${r} = await db.query(${jsStr(op.connection)}, ${jsBlock(op.sql)}${op.params.length ? `, [${op.params.map((p) => jsVal(p)).join(', ')}]` : ''});`,
        );
        for (const a of op.asserts)
          out(
            `check(pick(${r}, ${jsStr(a.target)}), ${jsStr(a.operator)}, ${jsVal(a.expected)}, ${jsStr(`${a.target} ${a.operator}`)});`,
          );
        if (op.into) out(`vars.${op.into} = ${r}.rows;`);
        s.lastDb = r;
        break;
      }
      case 'dbExtract':
        out(
          s.lastDb
            ? `vars.${op.into} = pick(${s.lastDb}, ${jsStr(op.path)});`
            : '// TODO(StepForge): db.extract without an earlier query',
        );
        break;
      case 'emailWait': {
        const m = next(s, 'email');
        const crit = [
          ...(['to', 'from', 'subject', 'contains'] as const).flatMap((k) =>
            op[k] ? [`${k}: ${jsText(op[k]!)}`] : [],
          ),
          'since: testStart',
          `timeoutMs: ${op.timeoutMs}`,
        ];
        out(`const ${m} = await mail.waitForEmail({ ${crit.join(', ')} });`);
        if (op.into) out(`vars.${op.into} = ${m};`);
        s.lastMail = m;
        break;
      }
      case 'emailAssert':
        out(
          s.lastMail
            ? `mail.assertEmail(${s.lastMail}, { ${op.checks.map((c) => `${c.kind}: ${c.value.t === 'bool' ? String(c.value.v) : jsText(c.value)}`).join(', ')} });`
            : '// TODO(StepForge): email check without an earlier wait for email',
        );
        break;
      case 'emailExtract': {
        if (!s.lastMail) {
          out('// TODO(StepForge): email extraction without an earlier wait for email');
          break;
        }
        const call =
          op.kind === 'otp'
            ? `mail.otp(${s.lastMail})`
            : op.kind === 'link'
              ? `mail.link(${s.lastMail}, { ${[...(op.contains ? [`contains: ${jsText(op.contains)}`] : []), ...(op.index !== undefined ? [`index: ${op.index}`] : [])].join(', ')} })`
              : `mail.extract(${s.lastMail}, ${jsStr(op.pattern ?? '(.+)')})`;
        out(`vars.${op.into} = ${call};`);
        break;
      }
      case 'emailOpenLink': {
        const url = op.url
          ? jsText(op.url)
          : s.lastMail
            ? `mail.link(${s.lastMail}, { ${[...(op.contains ? [`contains: ${jsText(op.contains)}`] : []), ...(op.index !== undefined ? [`index: ${op.index}`] : [])].join(', ')} })`
            : "''";
        if (s.usesUi && !appium) out(`await ${s.pageVar}.goto(${url});`);
        else {
          const r = next(s, 'res');
          out(`const ${r} = await api(${appium ? '' : 'request, '}{ method: 'GET', url: ${url} });`);
          s.lastApi = r;
        }
        break;
      }
    }
  }
}

export function needs(t: TestPlan) {
  const flat: Op[] = [];
  const walk = (ops: Op[]) =>
    ops.forEach((o) => {
      flat.push(o);
      if (o.op === 'if') {
        walk(o.then);
        walk(o.else);
      }
      if (o.op === 'loop') walk(o.body);
    });
  walk(t.ops);
  const has = (k: Op['op']) => flat.some((o) => o.op === k);
  return {
    flat,
    tabs: has('tab') || has('closeTab'),
    api: has('api') || (has('emailOpenLink') && !t.usesUi),
    db: has('db'),
    mail: has('emailWait'),
    script: has('script'),
  };
}

export const usedHelpers = (code: string) =>
  ['check', 'compare', 'pick', 'fake', 'field', 'capture', 'containing', 'random', 'runId'].filter((h) =>
    new RegExp(`\\b${h}\\b[.(]?`).test(code.replace(/\/\/.*$/gm, '')),
  );

function specFile(plan: Plan, t: TestPlan, path: string): string {
  const depth = path.split('/').length - 1;
  const up = '../'.repeat(depth);
  const n = needs(t);
  const s: State = {
    lines: [],
    pageVar: n.tabs ? 'current' : 'page',
    root: n.tabs ? 'current' : 'page',
    n: {},
    usesUi: t.usesUi,
    pomVars: new Map(),
    imports: new Set(),
  };
  printOps(t.ops, s, '    ');
  const body = s.lines.join('\n');
  const cases = t.scenario.testCases;
  const dataUsed = /(?<![.\w])data\.|\(data[,)]|, data\)/.test(body.replace(/\/\/.*$/gm, ''));
  const fixtures = [...(t.usesUi || n.tabs ? ['page'] : []), ...(n.api ? ['request'] : [])];
  const helpers = usedHelpers(body);
  const tags = [...t.scenario.tags.map((x) => `@${kebab(x)}`), `@${t.scenario.priority.toLowerCase()}`];
  const title = [...t.scenario.modulePath, t.scenario.name].join(' › ');

  const head = [
    ...headerLines(plan.input, t.scenario).map((l) => `// ${l}`),
    // An Electron app: the test's page is the app's first window (support/electron.ts starts the app).
    electronLaunch(plan)
      ? `import { test, expect } from '${up}support/electron';`
      : "import { test, expect } from '@playwright/test';",
    ...(/\benv\b|\bsecret\(/.test(body)
      ? [
          `import { ${['env', 'secret'].filter((x) => new RegExp(`\\b${x}\\b`).test(body)).join(', ')} } from '${up}support/config';`,
        ]
      : []),
    ...(helpers.length ? [`import { ${helpers.join(', ')} } from '${up}support/helpers';`] : []),
    ...(n.api
      ? [`import { api${/basicAuth\(/.test(body) ? ', basicAuth' : ''} } from '${up}support/api';`]
      : []),
    ...(n.db ? [`import * as db from '${up}support/db';`] : []),
    ...(n.mail ? [`import * as mail from '${up}support/mail';`] : []),
    ...(s.imports.has('tabs') ? [`import { switchTab } from '${up}support/tabs';`] : []),
    ...[...s.pomVars.keys()].map(
      (p) => `import { ${plan.pages.get(p)!.className} } from '${up}pages/${plan.pages.get(p)!.className}';`,
    ),
    '',
    'type Vars = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any',
    '',
  ];
  const testBody = [
    ...(n.tabs ? ['    let current = page;'] : []),
    ...[...s.pomVars].map(([p, v]) => `    const ${v} = new ${plan.pages.get(p)!.className}(page);`),
    ...(n.mail ? ['    const testStart = new Date();'] : []),
    '    const vars: Vars = {};',
    ...s.lines,
  ];
  const opts = `{ tag: [${tags.map(jsStr).join(', ')}] }`;
  const fx = `{ ${fixtures.join(', ')} }`;
  if (cases.length) {
    return [
      ...head,
      'const testCases: { code: string; title: string; data: Vars }[] = [',
      ...cases.map((c) => `  { code: ${jsStr(c.code)}, title: ${jsStr(c.title)}, data: ${jsJson(c.data)} },`),
      '];',
      '',
      `test.describe(${jsStr(title)}, () => {`,
      `  for (const { code, title, data } of testCases) {`,
      `    test(\`\${code} \${title}\`, ${opts}, async (${fx}) => {`,
      ...testBody.map((l) => (l ? `  ${l}` : l)),
      '    });',
      '  }',
      '});',
      '',
    ].join('\n');
  }
  return [
    ...head,
    `test.describe(${jsStr(title)}, () => {`,
    `  test(${jsStr(t.scenario.name)}, ${opts}, async (${fx}) => {`,
    ...(dataUsed || n.script ? ['    const data: Vars = {};'] : []),
    ...testBody,
    '  });',
    '});',
    '',
  ].join('\n');
}

function configFile(plan: Plan): string {
  const { input } = plan;
  const vars = plan.variables.map(
    (v) => `  ${jsKey(v)}: process.env.${envName(v)} ?? ${jsStr(input.environment.variables[v] ?? '')},`,
  );
  return [
    `// ${CREDIT}`,
    "import 'dotenv/config';",
    '',
    '/** Environment variables; defaults come from the exported environment. */',
    'export const env: Record<string, string> & { baseUrl: string } = {',
    `  baseUrl: process.env.BASE_URL ?? ${jsStr(input.environment.baseUrl)},`,
    ...vars,
    '};',
    '',
    '/** A secret from the environment (.env locally, CI secrets in pipelines). Never stored in the code. */',
    'export function secret(name: string): string {',
    '  const value = process.env[name];',
    '  if (!value) throw new Error(`Set the ${name} environment variable (see .env.example)`);',
    '  return value;',
    '}',
    '',
  ].join('\n');
}

/** An Electron app's launch settings (executable or app folder), when the environment has them. */
const electronLaunch = (plan: Plan) =>
  plan.input.application.platform === 'electron' ? plan.input.environment.launch : undefined;

/** Starts the Electron app for each test, as StepForge does (Playwright's _electron.launch()). */
function electronFile(plan: Plan): string {
  const l = electronLaunch(plan)!;
  const opt = (k: string) => (typeof l[k] === 'string' && l[k] ? jsVal(val(l[k])) : 'undefined');
  const launchLines = [
    'const LAUNCH = {',
    `  executablePath: ${opt('executablePath')} as string | undefined,`,
    `  appPath: ${opt('appPath')} as string | undefined,`,
    `  args: ${jsVal(val(Array.isArray(l.args) ? l.args : []))} as string[],`,
    `  cwd: ${opt('cwd')} as string | undefined,`,
    `  env: ${jsVal(val(l.env && typeof l.env === 'object' ? l.env : {}))} as Record<string, string>,`,
    '};',
  ];
  return [
    `// ${CREDIT}`,
    "import { _electron, test as base, type ElectronApplication } from '@playwright/test';",
    "import { existsSync, statSync } from 'node:fs';",
    "import { createRequire } from 'node:module';",
    "import { dirname, isAbsolute, join, resolve } from 'node:path';",
    // {{env.x}} in the launch settings reads the exported configuration.
    ...(/\benv\b/.test(launchLines.join('\n').replace(/env: /, ''))
      ? ["import { env } from './config';"]
      : []),
    '',
    "export { expect } from '@playwright/test';",
    '',
    `/** How the ${plan.input.environment.name} environment starts the app. APP: another executable, app folder or main script. */`,
    ...launchLines,
    '',
    '/** The Electron of an app folder or main script: the `electron` package installed in that project, as `npm start` uses it. */',
    'function electronFor(appPath: string): string | undefined {',
    '  const start = statSync(appPath).isFile() ? dirname(appPath) : appPath;',
    '  try {',
    "    const bin = createRequire(join(resolve(start), 'package.json'))('electron') as unknown;",
    "    return typeof bin === 'string' && existsSync(bin) ? bin : undefined;",
    '  } catch {',
    '    return undefined;',
    '  }',
    '}',
    '',
    'async function launch(): Promise<ElectronApplication> {',
    '  const cwd = LAUNCH.cwd ? resolve(LAUNCH.cwd) : undefined;',
    '  const abs = (p: string) => (isAbsolute(p) ? p : resolve(cwd ?? process.cwd(), p));',
    '  const override = process.env.APP;',
    '  const args = [...LAUNCH.args];',
    '  let executablePath = LAUNCH.executablePath && abs(LAUNCH.executablePath);',
    '  let appPath = LAUNCH.appPath && abs(LAUNCH.appPath);',
    '  if (override) {',
    '    const p = abs(override);',
    '    if (statSync(p).isDirectory() || /\\.(c|m)?js$/.test(p)) [appPath, executablePath] = [p, undefined];',
    '    else [executablePath, appPath] = [p, undefined];',
    '  }',
    '  if (appPath) {',
    '    executablePath = electronFor(appPath);',
    '    if (!executablePath)',
    "      throw new Error(`No Electron found for ${appPath}: install it in the app's project (npm install electron), or set APP to the app executable`);",
    '    args.unshift(appPath);',
    '  }',
    "  if (!executablePath) throw new Error('Set APP to the app executable or its folder');",
    '  const childEnv: Record<string, string> = {};',
    '  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) childEnv[k] = v;',
    '  // Set in terminals of VS Code-based editors: it makes Electron behave like plain Node.js.',
    '  delete childEnv.ELECTRON_RUN_AS_NODE;',
    '  return _electron.launch({ executablePath, args, cwd, env: { ...childEnv, ...LAUNCH.env } });',
    '}',
    '',
    "/** Each test starts the app; its `page` is the app's first window (other windows are its other pages). */",
    'export const test = base.extend<{ electronApp: ElectronApplication }>({',
    '  // eslint-disable-next-line no-empty-pattern',
    '  electronApp: async ({}, use) => {',
    '    const app = await launch();',
    '    await use(app);',
    '    await app.close();',
    '  },',
    '  page: async ({ electronApp }, use) => {',
    '    const page = await electronApp.firstWindow();',
    "    await page.waitForLoadState('domcontentloaded');",
    '    await use(page);',
    '  },',
    '});',
    '',
  ].join('\n');
}

function pageFile(plan: Plan, key: string): string {
  const p = plan.pages.get(key)!;
  return [
    `// ${CREDIT}`,
    "import type { Page } from '@playwright/test';",
    '',
    `export class ${p.className} {`,
    '  constructor(private readonly page: Page) {}',
    ...p.elements.flatMap((e) => [
      '',
      `  get ${e.name}() {`,
      `    return ${locatorTs('this.page', e.loc)};`,
      '  }',
    ]),
    '}',
    '',
  ].join('\n');
}

export function generatePlaywrightTs(plan: Plan, o: CodegenOptions): GeneratedProject {
  const files: Record<string, string> = {};
  const electron = !!electronLaunch(plan);
  // The tests start the Electron app themselves: no browser warning.
  const warnings = electron
    ? plan.warnings.filter((w) => !w.message.includes('_electron.launch()'))
    : plan.warnings;
  const slug = kebab(plan.input.application.slug || plan.input.application.name);
  for (const t of plan.tests) {
    const path = testPath(t, (b) => `${b}.spec.ts`);
    files[path] = specFile(plan, t, path);
  }
  const anyDb = plan.tests.some((t) => t.ops.some((x) => x.op === 'db'));
  const engines = new Set(plan.tests.flatMap((t) => t.ops.flatMap((x) => (x.op === 'db' ? [x.engine] : []))));
  const any = engines.has('any');
  const deps: Record<string, string> = {
    ...((any || engines.has('pg')) && { pg: '^8.16.0', '@types/pg': '^8.15.0' }),
    ...((any || engines.has('mysql')) && { mysql2: '^3.14.0' }),
    ...((any || engines.has('sqlite')) && {
      'better-sqlite3': '^12.0.0',
      '@types/better-sqlite3': '^7.6.13',
    }),
  };
  files['package.json'] = `${JSON.stringify(
    {
      name: `${slug}-playwright-tests`,
      private: true,
      description: `${plan.input.application.name} tests. ${CREDIT}.`,
      scripts: {
        test: 'playwright test',
        'test:headed': 'playwright test --headed',
        report: 'playwright show-report',
      },
      devDependencies: { ...DEPS, ...deps },
    },
    null,
    2,
  )}\n`;
  files['playwright.config.ts'] = [
    `// ${CREDIT}`,
    "import { defineConfig, devices } from '@playwright/test';",
    "import { env } from './support/config';",
    '',
    'export default defineConfig({',
    "  testDir: './tests',",
    '  timeout: 60_000,',
    '  retries: process.env.CI ? 1 : 0,',
    "  reporter: [['list'], ['html', { open: 'never' }], ['junit', { outputFile: 'results/junit.xml' }]],",
    '  use: {',
    '    baseURL: env.baseUrl,',
    "    testIdAttribute: 'data-testid',",
    "    trace: 'retain-on-failure',",
    "    screenshot: 'only-on-failure',",
    '  },',
    electron
      ? "  // The app's own window (support/electron.ts), not a browser.\n  projects: [{ name: 'electron' }],"
      : "  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],",
    '});',
    '',
  ].join('\n');
  files['tsconfig.json'] = `${JSON.stringify(
    {
      compilerOptions: {
        target: 'ES2022',
        module: 'commonjs',
        strict: true,
        esModuleInterop: true,
        skipLibCheck: true,
        types: ['node'],
      },
    },
    null,
    2,
  )}\n`;
  files['.env.example'] = envExample(plan);
  files['.gitignore'] = ['node_modules/', '.env', 'test-results/', 'playwright-report/', 'results/', ''].join(
    '\n',
  );
  files['support/config.ts'] = configFile(plan);
  files['support/helpers.ts'] = runtime('ts/helpers.ts');
  if (electron) files['support/electron.ts'] = electronFile(plan);
  if (plan.tests.some((t) => needs(t).api)) files['support/api.ts'] = runtime('ts/api.ts');
  if (anyDb) files['support/db.ts'] = runtime('ts/db.ts');
  if (plan.tests.some((t) => needs(t).mail)) files['support/mail.ts'] = runtime('ts/mail.ts');
  if (plan.tests.some((t) => needs(t).tabs)) files['support/tabs.ts'] = runtime('ts/tabs.ts');
  for (const key of plan.pages.keys())
    files[`pages/${plan.pages.get(key)!.className}.ts`] = pageFile(plan, key);
  Object.assign(files, plan.sqlFiles);
  const ci = ciFiles(plan, 'node-playwright', o.ci);
  // Electron opens real windows: on Linux runners, in a virtual display.
  if (electron)
    for (const k of Object.keys(ci))
      ci[k] = ci[k]!.replace('- run: npx playwright test', '- run: xvfb-run -a npx playwright test').replace(
        '    - npx playwright test',
        '    - xvfb-run -a npx playwright test',
      );
  Object.assign(files, ci);
  files['README.md'] = readme(
    { ...plan, warnings },
    {
      title: electron ? 'Playwright tests of an Electron app (TypeScript)' : 'Playwright tests (TypeScript)',
      install: ['npm install', 'npx playwright install chromium'],
      run: [
        'npx playwright test            # all tests',
        'npx playwright test --headed   # watch the browser',
        'npx playwright show-report     # HTML report',
      ],
      layout: [
        '`tests/` — one spec per scenario, grouped by module; one test per test case',
        ...(plan.pages.size ? ['`pages/` — page objects (one class per page, one getter per element)'] : []),
        '`support/` — configuration (environment variables, secrets) and helpers',
        ...(Object.keys(plan.sqlFiles).length ? ['`sql/` — the SQL of each database step'] : []),
        '`results/junit.xml` — JUnit results for CI',
      ],
      notes: [
        ...(electron
          ? [
              "Each test starts the Electron app (support/electron.ts, from the environment's launch settings) and closes it; its `page` is the app's first window. Set `APP` to test another build. Linux servers need a display: `xvfb-run -a npx playwright test`.",
            ]
          : []),
        'Locators are the first (best-ranked) locator StepForge recorded. StepForge falls back to the others at run time ("self-healing"); exported tests do not.',
        `Exported on ${day(plan.input)}; re-export from StepForge after changing the scenarios.`,
      ],
    },
  );
  return {
    target: 'playwright-ts',
    files,
    warnings,
    run: 'npm install && npx playwright install chromium && npx playwright test',
  };
}
