import { transformSync } from 'esbuild';
import { CREDIT, ciFiles, day, envExample, headerLines, readme, runtime, testPath } from '../common.ts';
import type { El, Loc, Op, Plan, TestPlan } from '../ir.ts';
import { jsNum, jsBlock, jsJson, jsKey, jsStr, jsText, jsVal } from '../lang/js.ts';
import type { CodegenOptions, GeneratedProject } from '../types.ts';
import { camel, envName, kebab, parseString } from '../values.ts';

/**
 * Cypress (JavaScript). Elements are found with Testing Library queries (same meaning as StepForge's role/label/text
 * locators). Steps that read values produced by earlier steps run inside `cy.then()`, because Cypress queues commands.
 * Database and Mailpit access run as Node tasks.
 */

/** The TypeScript runtime helpers compiled to JavaScript: one source of truth for both targets. */
function compiled(path: string, format: 'esm' | 'cjs'): string {
  const js = transformSync(runtime(path), { loader: 'ts', format, target: 'es2020' }).code;
  return `// ${CREDIT}\n${js}`;
}

export function locatorCy(l: Loc, all = false): string {
  const v = (s: string) => jsText(parseString(s));
  const f = all ? 'findAll' : 'find';
  switch (l.strategy) {
    case 'testId':
      return `cy.${f}ByTestId(${v(l.value)})`;
    case 'role':
      return l.name
        ? `cy.${f}ByRole(${jsStr(l.value)}, { name: ${v(l.name)} })`
        : `cy.${f}ByRole(${jsStr(l.value)})`;
    case 'label':
      return `cy.${f}ByLabelText(${v(l.value)})`;
    case 'placeholder':
      return `cy.${f}ByPlaceholderText(${v(l.value)})`;
    case 'text':
      return `cy.${f}ByText(${v(l.value)})`;
    case 'xpath':
      return `cy.xpath(${v(l.value)})`;
    default:
      return `cy.get(${v(l.value)})`;
  }
}

const KEYS: Record<string, string> = {
  Enter: '{enter}',
  Escape: '{esc}',
  Backspace: '{backspace}',
  Delete: '{del}',
  ArrowDown: '{downArrow}',
  ArrowUp: '{upArrow}',
  ArrowLeft: '{leftArrow}',
  ArrowRight: '{rightArrow}',
  Home: '{home}',
  End: '{end}',
  PageUp: '{pageUp}',
  PageDown: '{pageDown}',
  'Control+A': '{selectAll}',
  'Meta+A': '{selectAll}',
};

type State = { lines: string[]; pages: Map<string, string>; xpath: boolean; usesUi: boolean };

function el(s: State, e: El, all = false): string {
  if (e.pom && !all) {
    s.pages.set(e.pom.page, `${camel(e.pom.page)}Page`);
    return `${camel(e.pom.page)}Page.${e.pom.name}()`;
  }
  if (e.loc.strategy === 'xpath') s.xpath = true;
  return locatorCy(e.loc, all);
}

/** Code reading values set while the test runs must be evaluated lazily. */
const lazy = (code: string) => /\bvars\b|\blast\.|\bfield\(vars/.test(code);

const urlFull = (v: string) => `new URL(${v}, Cypress.config('baseUrl')).href`;

function printOps(ops: Op[], s: State, ind: string, warn: (m: string) => void): void {
  const emit = (code: string[]) => {
    const text = code.join('\n');
    if (lazy(text.replace(/\/\/.*$/gm, ''))) {
      s.lines.push(`${ind}cy.then(() => {`);
      for (const l of code) s.lines.push(`${ind}  ${l}`);
      s.lines.push(`${ind}});`);
    } else for (const l of code) s.lines.push(`${ind}${l}`);
  };
  for (const op of ops) {
    switch (op.op) {
      case 'comment':
        emit([`// ${op.text}`]);
        break;
      case 'todo':
        emit([`// TODO(StepForge): ${op.text}`]);
        break;
      case 'goto': {
        const url = jsVal(op.url);
        emit([`cy.visit(${url});`]);
        break;
      }
      case 'act': {
        const l = el(s, op.el);
        const value = op.value ? jsText(op.value) : "''";
        const call: Record<string, string> = {
          click: 'click()',
          dblclick: 'dblclick()',
          rightclick: 'rightclick()',
          hover: "trigger('mouseover')",
          clear: 'clear()',
          check: 'check()',
          uncheck: 'uncheck()',
          scrollIntoView: 'scrollIntoView()',
          fill: `fill(${value})`,
          type: `type(${value}, { parseSpecialCharSequences: false })`,
        };
        if (op.action === 'hover') emit(['// Cypress has no real hover; this fires the mouseover event']);
        emit([`${l}.${call[op.action]};`]);
        break;
      }
      case 'press': {
        const key = KEYS[op.key] ?? (op.key.length === 1 ? op.key : undefined);
        if (!key) {
          warn(`the key "${op.key}" has no Cypress equivalent`);
          emit([
            `// TODO(StepForge): press ${op.key} (no Cypress equivalent without a plugin such as cypress-real-events)`,
          ]);
          break;
        }
        emit([op.el ? `${el(s, op.el)}.type(${jsStr(key)});` : `cy.focused().type(${jsStr(key)});`]);
        break;
      }
      case 'select':
        emit([`${el(s, op.el)}.select(${op.by === 'index' ? jsNum(op.value) : jsText(op.value)});`]);
        break;
      case 'upload':
        emit([`${el(s, op.el)}.selectFile([${op.files.map((f) => jsText(f)).join(', ')}]);`]);
        break;
      case 'drag':
        warn('drag and drop needs a plugin in Cypress (e.g. @4tw/cypress-drag-drop)');
        emit([
          `// TODO(StepForge): drag ${el(s, op.el)} onto ${el(s, op.to)} (needs a Cypress drag-and-drop plugin)`,
        ]);
        break;
      case 'scroll':
        emit([`cy.scrollTo(${op.x}, ${op.y});`]);
        break;
      case 'waitFor': {
        const should = {
          visible: 'be.visible',
          hidden: 'not.be.visible',
          attached: 'exist',
          detached: 'not.exist',
        }[op.state];
        emit([`${el(s, op.el)}.should(${jsStr(should)});`]);
        break;
      }
      case 'waitUrl':
        emit([`cy.url().should('match', globToRegExp(${jsVal(op.url)}));`]);
        break;
      case 'waitLoad':
        emit(["cy.document().its('readyState').should('eq', 'complete');"]);
        break;
      case 'assert': {
        const e = op.expected ? (op.check === 'count' ? jsNum(op.expected) : jsText(op.expected)) : "''";
        const l = op.el ? el(s, op.el, op.check === 'count') : '';
        const line: Record<string, string> = {
          visible: `${l}.should('be.visible');`,
          hidden: `${l}.should('not.exist');`,
          text: `${l}.should(($el) => expect($el.text().trim()).to.eq(${e}));`,
          textContains: `${l}.should('contain.text', ${e});`,
          textMatches: `${l}.should(($el) => expect($el.text()).to.match(new RegExp(${e})));`,
          value: `${l}.should('have.value', ${e});`,
          count: `${l}.should('have.length', ${e});`,
          attribute: `${l}.should('have.attr', ${jsStr(op.attribute ?? '')}, ${e});`,
          enabled: `${l}.should('be.enabled');`,
          disabled: `${l}.should('be.disabled');`,
          checked: `${l}.should('be.checked');`,
          unchecked: `${l}.should('not.be.checked');`,
          url: `cy.url().should('eq', ${urlFull(e)});`,
          urlContains: `cy.url().should('include', ${e});`,
          urlMatches: `cy.url().should('match', new RegExp(${e}));`,
          title: `cy.title().should('eq', ${e});`,
          titleContains: `cy.title().should('include', ${e});`,
        };
        emit([line[op.check]!]);
        break;
      }
      case 'read': {
        const l = op.el ? el(s, op.el, op.source === 'count') : '';
        const get: Record<string, string> = {
          text: `${l}.invoke('text')`,
          value: `${l}.invoke('val')`,
          attribute: `${l}.invoke('attr', ${jsStr(op.attribute ?? '')})`,
          count: `${l}.its('length')`,
          url: 'cy.url()',
          title: 'cy.title()',
        };
        const value = op.source === 'text' ? 'String(value).trim()' : 'value';
        emit([
          `${get[op.source]}.then((value) => {`,
          `  vars.${op.into} = ${op.regex ? `capture(${value}, ${jsStr(op.regex)})` : value};`,
          '});',
        ]);
        break;
      }
      case 'screenshot':
        emit([
          `${op.el ? el(s, op.el) : 'cy'}.screenshot(${jsStr(op.name)}${!op.el && op.fullPage ? ", { capture: 'fullPage' }" : ''});`,
        ]);
        break;
      case 'dialog':
        emit(
          op.promptText
            ? [`cy.window().then((win) => cy.stub(win, 'prompt').returns(${jsText(op.promptText)}));`]
            : [`cy.on('window:confirm', () => ${op.accept});`],
        );
        break;
      case 'frame':
        if (op.selector !== null) {
          warn('iframes need a plugin in Cypress (e.g. cypress-iframe)');
          emit([
            `// TODO(StepForge): switch into the iframe ${op.selector} (needs cypress-iframe); the next steps run in the page`,
          ]);
        }
        break;
      case 'tab':
      case 'closeTab':
        warn('Cypress cannot control several tabs; remove the target="_blank" or visit the URL directly');
        emit([
          `// TODO(StepForge): ${op.op === 'tab' ? 'switch tab' : 'close tab'} — Cypress runs in a single tab`,
        ]);
        break;
      case 'api': {
        const headers: string[] = op.headers.map(([k, v]) => `${jsKey(k)}: ${jsText(v)}`);
        const qs: string[] = op.query.map(([k, v]) => `${jsKey(k)}: ${jsVal(v)}`);
        if (op.auth?.type === 'bearer')
          headers.push(`Authorization: \`Bearer \${${jsText(op.auth.token)}}\``);
        if (op.auth?.type === 'basic')
          headers.push(`Authorization: basicAuth(${jsText(op.auth.username)}, ${jsText(op.auth.password)})`);
        if (op.auth?.type === 'apiKey')
          (op.auth.in === 'query' ? qs : headers).push(`${jsKey(op.auth.name)}: ${jsText(op.auth.value)}`);
        if (op.auth?.type === 'cookie')
          headers.push(`Cookie: \`${op.auth.name}=\${${jsText(op.auth.value)}}\``);
        if (op.bodyType === 'multipart')
          warn('multipart bodies are sent as JSON by cy.request; check the request');
        const body =
          op.body === null || op.bodyType === 'none'
            ? []
            : [`body: ${jsVal(op.body, '  ')},`, ...(op.bodyType === 'form' ? ['form: true,'] : [])];
        emit([
          'cy.request({',
          `  method: ${jsStr(op.method)},`,
          `  url: ${jsVal(op.url)},`,
          ...(headers.length ? [`  headers: { ${headers.join(', ')} },`] : []),
          ...(qs.length ? [`  qs: { ${qs.join(', ')} },`] : []),
          ...body.map((b) => `  ${b}`),
          '  failOnStatusCode: false,',
          '}).then((response) => {',
          '  const res = toResult(response);',
          ...op.asserts.map((a) =>
            a.target === 'status' && a.operator === 'equals'
              ? `  expect(res.status, 'status').to.eq(${jsVal(a.expected)});`
              : `  check(pick(res, ${jsStr(a.target)}), ${jsStr(a.operator)}, ${jsVal(a.expected)}, ${jsStr(`${a.target} ${a.operator}`)});`,
          ),
          ...(op.into ? [`  vars.${op.into} = res.body;`] : []),
          '  last.api = res;',
          '});',
        ]);
        break;
      }
      case 'apiExtract': {
        const target =
          op.from === 'status'
            ? 'status'
            : op.from === 'header'
              ? `header:${op.name ?? ''}`
              : (op.path ?? 'body');
        emit([`vars.${op.into} = pick(last.api, ${jsStr(target)});`]);
        break;
      }
      case 'setVar':
        emit([`vars.${op.name} = ${jsVal(op.value)};`]);
        break;
      case 'gen':
        emit([
          `vars.${op.into} = fake(${jsStr(op.kind)}${Object.keys(op.opts).length ? `, ${jsJson(op.opts)}` : ''});`,
        ]);
        break;
      case 'wait':
        emit([`cy.wait(${op.ms});`]);
        break;
      case 'log':
        emit([`cy.log(${jsText(op.message)});`]);
        break;
      case 'script':
        emit([
          `${op.into ? `vars.${op.into} = ` : ''}((vars, data) => {`,
          ...op.code.split('\n').map((l) => `  ${l}`),
          '})(vars, data);',
        ]);
        break;
      case 'if': {
        s.lines.push(`${ind}cy.then(() => {`);
        s.lines.push(
          `${ind}  if (compare(${jsVal(op.value)}, ${jsStr(op.operator)}, ${jsVal(op.expected)})) {`,
        );
        printOps(op.then, s, `${ind}    `, warn);
        if (op.else.length) {
          s.lines.push(`${ind}  } else {`);
          printOps(op.else, s, `${ind}    `, warn);
        }
        s.lines.push(`${ind}  }`, `${ind}});`);
        break;
      }
      case 'loop': {
        s.lines.push(`${ind}cy.then(() => {`);
        if (op.over) {
          s.lines.push(`${ind}  (${jsVal(op.over)}).forEach((${camel(op.as)}, index) => {`);
          s.lines.push(
            `${ind}    cy.then(() => {`,
            `${ind}      vars.${op.as} = ${camel(op.as)};`,
            `${ind}      vars.index = index;`,
            `${ind}    });`,
          );
        } else {
          s.lines.push(`${ind}  for (let index = 0; index < ${jsNum(op.count!)}; index++) {`);
          s.lines.push(`${ind}    cy.then(() => {`, `${ind}      vars.index = index;`, `${ind}    });`);
        }
        printOps(op.body, s, `${ind}    `, warn);
        s.lines.push(op.over ? `${ind}  });` : `${ind}  }`, `${ind}});`);
        break;
      }
      case 'check':
        emit([
          `check(${jsVal(op.actual)}, ${jsStr(op.operator)}, ${jsVal(op.expected)}, ${jsStr(op.message)});`,
        ]);
        break;
      case 'db':
        emit([`// SQL also in ${op.sqlFile}`]);
        emit([
          `cy.task(${jsStr(op.kind === 'script' ? 'db:script' : 'db:query')}, { connection: ${jsStr(op.connection)}, sql: ${jsBlock(op.sql)}${op.kind === 'script' || !op.params.length ? '' : `, params: [${op.params.map((p) => jsVal(p)).join(', ')}]`} }).then((result) => {`,
          ...op.asserts.map(
            (a) =>
              `  check(pick(result, ${jsStr(a.target)}), ${jsStr(a.operator)}, ${jsVal(a.expected)}, ${jsStr(`${a.target} ${a.operator}`)});`,
          ),
          ...(op.into ? [`  vars.${op.into} = result.rows;`] : []),
          '  last.db = result;',
          '});',
        ]);
        break;
      case 'dbExtract':
        emit([`vars.${op.into} = pick(last.db, ${jsStr(op.path)});`]);
        break;
      case 'emailWait': {
        const crit = [
          ...(['to', 'from', 'subject', 'contains'] as const).flatMap((k) =>
            op[k] ? [`${k}: ${jsText(op[k]!)}`] : [],
          ),
          'since: testStart',
          `timeoutMs: ${op.timeoutMs}`,
        ];
        emit([
          `cy.task('mail:wait', { ${crit.join(', ')} }, { timeout: ${op.timeoutMs + 5000} }).then((email) => {`,
          ...(op.into ? [`  vars.${op.into} = email;`] : []),
          '  last.email = email;',
          '});',
        ]);
        break;
      }
      case 'emailAssert':
        emit([
          `mail.assertEmail(last.email, { ${op.checks.map((c) => `${c.kind}: ${c.value.t === 'bool' ? String(c.value.v) : jsText(c.value)}`).join(', ')} });`,
        ]);
        break;
      case 'emailExtract': {
        const call =
          op.kind === 'otp'
            ? 'mail.otp(last.email)'
            : op.kind === 'link'
              ? `mail.link(last.email, { ${[...(op.contains ? [`contains: ${jsText(op.contains)}`] : []), ...(op.index !== undefined ? [`index: ${op.index}`] : [])].join(', ')} })`
              : `mail.extract(last.email, ${jsStr(op.pattern ?? '(.+)')})`;
        emit([`vars.${op.into} = ${call};`]);
        break;
      }
      case 'emailOpenLink': {
        const url = op.url
          ? jsText(op.url)
          : `mail.link(last.email, { ${[...(op.contains ? [`contains: ${jsText(op.contains)}`] : []), ...(op.index !== undefined ? [`index: ${op.index}`] : [])].join(', ')} })`;
        emit([
          s.usesUi
            ? `cy.visit(${url});`
            : `cy.request(${url}).then((response) => { last.api = toResult(response); });`,
        ]);
        break;
      }
    }
  }
}

const HELPERS = ['check', 'compare', 'pick', 'fake', 'field', 'capture', 'random', 'runId'];

function specFile(plan: Plan, t: TestPlan, path: string, warn: (m: string) => void): string {
  // Specs live under cypress/e2e/…; support files under cypress/support.
  const up = '../'.repeat(path.split('/').length - 2);
  const s: State = { lines: [], pages: new Map(), xpath: false, usesUi: t.usesUi };
  printOps(t.ops, s, '      ', warn);
  const body = s.lines.join('\n');
  const code = body.replace(/\/\/.*$/gm, '');
  const helpers = HELPERS.filter((h) => new RegExp(`\\b${h}\\b`).test(code));
  const usesMail = /\bmail\./.test(code);
  const title = [...t.scenario.modulePath, t.scenario.name].join(' › ');
  const tags = [...t.scenario.tags.map((x) => `@${kebab(x)}`), `@${t.scenario.priority.toLowerCase()}`];
  const head = [
    ...headerLines(plan.input, t.scenario).map((l) => `// ${l}`),
    ...(helpers.length ? [`import { ${helpers.join(', ')} } from '${up}support/helpers.js';`] : []),
    ...(/\benv\b|\bsecret\(/.test(code)
      ? [
          `import { ${['env', 'secret'].filter((x) => new RegExp(`\\b${x}\\b`).test(code)).join(', ')} } from '${up}support/config.js';`,
        ]
      : []),
    ...(/\btoResult\(|\bbasicAuth\(/.test(code)
      ? [
          `import { ${['toResult', 'basicAuth'].filter((x) => code.includes(`${x}(`)).join(', ')} } from '${up}support/api.js';`,
        ]
      : []),
    ...(/\bglobToRegExp\(/.test(code) ? [`import { globToRegExp } from '${up}support/api.js';`] : []),
    ...(usesMail ? [`import * as mail from '${up}support/mail.js';`] : []),
    ...[...s.pages].map(([p, v]) => `import { ${v} } from '${up}pages/${plan.pages.get(p)!.className}.js';`),
    '',
  ];
  const setup = [
    '      const vars = {};',
    '      const last = {};',
    ...(/\btestStart\b/.test(code) ? ['      const testStart = new Date().toISOString();'] : []),
  ];
  const cases = t.scenario.testCases;
  if (cases.length)
    return [
      ...head,
      `// Tags: ${tags.join(' ')}`,
      `describe(${jsStr(title)}, () => {`,
      '  const testCases = [',
      ...cases.map(
        (c) => `    { code: ${jsStr(c.code)}, title: ${jsStr(c.title)}, data: ${jsJson(c.data)} },`,
      ),
      '  ];',
      '',
      '  testCases.forEach(({ code, title, data }) => {',
      '    it(`${code} ${title}`, () => {',
      ...setup.map((l) => `  ${l}`),
      ...s.lines.map((l) => `  ${l}`),
      '    });',
      '  });',
      '});',
      '',
    ].join('\n');
  return [
    ...head,
    `// Tags: ${tags.join(' ')}`,
    `describe(${jsStr(title)}, () => {`,
    `  it(${jsStr(t.scenario.name)}, () => {`,
    ...(/(?<![.\w])data\.|\(data[,)]|, data\)/.test(code) ? ['    const data = {};'] : []),
    ...setup.map((l) => l.slice(2)),
    ...s.lines.map((l) => l.slice(2)),
    '  });',
    '});',
    '',
  ].join('\n');
}

const API_JS = `// ${CREDIT}
/** cy.request's response in the shape the helpers read (status, headers, body, text, ms, size). */
export function toResult(response) {
  const text = typeof response.body === 'string' ? response.body : JSON.stringify(response.body ?? '');
  return { status: response.status, headers: response.headers, body: response.body, text, ms: response.duration, size: text.length };
}

export const basicAuth = (user, password) => \`Basic \${btoa(\`\${user}:\${password}\`)}\`;

/** "**\\/patients/*" style URL patterns. */
export const globToRegExp = (glob) =>
  new RegExp(String(glob).replace(/[.+^\${}()|[\\]\\\\]/g, '\\\\$&').replace(/\\*\\*/g, '.*').replace(/(?<!\\.)\\*/g, '[^/]*'));
`;

export function generateCypress(plan: Plan, o: CodegenOptions): GeneratedProject {
  const files: Record<string, string> = {};
  const warnings = [...plan.warnings];
  for (const t of plan.tests) {
    const path = testPath(t, (b) => `${b}.cy.js`, 'cypress/e2e');
    files[path] = specFile(plan, t, path, (message) => warnings.push({ scenario: t.scenario.name, message }));
  }
  const all = Object.values(files).join('\n');
  const usesDb = /cy\.task\('db:/.test(all);
  const usesMail = /cy\.task\('mail:/.test(all);
  const engines = new Set(plan.tests.flatMap((t) => t.ops.flatMap((x) => (x.op === 'db' ? [x.engine] : []))));
  const any = engines.has('any');
  const slug = kebab(plan.input.application.slug || plan.input.application.name);
  files['package.json'] = `${JSON.stringify(
    {
      name: `${slug}-cypress-tests`,
      private: true,
      description: `${plan.input.application.name} tests. ${CREDIT}.`,
      scripts: { test: 'cypress run', open: 'cypress open' },
      devDependencies: {
        cypress: '^15.0.0',
        '@testing-library/cypress': '^10.0.3',
        '@faker-js/faker': '^10.0.0',
        dotenv: '^17.0.0',
        ...(all.includes('cy.xpath(') && { '@cypress/xpath': '^2.0.3' }),
        ...((any || engines.has('pg')) && { pg: '^8.16.0' }),
        ...((any || engines.has('mysql')) && { mysql2: '^3.14.0' }),
        ...((any || engines.has('sqlite')) && { 'better-sqlite3': '^12.0.0' }),
      },
    },
    null,
    2,
  )}\n`;
  const envKeys = [...plan.secrets.map(envName), ...plan.variables.map(envName)];
  files['cypress.config.js'] = [
    `// ${CREDIT}`,
    "require('dotenv').config();",
    "const { defineConfig } = require('cypress');",
    ...(usesDb ? ["const db = require('./cypress/plugins/db.cjs');"] : []),
    ...(usesMail ? ["const mail = require('./cypress/plugins/mail.cjs');"] : []),
    '',
    'module.exports = defineConfig({',
    '  e2e: {',
    `    baseUrl: process.env.BASE_URL || ${jsStr(plan.input.environment.baseUrl)},`,
    "    specPattern: 'cypress/e2e/**/*.cy.js',",
    '    defaultCommandTimeout: 10000,',
    "    reporter: 'junit',",
    "    reporterOptions: { mochaFile: 'results/junit-[hash].xml' },",
    '    // Environment variables the tests read (Cypress.env), from .env or the CI environment.',
    `    env: { ${envKeys.map((k) => `${k}: process.env.${k}`).join(', ')} },`,
    ...(usesDb || usesMail
      ? [
          '    setupNodeEvents(on) {',
          "      on('task', {",
          ...(usesDb
            ? [
                "        'db:query': ({ connection, sql, params }) => db.query(connection, sql, params ?? []),",
                "        'db:script': ({ connection, sql }) => db.script(connection, sql),",
              ]
            : []),
          ...(usesMail
            ? [
                "        'mail:wait': (criteria) => mail.waitForEmail({ ...criteria, since: new Date(criteria.since) }),",
              ]
            : []),
          '      });',
          '    },',
        ]
      : []),
    '  },',
    '});',
    '',
  ].join('\n');
  files['cypress/support/e2e.js'] = [
    `// ${CREDIT}`,
    "import '@testing-library/cypress/add-commands';",
    ...(all.includes('cy.xpath(') ? ["import '@cypress/xpath';"] : []),
    '',
    "/** Replaces the content of a field, like Playwright's fill(); an empty value just clears it. */",
    "Cypress.Commands.add('fill', { prevSubject: 'element' }, (subject, value) => {",
    '  cy.wrap(subject).clear();',
    "  if (String(value ?? '') !== '') cy.wrap(subject).type(String(value), { parseSpecialCharSequences: false, delay: 0 });",
    '});',
    '',
  ].join('\n');
  files['cypress/support/config.js'] = [
    `// ${CREDIT}`,
    '/** Environment variables; defaults come from the exported environment. */',
    'export const env = {',
    "  baseUrl: Cypress.config('baseUrl'),",
    ...plan.variables.map(
      (v) =>
        `  ${jsKey(v)}: Cypress.env(${jsStr(envName(v))}) ?? ${jsStr(plan.input.environment.variables[v] ?? '')},`,
    ),
    '};',
    '',
    '/** A secret from the environment (.env locally, CI secrets in pipelines). Never stored in the code. */',
    'export function secret(name) {',
    '  const value = Cypress.env(name);',
    '  if (!value) throw new Error(`Set the ${name} environment variable (see .env.example)`);',
    '  return value;',
    '}',
    '',
  ].join('\n');
  files['cypress/support/helpers.js'] = compiled('ts/helpers.ts', 'esm');
  files['cypress/support/api.js'] = API_JS;
  if (/\bmail\./.test(all)) files['cypress/support/mail.js'] = compiled('ts/mail.ts', 'esm');
  if (usesDb) files['cypress/plugins/db.cjs'] = compiled('ts/db.ts', 'cjs');
  if (usesMail) files['cypress/plugins/mail.cjs'] = compiled('ts/mail.ts', 'cjs');
  for (const [key, p] of plan.pages)
    files[`cypress/pages/${p.className}.js`] = [
      `// ${CREDIT}`,
      `export const ${camel(key)}Page = {`,
      ...p.elements.map((e) => `  ${e.name}: () => ${locatorCy(e.loc)},`),
      '};',
      '',
    ].join('\n');
  Object.assign(files, plan.sqlFiles);
  Object.assign(files, ciFiles(plan, 'node-cypress', o.ci));
  files['.env.example'] = envExample(plan);
  files['.gitignore'] = [
    'node_modules/',
    '.env',
    'cypress/videos/',
    'cypress/screenshots/',
    'results/',
    '',
  ].join('\n');
  const finalPlan = { ...plan, warnings };
  files['README.md'] = readme(finalPlan, {
    title: 'Cypress tests (JavaScript)',
    install: ['npm install'],
    run: ['npx cypress run    # headless, JUnit results in results/', 'npx cypress open   # interactive'],
    layout: [
      '`cypress/e2e/` — one spec per scenario, grouped by module; one test per test case',
      ...(plan.pages.size ? ['`cypress/pages/` — page objects (one function per element)'] : []),
      '`cypress/support/` — configuration, helpers, the `fill` command and Testing Library queries',
      ...(usesDb || usesMail ? ['`cypress/plugins/` — Node tasks for the database and Mailpit'] : []),
      ...(Object.keys(plan.sqlFiles).length ? ['`sql/` — the SQL of each database step'] : []),
    ],
    notes: [
      "Elements are found with Testing Library (`findByRole`, `findByLabelText`, …), which match StepForge's role, label and text locators.",
      'Steps that use values from earlier steps run inside `cy.then()` so they read the value when the step runs.',
      'Cypress runs in one tab and needs plugins for iframes and drag and drop; such steps are marked `TODO(StepForge)`.',
      `Exported on ${day(plan.input)}; re-export from StepForge after changing the scenarios.`,
    ],
  });
  return { target: 'cypress-js', files, warnings, run: 'npm install && npx cypress run' };
}
