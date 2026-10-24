import { buildSync, transformSync } from 'esbuild';
import { fileURLToPath } from 'node:url';
import {
  CREDIT,
  ciFiles,
  day,
  envExample,
  headerLines,
  oneLine,
  readme,
  runtime,
  statusCode,
  testPath,
} from '../common.ts';
import {
  walk,
  type El,
  type Features,
  type Loc,
  type Op,
  type PageCond,
  type Plan,
  type TestPlan,
} from '../ir.ts';
import { jsNum, jsBlock, jsJson, jsKey, jsStr, jsText, jsVal, jsVar } from '../lang/js.ts';
import type { CodegenOptions, GeneratedProject } from '../types.ts';
import { camel, envName, kebab, parseString, type Val } from '../values.ts';

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

/**
 * A runtime helper and what it imports, bundled for a Node task (Kafka, FTP, MongoDB). The client libraries stay
 * npm dependencies; the test-data helpers they never call are left out.
 */
function bundled(path: string): string {
  const js = buildSync({
    entryPoints: [fileURLToPath(new URL(`../../runtime/${path}`, import.meta.url))],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'es2020',
    write: false,
    external: ['kafkajs', 'basic-ftp', 'ssh2-sftp-client', 'mongodb', '@faker-js/faker'],
  }).outputFiles[0]!.text.replace(/var import_faker = require\("@faker-js\/faker"\);\n/, '');
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

type State = {
  lines: string[];
  pages: Map<string, string>;
  xpath: boolean;
  usesUi: boolean;
  /** Namespaces of the last SOAP response, for XPath in a later extract. */
  lastSoap?: Record<string, string>;
  n: number;
};

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

/** An element query for a page condition, with the same meaning as the test's Testing Library locator. */
function queryCy(e: El): string {
  const l = e.loc;
  const v = (x: string) => jsText(parseString(x));
  switch (l.strategy) {
    case 'testId':
      return `byTestId(${v(l.value)})`;
    case 'role':
      return l.name ? `byRole(${jsStr(l.value)}, ${v(l.name)})` : `byRole(${jsStr(l.value)})`;
    case 'label':
      return `byLabelText(${v(l.value)})`;
    case 'placeholder':
      return `byPlaceholderText(${v(l.value)})`;
    case 'text':
      return `byText(${v(l.value)})`;
    case 'xpath':
      return `byXPath(${v(l.value)})`;
    default:
      return `byCss(${v(l.value)})`;
  }
}

/** `pageCondition(…)`: yields whether the check holds within its short wait. */
function pageCond(c: PageCond): string {
  const args = [queryCy(c.el), jsStr(c.check)];
  const expected = c.expected ? (c.check === 'count' ? jsNum(c.expected) : jsText(c.expected)) : 'undefined';
  if (c.expected || c.timeoutMs !== 2000) args.push(expected);
  if (c.timeoutMs !== 2000) args.push(String(c.timeoutMs));
  return `pageCondition(${args.join(', ')})`;
}

/** An assertion line: check() with StepForge's operators, or a JSON Schema check. */
function checkLine(actual: string, a: { target: string; operator: string; expected: Val }): string {
  return a.operator === 'matchesSchema'
    ? `expectSchema(${actual}, ${jsVal(a.expected, '  ')}, ${jsStr(`${a.target} matches the JSON schema`)});`
    : `check(${actual}, ${jsStr(a.operator)}, ${jsVal(a.expected)}, ${jsStr(`${a.target} ${a.operator}`)});`;
}

/** XPath targets read the XML body (SOAP); the others are read as from any response. */
const XPATH = (t: string) =>
  t.startsWith('/') || t.startsWith('xpath:') || /^(count|string|number|boolean|sum)\(/.test(t);
function responseValue(r: string, target: string, ns?: Record<string, string>): string {
  if (ns && XPATH(target))
    return `xpathValue(${r}.text, ${jsStr(target)}${Object.keys(ns).length ? `, ${jsJson(ns)}` : ''})`;
  // A schema on the whole body ($ or body) validates the parsed body.
  return target === '$' ? `${r}.body` : `pick(${r}, ${jsStr(target)})`;
}

/** A clock time: a fixed date when it is written in the step, else read like StepForge reads it. */
function timeCy(v: Val): string {
  if (v.t === 'num') return `new Date(${v.v})`;
  if (v.t === 'str' && v.parts.every((x) => typeof x === 'string')) return `new Date(${jsVal(v)})`;
  return `clockTime(${jsVal(v)})`;
}

const FTP_TARGETS = ['content', 'size', 'path', 'count', 'names', 'exists'];

function printOps(ops: Op[], s: State, ind: string, warn: (m: string, step?: string) => void): void {
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
        emit([`// ${oneLine(op.text)}`]);
        break;
      case 'todo':
        emit([`// TODO(StepForge): ${oneLine(op.text)}`]);
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
          tap: "trigger('touchstart').trigger('touchend').click()",
        };
        if (op.action === 'hover') emit(['// Cypress has no real hover; this fires the mouseover event']);
        if (op.action === 'tap')
          emit(['// Cypress has no touch screen: a tap fires the touch events, then the click they lead to']);
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
          `  ${jsVar(op.into)} = ${op.regex ? `capture(${value}, ${jsStr(op.regex)})` : value};`,
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
        if (op.auth?.type === 'oauth2') headers.push('Authorization: `Bearer ${token}`');
        const body =
          op.body === null || op.bodyType === 'none'
            ? []
            : [`body: ${jsVal(op.body, '  ')},`, ...(op.bodyType === 'form' ? ['form: true,'] : [])];
        const ns = op.soap?.namespaces;
        const request = [
          'cy.request({',
          `  method: ${jsStr(op.method)},`,
          `  url: ${jsVal(op.url)},`,
          ...(headers.length ? [`  headers: { ${headers.join(', ')} },`] : []),
          ...(qs.length ? [`  qs: { ${qs.join(', ')} },`] : []),
          ...body.map((b) => `  ${b}`),
          '  failOnStatusCode: false,',
          '}).then((response) => {',
          '  const res = toResult(response);',
          // A SOAP fault fails the step in StepForge, unless the step allows it.
          ...(op.soap && !op.soap.allowFault ? ['  expectNoFault(res.text);'] : []),
          // A fixed code reads best as to.eq(201); anything else goes through check(), which compares "201" == 201.
          ...op.asserts.map((a) =>
            a.target === 'status' && a.operator === 'equals' && statusCode(a.expected) !== null
              ? `  expect(res.status, 'status').to.eq(${statusCode(a.expected)});`
              : `  ${checkLine(responseValue('res', a.target, ns), a)}`,
          ),
          ...(op.into ? [`  ${jsVar(op.into)} = res.body;`] : []),
          '  last.api = res;',
          '});',
        ];
        s.lastSoap = ns;
        if (op.auth?.type === 'oauth2') {
          const a = op.auth;
          emit([
            `oauth2Token({ tokenUrl: ${jsText(a.tokenUrl)}, clientId: ${jsText(a.clientId)}, clientSecret: ${jsText(a.clientSecret)}${a.scope ? `, scope: ${jsText(a.scope)}` : ''} }).then((token) => {`,
            ...request.map((l) => `  ${l}`),
            '});',
          ]);
        } else emit(request);
        break;
      }
      case 'apiExtract': {
        const target =
          op.from === 'status'
            ? 'status'
            : op.from === 'header'
              ? `header:${op.name ?? ''}`
              : (op.path ?? 'body');
        emit([`${jsVar(op.into)} = ${responseValue('last.api', target, s.lastSoap)};`]);
        break;
      }
      case 'setVar':
        emit([`${jsVar(op.name)} = ${jsVal(op.value)};`]);
        break;
      case 'gen':
        emit([
          `${jsVar(op.into)} = fake(${jsStr(op.kind)}${Object.keys(op.opts).length ? `, ${jsJson(op.opts)}` : ''});`,
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
          `${op.into ? `${jsVar(op.into)} = ` : ''}((vars, data) => {`,
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
          // Always `item`: the name as a variable could be a reserved word or shadow index/vars.
          s.lines.push(`${ind}  (${jsVal(op.over)}).forEach((item, index) => {`);
          s.lines.push(
            `${ind}    cy.then(() => {`,
            `${ind}      ${jsVar(op.as)} = item;`,
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
      case 'ifPage': {
        // A Cypress command cannot be an if's condition: the branch is chosen once the check has a result.
        s.lines.push(`${ind}cy.then(() => ${pageCond(op.cond)}).then((holds) => {`, `${ind}  if (holds) {`);
        printOps(op.then, s, `${ind}    `, warn);
        if (op.else.length) {
          s.lines.push(`${ind}  } else {`);
          printOps(op.else, s, `${ind}    `, warn);
        }
        s.lines.push(`${ind}  }`, `${ind}});`);
        break;
      }
      case 'while': {
        // Each pass checks first, then queues its steps and the next pass. StepForge's safety limit: the condition
        // still holding after the last pass fails the test.
        const f = `pass${++s.n}`;
        const limit = `Stopped after the limit of ${op.max} pass(es); the condition still held`;
        s.lines.push(
          `${ind}cy.then(() => {`,
          `${ind}  const ${f} = (pass) => {`,
          `${ind}    if (pass >= ${op.max}) throw new Error(${jsStr(limit)});`,
          `${ind}    vars.index = pass;`,
        );
        const next = [`${ind}      cy.then(() => ${f}(pass + 1));`];
        if (op.cond.kind === 'page') {
          s.lines.push(`${ind}    ${pageCond(op.cond)}.then((holds) => {`, `${ind}      if (!holds) return;`);
          printOps(op.body, s, `${ind}      `, warn);
          s.lines.push(...next, `${ind}    });`);
        } else {
          s.lines.push(
            `${ind}    if (!compare(${jsVal(op.cond.value)}, ${jsStr(op.cond.operator)}, ${jsVal(op.cond.expected)})) return;`,
          );
          printOps(op.body, s, `${ind}    `, warn);
          s.lines.push(next[0]!.slice(2));
        }
        s.lines.push(`${ind}  };`, `${ind}  ${f}(0);`, `${ind}});`);
        break;
      }
      case 'download':
        emit([
          `download(() => ${el(s, op.el)}).then((file) => {`,
          ...op.asserts.map((a) => `  ${checkLine(`file.${a.target}`, a)}`),
          ...(op.into ? [`  ${jsVar(op.into)} = file;`] : []),
          '});',
        ]);
        break;
      case 'waitResponse': {
        const o = [
          `url: ${jsVal(op.url)}`,
          ...(op.method ? [`method: ${jsStr(op.method)}`] : []),
          ...(op.status !== undefined ? [`status: ${op.status}`] : []),
          `timeoutMs: ${op.timeoutMs}`,
        ];
        emit([
          `waitForResponse({ ${o.join(', ')} }).then((res) => {`,
          ...op.asserts.map((a) => `  ${checkLine(responseValue('res', a.target), a)}`),
          ...(op.into ? [`  ${jsVar(op.into)} = res.body;`] : []),
          '});',
        ]);
        break;
      }
      case 'mockRoute': {
        const o = [
          `url: ${jsVal(op.url)}`,
          ...(op.method ? [`method: ${jsStr(op.method)}`] : []),
          `action: ${jsStr(op.action)}`,
          ...(op.action === 'fulfill'
            ? [
                `status: ${op.status}`,
                ...(op.body ? [`body: ${jsVal(op.body, '  ')}`] : []),
                ...(op.contentType ? [`contentType: ${jsStr(op.contentType)}`] : []),
              ]
            : []),
          ...(op.delayMs && op.action !== 'remove' ? [`delayMs: ${op.delayMs}`] : []),
          ...(op.times !== undefined && op.action !== 'remove' ? [`times: ${op.times}`] : []),
        ];
        emit([`mockRoute({ ${o.join(', ')} });`]);
        break;
      }
      case 'offline':
        // Not reached: CYPRESS_FEATURES leaves it out.
        break;
      case 'storage': {
        const o = [
          `kind: ${jsStr(op.kind)}`,
          `action: ${jsStr(op.action)}`,
          ...(op.action !== 'clear' ? [`name: ${jsText(op.name)}`] : []),
          ...(op.action === 'set' ? [`value: ${jsText(op.value)}`] : []),
        ];
        emit(
          op.action === 'get' && (op.asserts.length || op.into)
            ? [
                `storage({ ${o.join(', ')} }).then((stored) => {`,
                ...op.asserts.map((a) => `  ${checkLine(`stored.${a.target}`, a)}`),
                ...(op.into ? [`  ${jsVar(op.into)} = stored.value;`] : []),
                '});',
              ]
            : [`storage({ ${o.join(', ')} });`],
        );
        break;
      }
      case 'clock':
        if (op.action === 'set') emit([`fixClock(${timeCy(op.time!)});`]);
        else {
          // cy.clock() stops time: a clock that runs on from a time, and moving it forward, are not the same thing.
          warn(
            op.action === 'install'
              ? 'a page clock that runs on from a set time is not exported to Cypress (cy.clock stops time); fix the time instead'
              : 'moving the page clock forward is not exported to Cypress (cy.tick needs a stopped clock)',
            'ui.setClock',
          );
          emit([
            `// TODO(StepForge): ui.setClock (${op.action}) — cy.clock() stops time, so this is not the same in Cypress`,
          ]);
        }
        break;
      case 'kafka': {
        const task =
          op.action === 'produce'
            ? `cy.task('kafka:produce', { options: ${jsVal(op.params, '  ')}, timeoutMs: ${op.timeoutMs} }, { timeout: ${op.timeoutMs + 15000} })`
            : `cy.task('kafka:consume', { options: ${jsVal(op.params, '  ')}, since: testStart, timeoutMs: ${op.timeoutMs} }, { timeout: ${op.timeoutMs + 15000} })`;
        emit(
          op.asserts.length || op.into
            ? [
                `${task}.then((message) => {`,
                ...op.asserts.map((a) => `  ${checkLine(`pickMessage(message, ${jsStr(a.target)})`, a)}`),
                ...(op.into ? [`  ${jsVar(op.into)} = message;`] : []),
                '});',
              ]
            : [`${task};`],
        );
        break;
      }
      case 'ftp': {
        const task = `cy.task('ftp', ${jsVal(op.params, '  ')}, { timeout: 60000 })`;
        emit(
          op.asserts.length || op.into
            ? [
                `${task}.then((result) => {`,
                ...op.asserts.map((a) =>
                  FTP_TARGETS.includes(a.target)
                    ? `  ${checkLine(`result.${a.target}`, a)}`
                    : `  // TODO(StepForge): an FTP ${op.action} has no "${a.target}" to check`,
                ),
                ...(op.into
                  ? [
                      `  ${jsVar(op.into)} = ${op.action === 'list' ? 'result.entries' : op.action === 'exists' ? 'result.exists' : 'result'};`,
                    ]
                  : []),
                '});',
              ]
            : [`${task};`],
        );
        break;
      }
      case 'mongo':
        emit([
          `cy.task('mongo:run', { connection: ${jsStr(op.connection)}, command: ${jsVal(op.command, '  ')} }).then((result) => {`,
          ...op.asserts.map((a) => `  ${checkLine(`pick(result, ${jsStr(a.target)})`, a)}`),
          ...(op.into ? [`  ${jsVar(op.into)} = result.rows;`] : []),
          '  last.db = result;',
          '});',
        ]);
        break;
      case 'netSummary':
        // Not reached: CYPRESS_FEATURES leaves it out.
        break;
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
          ...(op.into ? [`  ${jsVar(op.into)} = result.rows;`] : []),
          '  last.db = result;',
          '});',
        ]);
        break;
      case 'dbExtract':
        emit([`${jsVar(op.into)} = pick(last.db, ${jsStr(op.path)});`]);
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
          ...(op.into ? [`  ${jsVar(op.into)} = email;`] : []),
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
        emit([`${jsVar(op.into)} = ${call};`]);
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

const WEB = [
  'watchNetwork',
  'waitForResponse',
  'mockRoute',
  'storage',
  'download',
  'fixClock',
  'clockTime',
  'pageCondition',
  'pickMessage',
  'byTestId',
  'byRole',
  'byLabelText',
  'byPlaceholderText',
  'byText',
  'byCss',
  'byXPath',
];

function specFile(plan: Plan, t: TestPlan, path: string, warn: (m: string, step?: string) => void): string {
  // Specs live under cypress/e2e/…; support files under cypress/support.
  const up = '../'.repeat(path.split('/').length - 2);
  const s: State = { lines: [], pages: new Map(), xpath: false, usesUi: t.usesUi, n: 0 };
  let watch = false;
  walk(t.ops, (o) => (watch ||= o.op === 'waitResponse'));
  printOps(t.ops, s, '      ', warn);
  // Responses are recorded from the start of the test, as StepForge does.
  if (watch) s.lines.unshift('      watchNetwork();');
  const body = s.lines.join('\n');
  const code = body.replace(/\/\/.*$/gm, '');
  const uses = (names: string[]) => names.filter((x) => new RegExp(`\\b${x}\\(`).test(code));
  const web = uses(WEB);
  const xml = uses(['xpathValue', 'expectNoFault']);
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
    ...(/\btoResult\(|\bbasicAuth\(|\boauth2Token\(/.test(code)
      ? [
          `import { ${['toResult', 'basicAuth', 'oauth2Token'].filter((x) => code.includes(`${x}(`)).join(', ')} } from '${up}support/api.js';`,
        ]
      : []),
    ...(web.length ? [`import { ${web.join(', ')} } from '${up}support/web.js';`] : []),
    ...(xml.length ? [`import { ${xml.join(', ')} } from '${up}support/xml.js';`] : []),
    ...(uses(['expectSchema']).length ? [`import { expectSchema } from '${up}support/schema.js';`] : []),
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

const tokens = new Map();

/**
 * An OAuth2 access token (client-credentials grant), as StepForge fetches it: the client id and secret as Basic
 * auth, grant_type and scope as a form; kept until shortly before it expires.
 */
export function oauth2Token(o) {
  const key = \`\${o.tokenUrl}|\${o.clientId}|\${o.scope ?? ''}\`;
  const hit = tokens.get(key);
  if (hit && hit.expires > Date.now()) return cy.wrap(hit.token, { log: false });
  return cy
    .request({
      method: 'POST',
      url: o.tokenUrl,
      form: true,
      body: { grant_type: 'client_credentials', ...(o.scope ? { scope: o.scope } : {}) },
      headers: { Authorization: basicAuth(o.clientId, o.clientSecret) },
      failOnStatusCode: false,
    })
    .then((response) => {
      const json = typeof response.body === 'string' ? JSON.parse(response.body || '{}') : response.body;
      if (response.status >= 300 || !json?.access_token)
        throw new Error(\`OAuth2 token request failed with \${response.status}\`);
      tokens.set(key, { token: json.access_token, expires: Date.now() + Math.max(30, (json.expires_in ?? 300) - 30) * 1000 });
      return json.access_token;
    });
}

/** "**\\/patients/*" style URL patterns. */
export const globToRegExp = (glob) =>
  new RegExp(String(glob).replace(/[.+^\${}()|[\\]\\\\]/g, '\\\\$&').replace(/\\*\\*/g, '.*').replace(/(?<!\\.)\\*/g, '[^/]*'));
`;

/** What the Cypress export prints beyond the basic steps (see features.ts). */
export const CYPRESS_FEATURES: Features = {
  tap: true,
  download: true,
  waitResponse: true,
  mockRoute: true,
  offline:
    'going offline is not exported to {target}: it has no offline mode of its own (only through the Chrome DevTools protocol, which its own runner uses too); test the offline page by hand',
  storage: true,
  clock: true,
  netSummary:
    'the network summary is not exported to {target}: it does not see the size of each response or the requests the page lost; check the traffic in StepForge',
  pageCondition: true,
  repeatWhile: true,
  soap: true,
  schema: true,
  oauth2: true,
  kafka: true,
  ftp: true,
  mongo: true,
};

export function generateCypress(plan: Plan, o: CodegenOptions): GeneratedProject {
  const files: Record<string, string> = {};
  const warnings = [...plan.warnings];
  for (const t of plan.tests) {
    const path = testPath(t, (b) => `${b}.cy.js`, 'cypress/e2e');
    files[path] = specFile(plan, t, path, (message, step) =>
      warnings.push({ scenario: t.scenario.name, ...(step && { step }), message }),
    );
  }
  const all = Object.values(files).join('\n');
  const usesDb = /cy\.task\('db:/.test(all);
  const usesMail = /cy\.task\('mail:/.test(all);
  const has = (re: RegExp) => re.test(all.replace(/\/\/.*$/gm, ''));
  const usesDownloads = has(/\bdownload\(/);
  const usesKafka = has(/cy\.task\('kafka:/);
  const usesFtp = has(/cy\.task\('ftp'/);
  const usesMongo = has(/cy\.task\('mongo:/);
  const usesWeb = has(/from '(\.\.\/)+support\/web\.js'/);
  const usesSchema = has(/\bexpectSchema\(/);
  const tasks = usesDb || usesMail || usesDownloads || usesKafka || usesFtp || usesMongo;
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
        ...(usesWeb && { '@testing-library/dom': '^10.4.0' }),
        ...(usesSchema && { ajv: '^8.17.1', 'ajv-formats': '^3.0.1' }),
        ...(usesKafka && { kafkajs: '^2.2.4' }),
        ...(usesFtp && { 'basic-ftp': '^6.2.3', 'ssh2-sftp-client': '^12.1.1' }),
        ...(usesMongo && { mongodb: '^7.7.0' }),
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
    ...(usesDownloads ? ["const { downloadTasks } = require('./cypress/plugins/downloads.cjs');"] : []),
    ...(usesKafka ? ["const kafka = require('./cypress/plugins/kafka.cjs');"] : []),
    ...(usesFtp ? ["const { ftp } = require('./cypress/plugins/ftp.cjs');"] : []),
    ...(usesMongo ? ["const mongo = require('./cypress/plugins/mongo.cjs');"] : []),
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
    ...(tasks
      ? [
          `    setupNodeEvents(on${usesDownloads ? ', config' : ''}) {`,
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
          ...(usesDownloads ? ['        ...downloadTasks(config.downloadsFolder),'] : []),
          ...(usesKafka
            ? [
                "        'kafka:produce': ({ options, timeoutMs }) => kafka.produce(options, timeoutMs),",
                "        'kafka:consume': ({ options, since, timeoutMs }) => kafka.consume(options, new Date(since), timeoutMs),",
              ]
            : []),
          ...(usesFtp ? ['        ftp: (options) => ftp(options),'] : []),
          ...(usesMongo
            ? ["        'mongo:run': ({ connection, command }) => mongo.run(connection, command),"]
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
    '/** A JavaScript error on the page is logged, not fatal: like StepForge and Playwright, a test fails on its own checks. */',
    "Cypress.on('uncaught:exception', (err) => {",
    "  Cypress.log({ name: 'page error', message: err.message });",
    '  return false;',
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
  if (usesWeb) files['cypress/support/web.js'] = `// ${CREDIT}\n${runtime('cypress/web.js')}`;
  if (has(/from '(\.\.\/)+support\/xml\.js'/))
    files['cypress/support/xml.js'] = `// ${CREDIT}\n${runtime('cypress/xml.js')}`;
  if (usesSchema) files['cypress/support/schema.js'] = compiled('ts/schema.ts', 'esm');
  if (usesDownloads) files['cypress/plugins/downloads.cjs'] = compiled('cypress/downloads.ts', 'cjs');
  if (usesKafka) files['cypress/plugins/kafka.cjs'] = bundled('ts/kafka.ts');
  if (usesFtp) files['cypress/plugins/ftp.cjs'] = bundled('ts/ftp.ts');
  if (usesMongo) files['cypress/plugins/mongo.cjs'] = bundled('ts/mongo.ts');
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
      ...(tasks
        ? [
            '`cypress/plugins/` — Node tasks (database, Mailpit, downloads, Kafka, FTP, MongoDB as the tests need)',
          ]
        : []),
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
