import { frameChain } from '@stepforge/core';
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
import { camel, envName, kebab, parseString, val, type Val } from '../values.ts';

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
  /** Namespaces of the last SOAP response, for XPath in a later extract. */
  lastSoap?: Record<string, string>;
  /** The test checks the traffic "since the last navigation": each goto marks it. */
  marksNavigation?: boolean;
};

export const next = (s: State, k: string) => `${k}${(s.n[k] = (s.n[k] ?? 0) + 1)}`;

/** Every feature: the Playwright Test export prints all of them. */
export const PLAYWRIGHT_TS_FEATURES: Features = {
  tap: true,
  download: true,
  waitResponse: true,
  mockRoute: true,
  offline: true,
  storage: true,
  clock: true,
  netSummary: true,
  pageCondition: true,
  repeatWhile: true,
  soap: true,
  schema: true,
  oauth2: true,
  kafka: true,
  ftp: true,
  mongo: true,
};

/** An assertion line: check() with StepForge's operators, or a JSON Schema check. */
function checkLine(actual: string, a: { target: string; operator: string; expected: Val }): string {
  return a.operator === 'matchesSchema'
    ? `expectSchema(${actual}, ${jsVal(a.expected)}, ${jsStr(`${a.target} matches the JSON schema`)});`
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
function timeTs(v: Val): string {
  if (v.t === 'num') return `new Date(${v.v})`;
  if (v.t === 'str' && v.parts.every((x) => typeof x === 'string')) return `new Date(${jsVal(v)})`;
  return `clockTime(${jsVal(v)})`;
}

const TRAFFIC = /^(requests|bytes):(.+)$/;

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
      out(`${jsVar(op.into)} = ${op.regex ? `capture(String(${value}), ${jsStr(op.regex)})` : value};`);
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
        out(`// ${oneLine(op.text)}`);
        break;
      case 'todo':
        out(`// TODO(StepForge): ${oneLine(op.text)}`);
        break;
      case 'goto':
        if (s.marksNavigation) out('network.navigated();');
        out(`await ${s.pageVar}.goto(${jsVal(op.url)});`);
        break;
      case 'act': {
        const l = loc(s, op.el);
        const call: Record<string, string> = {
          // Needs a touch screen: the spec turns hasTouch on.
          tap: 'tap()',
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
        out(`${jsVar(op.into)} = ${op.regex ? `capture(${value}, ${jsStr(op.regex)})` : value};`);
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
          // `#outer >>> #inner`: a frame inside a frame.
          const chain = frameChain(op.selector).map((x) => `.frameLocator(${jsStr(x)})`);
          out(`const ${f} = ${s.pageVar}${chain.join('')};`);
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
        if (op.auth?.type === 'oauth2') {
          const t = next(s, 'token');
          const scope = op.auth.scope ? `, scope: ${jsText(op.auth.scope)}` : '';
          out(
            `const ${t} = await oauth2Token(request, { tokenUrl: ${jsText(op.auth.tokenUrl)}, clientId: ${jsText(op.auth.clientId)}, clientSecret: ${jsText(op.auth.clientSecret)}${scope} });`,
          );
          headers.push(`Authorization: \`Bearer \${${t}}\``);
        }
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
        // A SOAP fault fails the step in StepForge, unless the step allows it.
        if (op.soap && !op.soap.allowFault) out(`expectNoFault(${r}.text);`);
        for (const a of op.asserts) {
          // A fixed code reads best as toBe(201); anything else goes through check(), which compares "201" == 201.
          const code =
            a.target === 'status' && a.operator === 'equals' && !appium ? statusCode(a.expected) : null;
          if (code !== null) out(`expect(${r}.status, 'status').toBe(${code});`);
          else out(checkLine(responseValue(r, a.target, op.soap?.namespaces), a));
        }
        if (op.into) out(`${jsVar(op.into)} = ${r}.body;`);
        s.lastApi = r;
        s.lastSoap = op.soap?.namespaces;
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
            ? `${jsVar(op.into)} = ${responseValue(s.lastApi, target, s.lastSoap)};`
            : '// TODO(StepForge): api.extract without an earlier request',
        );
        break;
      }
      case 'setVar':
        out(`${jsVar(op.name)} = ${jsVal(op.value, ind)};`);
        break;
      case 'gen':
        out(
          `${jsVar(op.into)} = fake(${jsStr(op.kind)}${Object.keys(op.opts).length ? `, ${jsJson(op.opts)}` : ''});`,
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
        out(`${op.into ? `${jsVar(op.into)} = ` : ''}await (async (vars: Vars, data: Vars) => {`);
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
          // Always `item`: the name as a variable could be a reserved word or shadow index/vars.
          out(`for (const [index, item] of (${jsVal(op.over)} as unknown[]).entries()) {`);
          out(`  ${jsVar(op.as)} = item;`);
          out('  vars.index = index;');
        } else {
          out(`for (let index = 0; index < ${jsNum(op.count!)}; index++) {`);
          out('  vars.index = index;');
        }
        printOps(op.body, s, `${ind}  `);
        out('}');
        break;
      case 'ifPage':
        out(`if (${pageCondition(s, op.cond)}) {`);
        printOps(op.then, s, `${ind}  `);
        if (op.else.length) {
          out('} else {');
          printOps(op.else, s, `${ind}  `);
        }
        out('}');
        break;
      case 'while': {
        // StepForge's safety limit: the condition still holding after the last pass fails the test.
        const n = next(s, 'pass');
        out(`let ${n} = 0;`);
        out(`for (; ${n} < ${op.max}; ${n}++) {`);
        out(`  vars.index = ${n};`);
        out(
          op.cond.kind === 'page'
            ? `  if (!(${pageCondition(s, op.cond)})) break;`
            : `  if (!compare(${jsVal(op.cond.value)}, ${jsStr(op.cond.operator)}, ${jsVal(op.cond.expected)})) break;`,
        );
        printOps(op.body, s, `${ind}  `);
        out('}');
        out(
          `if (${n} >= ${op.max}) throw new Error(${jsStr(`Stopped after the limit of ${op.max} pass(es); the condition still held`)});`,
        );
        break;
      }
      case 'download': {
        const f = next(s, 'file');
        out(`const ${f} = await download(${s.pageVar}, ${loc(s, op.el)}, test.info().outputDir);`);
        for (const a of op.asserts)
          out(checkLine(a.target === 'content' ? `fileText(${f})` : `${f}.${a.target}`, a));
        if (op.into) out(`${jsVar(op.into)} = ${f};`);
        break;
      }
      case 'waitResponse': {
        const r = next(s, 'response');
        const o = [
          `url: ${jsVal(op.url)}`,
          ...(op.method ? [`method: ${jsStr(op.method)}`] : []),
          ...(op.status !== undefined ? [`status: ${op.status}`] : []),
          `timeoutMs: ${op.timeoutMs}`,
        ];
        out(`const ${r} = await network.waitForResponse({ ${o.join(', ')} });`);
        for (const a of op.asserts) out(checkLine(responseValue(r, a.target), a));
        if (op.into) out(`${jsVar(op.into)} = ${r}.body;`);
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
                ...(op.body ? [`body: ${jsVal(op.body, ind)}`] : []),
                ...(op.contentType ? [`contentType: ${jsStr(op.contentType)}`] : []),
              ]
            : []),
          ...(op.delayMs && op.action !== 'remove' ? [`delayMs: ${op.delayMs}`] : []),
          ...(op.times !== undefined && op.action !== 'remove' ? [`times: ${op.times}`] : []),
        ];
        out(`await mockRoute(${s.pageVar}.context(), { ${o.join(', ')} });`);
        break;
      }
      case 'offline':
        out(`await ${s.pageVar}.context().setOffline(${op.offline});`);
        break;
      case 'storage': {
        const o = [
          `kind: ${jsStr(op.kind)}`,
          `action: ${jsStr(op.action)}`,
          ...(op.action !== 'clear' ? [`name: ${jsText(op.name)}`] : []),
          ...(op.action === 'set' ? [`value: ${jsText(op.value)}`] : []),
        ];
        if (op.action !== 'get') {
          out(`await storage(${s.pageVar}, { ${o.join(', ')} });`);
          break;
        }
        const v = next(s, 'stored');
        out(`const ${v} = await storage(${s.pageVar}, { ${o.join(', ')} });`);
        for (const a of op.asserts) out(checkLine(`${v}.${a.target}`, a));
        if (op.into) out(`${jsVar(op.into)} = ${v}.value;`);
        break;
      }
      case 'clock':
        out(
          op.action === 'fastForward'
            ? `await ${s.pageVar}.clock.fastForward(${op.ms});`
            : op.action === 'install'
              ? `await ${s.pageVar}.clock.install(${op.time ? `{ time: ${timeTs(op.time)} }` : ''});`
              : `await ${s.pageVar}.clock.setFixedTime(${timeTs(op.time!)});`,
        );
        break;
      case 'netSummary': {
        const t = next(s, 'traffic');
        out(`const ${t} = await network.summary(${s.pageVar}, ${jsStr(op.since)});`);
        for (const a of op.asserts) {
          const m = TRAFFIC.exec(a.target);
          out(checkLine(m ? `(${t}.byType[${jsStr(m[2]!)}]?.${m[1]} ?? 0)` : `${t}.${a.target}`, a));
        }
        if (op.into) out(`${jsVar(op.into)} = ${t};`);
        break;
      }
      case 'kafka': {
        const k = next(s, 'message');
        // Kept in a variable only when something reads it.
        const keep = op.asserts.length || op.into ? `const ${k} = ` : '';
        out(
          op.action === 'produce'
            ? `${keep}await kafka.produce(${jsVal(op.params, ind)}, ${op.timeoutMs});`
            : `${keep}await kafka.consume(${jsVal(op.params, ind)}, testStart, ${op.timeoutMs});`,
        );
        for (const a of op.asserts) out(checkLine(`pickMessage(${k}, ${jsStr(a.target)})`, a));
        if (op.into) out(`${jsVar(op.into)} = ${k};`);
        break;
      }
      case 'ftp': {
        const f = next(s, 'ftp');
        out(`${op.asserts.length || op.into ? `const ${f} = ` : ''}await ftp(${jsVal(op.params, ind)});`);
        for (const a of op.asserts)
          out(
            FTP_TARGETS.includes(a.target)
              ? checkLine(`${f}.${a.target}`, a)
              : `// TODO(StepForge): an FTP ${op.action} has no "${a.target}" to check`,
          );
        if (op.into)
          out(
            `${jsVar(op.into)} = ${op.action === 'list' ? `${f}.entries` : op.action === 'exists' ? `${f}.exists` : f};`,
          );
        break;
      }
      case 'mongo': {
        const r = next(s, 'db');
        out(`const ${r} = await mongo.run(${jsStr(op.connection)}, ${jsVal(op.command, ind)});`);
        for (const a of op.asserts) out(checkLine(`pick(${r}, ${jsStr(a.target)})`, a));
        if (op.into) out(`${jsVar(op.into)} = ${r}.rows;`);
        s.lastDb = r;
        break;
      }
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
        if (op.into) out(`${jsVar(op.into)} = ${r}.rows;`);
        s.lastDb = r;
        break;
      }
      case 'dbExtract':
        out(
          s.lastDb
            ? `${jsVar(op.into)} = pick(${s.lastDb}, ${jsStr(op.path)});`
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
        if (op.into) out(`${jsVar(op.into)} = ${m};`);
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
        out(`${jsVar(op.into)} = ${call};`);
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

const FTP_TARGETS = ['content', 'size', 'path', 'count', 'names', 'exists'];

/** `await pageCondition(…)` for a page condition on the step's element. */
function pageCondition(s: State, c: PageCond): string {
  const args = [loc(s, c.el), jsStr(c.check)];
  const expected = c.expected ? (c.check === 'count' ? jsNum(c.expected) : jsText(c.expected)) : 'undefined';
  if (c.expected || c.timeoutMs !== 2000) args.push(expected);
  if (c.timeoutMs !== 2000) args.push(String(c.timeoutMs));
  return `await pageCondition(${args.join(', ')})`;
}

export function needs(t: TestPlan) {
  const flat: Op[] = [];
  walk(t.ops, (o) => flat.push(o));
  const has = (k: Op['op']) => flat.some((o) => o.op === k);
  const api = flat.filter((o): o is Extract<Op, { op: 'api' }> => o.op === 'api');
  return {
    flat,
    tabs: has('tab') || has('closeTab'),
    api: has('api') || (has('emailOpenLink') && !t.usesUi),
    db: has('db'),
    mail: has('emailWait'),
    script: has('script'),
    tap: flat.some((o) => o.op === 'act' && o.action === 'tap'),
    network: has('waitResponse') || has('netSummary'),
    sinceNavigation: flat.some((o) => o.op === 'netSummary' && o.since === 'lastNavigation'),
    soap: api.some((o) => o.soap),
    schema: flat.some((o) => 'asserts' in o && o.asserts.some((a) => a.operator === 'matchesSchema')),
    oauth2: api.some((o) => o.auth?.type === 'oauth2'),
    kafka: has('kafka'),
    consume: flat.some((o) => o.op === 'kafka' && o.action === 'consume'),
    ftp: has('ftp'),
    mongo: has('mongo'),
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
    marksNavigation: n.sinceNavigation,
  };
  printOps(t.ops, s, '    ');
  // Responses and traffic are recorded from the start of the test, as StepForge does.
  if (n.network) s.lines.unshift('    const network = watchNetwork(page.context(), env.baseUrl);');
  const body = s.lines.join('\n');
  const code = body.replace(/\/\/.*$/gm, '');
  const uses = (names: string[]) => names.filter((x) => new RegExp(`\\b${x}\\(`).test(code));
  const web = uses([
    'watchNetwork',
    'mockRoute',
    'download',
    'fileText',
    'storage',
    'pageCondition',
    'clockTime',
  ]);
  const xml = uses(['xpathValue', 'expectNoFault']);
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
      ? [`import { ${['api', ...uses(['basicAuth', 'oauth2Token'])].join(', ')} } from '${up}support/api';`]
      : []),
    ...(n.db ? [`import * as db from '${up}support/db';`] : []),
    ...(web.length ? [`import { ${web.join(', ')} } from '${up}support/web';`] : []),
    ...(uses(['expectSchema']).length ? [`import { expectSchema } from '${up}support/schema';`] : []),
    ...(xml.length ? [`import { ${xml.join(', ')} } from '${up}support/xml';`] : []),
    ...(n.kafka
      ? [`import * as kafka from '${up}support/kafka';`, `import { pickMessage } from '${up}support/kafka';`]
      : []),
    ...(n.ftp ? [`import { ftp } from '${up}support/ftp';`] : []),
    ...(n.mongo ? [`import * as mongo from '${up}support/mongo';`] : []),
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
    ...(n.mail || n.consume ? ['    const testStart = new Date();'] : []),
    '    const vars: Vars = {};',
    ...s.lines,
  ];
  const opts = `{ tag: [${tags.map(jsStr).join(', ')}] }`;
  // Tapping needs a touch screen, as StepForge's phone and tablet sizes have.
  const touch = n.tap ? ['  test.use({ hasTouch: true });', ''] : [];
  const fx = `{ ${fixtures.join(', ')} }`;
  if (cases.length) {
    return [
      ...head,
      'const testCases: { code: string; title: string; data: Vars }[] = [',
      ...cases.map((c) => `  { code: ${jsStr(c.code)}, title: ${jsStr(c.title)}, data: ${jsJson(c.data)} },`),
      '];',
      '',
      `test.describe(${jsStr(title)}, () => {`,
      ...touch,
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
    ...touch,
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
  const all = plan.tests.map(needs);
  const some = (k: keyof ReturnType<typeof needs>) => all.some((x) => !!x[k]);
  const deps: Record<string, string> = {
    ...(some('schema') && { ajv: '^8.17.1', 'ajv-formats': '^3.0.1' }),
    ...(some('soap') && { '@xmldom/xmldom': '^0.9.12', xpath: '^0.0.35' }),
    ...(some('kafka') && { kafkajs: '^2.2.4' }),
    ...(some('ftp') && {
      'basic-ftp': '^6.2.3',
      'ssh2-sftp-client': '^12.1.1',
      '@types/ssh2-sftp-client': '^9.0.6',
    }),
    ...(some('mongo') && { mongodb: '^7.7.0' }),
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
  const specs = Object.values(files).join('\n');
  if (/from '(\.\.\/)+support\/web'/.test(specs)) files['support/web.ts'] = runtime('ts/web.ts');
  if (some('schema')) files['support/schema.ts'] = runtime('ts/schema.ts');
  if (some('soap')) files['support/xml.ts'] = runtime('ts/xml.ts');
  if (some('kafka')) files['support/kafka.ts'] = runtime('ts/kafka.ts');
  if (some('ftp')) files['support/ftp.ts'] = runtime('ts/ftp.ts');
  if (some('mongo')) files['support/mongo.ts'] = runtime('ts/mongo.ts');
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
