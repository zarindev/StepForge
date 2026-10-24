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
import { pyInt, pyBlock, pyJson, pyStr, pyText, pyVal } from '../lang/py.ts';
import type { CodegenOptions, GeneratedProject, TargetId } from '../types.ts';
import { envName, parseString, snake, type Val } from '../values.ts';

/**
 * Python + pytest: Playwright (sync API), Selenium, Appium (phone and desktop apps) or API only (requests). API,
 * database and email steps are printed the same way for all; only the app or browser part differs.
 */
type Flavor = 'playwright' | 'selenium' | 'appium' | 'api';

const SELENIUM_NO =
  'Selenium has no {what} without Chrome DevTools; not exported to {target} (write it with the browser’s DevTools protocol)';
const API_STEPS: Features = { soap: true, schema: true, oauth2: true, kafka: true, ftp: true, mongo: true };

/** What the Python exports print beyond the basic steps (see features.ts). */
export function pythonFeatures(flavor: Flavor): Features {
  if (flavor === 'playwright')
    return {
      ...API_STEPS,
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
    };
  if (flavor === 'selenium')
    return {
      ...API_STEPS,
      tap: true,
      download: true,
      offline: true,
      storage: true,
      pageCondition: true,
      repeatWhile: true,
      waitResponse: SELENIUM_NO.replace('{what}', 'access to the page’s responses'),
      mockRoute: SELENIUM_NO.replace('{what}', 'way to fake responses'),
      clock: SELENIUM_NO.replace('{what}', 'page clock'),
      netSummary: SELENIUM_NO.replace('{what}', 'record of the page’s traffic'),
    };
  if (flavor === 'api') return { ...API_STEPS, repeatWhile: true };
  return {};
}

export function locatorPw(root: string, l: Loc): string {
  const v = (s: string) => pyText(parseString(s));
  switch (l.strategy) {
    case 'testId':
      return `${root}.get_by_test_id(${v(l.value)})`;
    case 'role':
      return l.name
        ? `${root}.get_by_role(${pyStr(l.value)}, name=${v(l.name)}, exact=True)`
        : `${root}.get_by_role(${pyStr(l.value)})`;
    case 'label':
      return `${root}.get_by_label(${v(l.value)}, exact=True)`;
    case 'placeholder':
      return `${root}.get_by_placeholder(${v(l.value)}, exact=True)`;
    case 'text':
      return `${root}.get_by_text(${v(l.value)}, exact=True)`;
    case 'xpath':
      return `${root}.locator(${v(`xpath=${l.value}`)})`;
    default:
      return `${root}.locator(${v(l.value)})`;
  }
}

/** Selenium locator tuple (strategy, value[, name]) understood by support/browser.py. */
export function locatorTuple(l: Loc): string {
  const v = (s: string) => pyText(parseString(s));
  const strategy = ['testId', 'role', 'label', 'placeholder', 'text', 'css', 'xpath'].includes(l.strategy)
    ? l.strategy
    : 'css';
  return `(${pyStr(strategy)}, ${v(l.value)}${l.name ? `, ${v(l.name)}` : ''})`;
}

type State = {
  flavor: Flavor;
  lines: string[];
  root: string;
  pageVar: string;
  n: Record<string, number>;
  lastApi?: string;
  lastDb?: string;
  lastMail?: string;
  pages: Set<string>;
  imports: Set<string>;
  usesUi: boolean;
  plan: Plan;
  /** Namespaces of the last SOAP response, for XPath in a later extract. */
  lastSoap?: Record<string, string>;
  /** The test checks the traffic "since the last navigation": each goto marks it. */
  marksNavigation?: boolean;
};

/** An assertion line: check() with StepForge's operators, or a JSON Schema check. */
function checkLine(actual: string, a: { target: string; operator: string; expected: Val }, ind = ''): string {
  return a.operator === 'matchesSchema'
    ? `expect_schema(${actual}, ${pyVal(a.expected, ind)}, ${pyStr(`${a.target} matches the JSON schema`)})`
    : `check(${actual}, ${pyStr(a.operator)}, ${pyVal(a.expected, ind)}, ${pyStr(`${a.target} ${a.operator}`)})`;
}

const XPATH = (t: string) =>
  t.startsWith('/') || t.startsWith('xpath:') || /^(count|string|number|boolean|sum)\(/.test(t);
/** XPath targets read the XML body (SOAP); the others are read as from any response. */
function responseValue(r: string, target: string, ns?: Record<string, string>): string {
  if (ns && XPATH(target))
    return `xpath_value(${r}["text"], ${pyStr(target)}${Object.keys(ns).length ? `, ${pyJson(ns)}` : ''})`;
  // A schema on the whole body ($) validates the parsed body.
  return target === '$' ? `${r}["body"]` : `pick(${r}, ${pyStr(target)})`;
}

const TRAFFIC = /^(requests|bytes):(.+)$/;
const FTP_TARGETS = ['content', 'size', 'path', 'count', 'names', 'exists'];

/** A page condition on the step's element: Playwright's locator, or the Selenium helper's locator tuple. */
function pageCondition(s: State, c: PageCond): string {
  const args = [el(s, c.el), pyStr(c.check)];
  const expected = c.expected ? (c.check === 'count' ? pyVal(c.expected) : pyText(c.expected)) : 'None';
  if (c.expected || c.timeoutMs !== 2000) args.push(expected);
  if (c.timeoutMs !== 2000) args.push(String(c.timeoutMs));
  return s.flavor === 'playwright'
    ? `page_condition(${args.join(', ')})`
    : `browser.page_condition(${args.join(', ')})`;
}

const next = (s: State, k: string) => `${k}${(s.n[k] = (s.n[k] ?? 0) + 1)}`;

/** Appium selectors as a list of (strategy, value) tuples for support/app.py. */
export function queriesPy(e: El): string {
  return `[${(e.queries ?? []).map((q) => `(${pyStr(q.using)}, ${pyText(parseString(q.value))})`).join(', ')}]`;
}

function el(s: State, e: El): string {
  if (s.flavor === 'appium') return queriesPy(e);
  if (e.pom && s.root === s.pageVar) {
    const cls = s.plan.pages.get(e.pom.page)!.className;
    s.pages.add(e.pom.page);
    return s.flavor === 'playwright'
      ? `${snake(e.pom.page)}_page.${snake(e.pom.name)}`
      : `${cls}.${snake(e.pom.name).toUpperCase()}`;
  }
  return s.flavor === 'playwright' ? locatorPw(s.root, e.loc) : locatorTuple(e.loc);
}

const PW_ASSERT: Record<string, (l: string, e: string, a?: string) => string> = {
  visible: (l) => `expect(${l}).to_be_visible()`,
  hidden: (l) => `expect(${l}).to_be_hidden()`,
  text: (l, e) => `expect(${l}).to_have_text(${e})`,
  textContains: (l, e) => `expect(${l}).to_contain_text(${e})`,
  textMatches: (l, e) => `expect(${l}).to_have_text(re.compile(${e}))`,
  value: (l, e) => `expect(${l}).to_have_value(${e})`,
  count: (l, e) => `expect(${l}).to_have_count(${e})`,
  attribute: (l, e, a) => `expect(${l}).to_have_attribute(${pyStr(a ?? '')}, ${e})`,
  enabled: (l) => `expect(${l}).to_be_enabled()`,
  disabled: (l) => `expect(${l}).to_be_disabled()`,
  checked: (l) => `expect(${l}).to_be_checked()`,
  unchecked: (l) => `expect(${l}).not_to_be_checked()`,
  url: (l, e) => `expect(${l}).to_have_url(absolute(${e}))`,
  urlContains: (l, e) => `expect(${l}).to_have_url(re.compile(re.escape(${e})))`,
  urlMatches: (l, e) => `expect(${l}).to_have_url(re.compile(${e}))`,
  title: (l, e) => `expect(${l}).to_have_title(${e})`,
  titleContains: (l, e) => `expect(${l}).to_have_title(re.compile(re.escape(${e})))`,
};

function appiumOp(op: Op, s: State, out: (l: string) => void): boolean {
  switch (op.op) {
    case 'act': {
      const l = el(s, op.el);
      const v = op.value ? pyText(op.value) : '""';
      const call: Record<string, string> = {
        click: `app.click(${l})`,
        dblclick: `app.double_click(${l})`,
        fill: `app.fill(${l}, ${v})`,
        type: `app.type(${l}, ${v})`,
        clear: `app.clear(${l})`,
        check: `app.set_checked(${l}, True)`,
        uncheck: `app.set_checked(${l}, False)`,
        scrollIntoView: `app.scroll_to(${l})`,
      };
      out(call[op.action] ?? `# TODO(StepForge): ${op.action} is not available in phone and desktop apps`);
      return true;
    }
    case 'press':
      out(`app.press(${pyStr(op.key)}${op.el ? `, ${el(s, op.el)}` : ''})`);
      return true;
    case 'assert':
      out(
        `app.expect(${pyStr(op.check)}, ${op.el ? el(s, op.el) : '[]'}${op.expected ? `, expected=${op.check === 'count' ? pyVal(op.expected) : pyText(op.expected)}` : ''}${op.attribute ? `, attribute=${pyStr(op.attribute)}` : ''})`,
      );
      return true;
    case 'read': {
      const value = `app.read(${pyStr(op.source)}, ${op.el ? el(s, op.el) : '[]'}${op.attribute ? `, attribute=${pyStr(op.attribute)}` : ''})`;
      out(`vars[${pyStr(op.into)}] = ${op.regex ? `capture(${value}, ${pyStr(op.regex)})` : value}`);
      return true;
    }
    case 'waitFor':
      out(`app.wait_for(${el(s, op.el)}, ${pyStr(op.state)})`);
      return true;
    case 'screenshot':
      out(`app.screenshot(${pyStr(op.name)}${op.el ? `, ${el(s, op.el)}` : ''})`);
      return true;
    case 'app':
      out(
        `app.${snake(op.method)}(${[...op.els.map((x) => el(s, x)), ...op.args.map((a) => pyVal(a))].join(', ')})`,
      );
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
      out(`# TODO(StepForge): ${op.op} is a web-page step; phone and desktop apps have no equivalent`);
      return true;
    default:
      return false;
  }
}

function uiOp(
  op: Op,
  s: State,
  out: ((l: string) => void) & { ind?: string },
  warn: (m: string) => void,
): boolean {
  if (s.flavor === 'appium') return appiumOp(op, s, out);
  if (s.flavor === 'api') {
    if (['comment', 'todo'].includes(op.op)) return false;
    const ui = [
      'goto',
      'act',
      'press',
      'select',
      'upload',
      'drag',
      'scroll',
      'waitFor',
      'waitUrl',
      'waitLoad',
      'assert',
      'read',
      'screenshot',
      'dialog',
      'frame',
      'tab',
      'closeTab',
    ];
    if (ui.includes(op.op)) {
      out(`# TODO(StepForge): browser step skipped (${op.op}); this export contains API tests only`);
      return true;
    }
    return false;
  }
  const pw = s.flavor === 'playwright';
  const P = s.pageVar;
  switch (op.op) {
    case 'goto':
      if (s.marksNavigation) out('network.navigated()');
      out(pw ? `${P}.goto(${pyVal(op.url)})` : `browser.goto(${pyText(op.url)})`);
      return true;
    case 'act': {
      const l = el(s, op.el);
      const v = op.value ? pyText(op.value) : '""';
      if (pw) {
        const call: Record<string, string> = {
          click: 'click()',
          dblclick: 'dblclick()',
          rightclick: 'click(button="right")',
          hover: 'hover()',
          clear: 'clear()',
          check: 'check()',
          uncheck: 'uncheck()',
          scrollIntoView: 'scroll_into_view_if_needed()',
          fill: `fill(${v})`,
          type: `press_sequentially(${v})`,
          // Needs a touch screen: the module turns has_touch on.
          tap: 'tap()',
        };
        out(`${l}.${call[op.action]}`);
      } else {
        const call: Record<string, string> = {
          click: `browser.click(${l})`,
          dblclick: `browser.click(${l}, double=True)`,
          rightclick: `browser.click(${l}, right=True)`,
          hover: `browser.hover(${l})`,
          clear: `browser.clear(${l})`,
          check: `browser.set_checked(${l}, True)`,
          uncheck: `browser.set_checked(${l}, False)`,
          scrollIntoView: `browser.scroll_into_view(${l})`,
          fill: `browser.fill(${l}, ${v})`,
          type: `browser.type(${l}, ${v})`,
          // A touch pointer (W3C actions), so the page gets touch events as from a finger.
          tap: `browser.tap(${l})`,
        };
        out(call[op.action]!);
      }
      return true;
    }
    case 'press':
      out(
        pw
          ? op.el
            ? `${el(s, op.el)}.press(${pyStr(op.key)})`
            : `${P}.keyboard.press(${pyStr(op.key)})`
          : `browser.press(${op.el ? el(s, op.el) : 'None'}, ${pyStr(op.key)})`,
      );
      return true;
    case 'select': {
      const kw =
        op.by === 'index'
          ? `index=${pyInt(op.value)}`
          : op.by === 'label'
            ? `label=${pyText(op.value)}`
            : `value=${pyText(op.value)}`;
      out(pw ? `${el(s, op.el)}.select_option(${kw})` : `browser.select(${el(s, op.el)}, ${kw})`);
      return true;
    }
    case 'upload':
      out(
        pw
          ? `${el(s, op.el)}.set_input_files([${op.files.map(pyText).join(', ')}])`
          : `browser.upload(${el(s, op.el)}, ${op.files.map(pyText).join(', ')})`,
      );
      return true;
    case 'drag':
      if (!pw) warn('HTML5 drag and drop is unreliable in Selenium; check this step');
      out(pw ? `${el(s, op.el)}.drag_to(${el(s, op.to)})` : `browser.drag(${el(s, op.el)}, ${el(s, op.to)})`);
      return true;
    case 'scroll':
      out(pw ? `${P}.mouse.wheel(${op.x}, ${op.y})` : `browser.scroll(${op.x}, ${op.y})`);
      return true;
    case 'waitFor':
      out(
        pw
          ? `${el(s, op.el)}.wait_for(state=${pyStr(op.state)})`
          : `browser.wait_for(${el(s, op.el)}, ${pyStr(op.state)})`,
      );
      return true;
    case 'waitUrl':
      out(pw ? `${P}.wait_for_url(${pyVal(op.url)})` : `browser.wait_for_url(${pyText(op.url)})`);
      return true;
    case 'waitLoad':
      out(pw ? `${P}.wait_for_load_state(${pyStr(op.state)})` : 'browser.wait_for_load()');
      return true;
    case 'assert': {
      const e = op.expected ? (op.check === 'count' ? pyInt(op.expected) : pyText(op.expected)) : '""';
      if (pw) out(PW_ASSERT[op.check]!(op.el ? el(s, op.el) : P, e, op.attribute));
      else
        out(
          `browser.expect(${pyStr(op.check)}${op.el ? `, ${el(s, op.el)}` : ''}${op.expected ? `, expected=${op.check === 'count' ? pyVal(op.expected) : pyText(op.expected)}` : ''}${op.attribute ? `, attribute=${pyStr(op.attribute)}` : ''})`,
        );
      return true;
    }
    case 'read': {
      let value: string;
      if (pw) {
        const l = op.el ? el(s, op.el) : '';
        value = {
          text: `(${l}.text_content() or "").strip()`,
          value: `${l}.input_value()`,
          attribute: `${l}.get_attribute(${pyStr(op.attribute ?? '')})`,
          count: `${l}.count()`,
          url: `${P}.url`,
          title: `${P}.title()`,
        }[op.source];
      } else {
        value = `browser.read(${pyStr(op.source)}${op.el ? `, ${el(s, op.el)}` : ''}${op.attribute ? `, attribute=${pyStr(op.attribute)}` : ''})`;
      }
      out(`vars[${pyStr(op.into)}] = ${op.regex ? `capture(${value}, ${pyStr(op.regex)})` : value}`);
      return true;
    }
    case 'screenshot':
      out(
        pw
          ? `${op.el ? el(s, op.el) : P}.screenshot(path=${pyStr(`screenshots/${op.name}.png`)}${!op.el && op.fullPage ? ', full_page=True' : ''})`
          : `browser.screenshot(${pyStr(op.name)}${op.el ? `, ${el(s, op.el)}` : ''})`,
      );
      return true;
    case 'dialog':
      out(
        pw
          ? `${P}.once("dialog", lambda dialog: dialog.${op.accept ? `accept(${op.promptText ? pyText(op.promptText) : ''})` : 'dismiss()'})`
          : `browser.handle_next_dialog(accept=${op.accept ? 'True' : 'False'}${op.promptText ? `, prompt_text=${pyText(op.promptText)}` : ''})`,
      );
      return true;
    case 'frame':
      if (pw) {
        if (op.selector === null) s.root = P;
        else {
          const f = next(s, 'frame');
          const chain = frameChain(op.selector).map((x) => `.frame_locator(${pyStr(x)})`);
          out(`${f} = ${P}${chain.join('')}`);
          s.root = f;
        }
      } else out(`browser.frame(${op.selector === null ? '' : pyStr(op.selector)})`);
      return true;
    case 'tab':
      if (pw) {
        s.imports.add('tabs');
        out(
          `current = switch_tab(page.context${op.index !== undefined ? `, index=${op.index}` : op.urlContains !== undefined ? `, url_contains=${pyStr(op.urlContains)}` : ''})`,
        );
        s.root = P;
      } else
        out(
          `browser.switch_tab(${op.index !== undefined ? `index=${op.index}` : op.urlContains !== undefined ? `url_contains=${pyStr(op.urlContains)}` : ''})`,
        );
      return true;
    case 'closeTab':
      if (pw) {
        out('current.close()');
        out('current = page.context.pages[-1]');
        s.root = P;
      } else out('browser.close_tab()');
      return true;
    case 'download': {
      const f = next(s, 'file');
      out(pw ? `${f} = download(${P}, ${el(s, op.el)})` : `${f} = browser.download(${el(s, op.el)})`);
      for (const a of op.asserts)
        out(checkLine(a.target === 'content' ? `file_text(${f})` : `${f}[${pyStr(a.target)}]`, a));
      if (op.into) out(`vars[${pyStr(op.into)}] = ${f}`);
      return true;
    }
    case 'waitResponse': {
      const r = next(s, 'response');
      const kw = [
        `url=${pyVal(op.url)}`,
        ...(op.method ? [`method=${pyStr(op.method)}`] : []),
        ...(op.status !== undefined ? [`status=${op.status}`] : []),
        `timeout_ms=${op.timeoutMs}`,
      ];
      out(`${r} = network.wait_for_response(${P}, ${kw.join(', ')})`);
      for (const a of op.asserts) out(checkLine(responseValue(r, a.target), a));
      if (op.into) out(`vars[${pyStr(op.into)}] = ${r}["body"]`);
      return true;
    }
    case 'mockRoute': {
      const kw = [
        `url=${pyVal(op.url)}`,
        ...(op.method ? [`method=${pyStr(op.method)}`] : []),
        `action=${pyStr(op.action)}`,
        ...(op.action === 'fulfill'
          ? [
              `status=${op.status}`,
              ...(op.body ? [`body=${pyVal(op.body, ind(out))}`] : []),
              ...(op.contentType ? [`content_type=${pyStr(op.contentType)}`] : []),
            ]
          : []),
        ...(op.delayMs && op.action !== 'remove' ? [`delay_ms=${op.delayMs}`] : []),
        ...(op.times !== undefined && op.action !== 'remove' ? [`times=${op.times}`] : []),
      ];
      out(`mock_route(${P}.context, ${kw.join(', ')})`);
      return true;
    }
    case 'offline':
      out(
        pw
          ? `${P}.context.set_offline(${op.offline ? 'True' : 'False'})`
          : `browser.set_offline(${op.offline ? 'True' : 'False'})`,
      );
      return true;
    case 'storage': {
      const kw = [
        `kind=${pyStr(op.kind)}`,
        `action=${pyStr(op.action)}`,
        ...(op.action !== 'clear' ? [`name=${pyText(op.name)}`] : []),
        ...(op.action === 'set' ? [`value=${pyText(op.value)}`] : []),
      ];
      const call = pw ? `storage(${P}, ${kw.join(', ')})` : `browser.storage(${kw.join(', ')})`;
      if (op.action !== 'get') {
        out(call);
        return true;
      }
      const v = next(s, 'stored');
      out(`${v} = ${call}`);
      for (const a of op.asserts) out(checkLine(`${v}[${pyStr(a.target)}]`, a));
      if (op.into) out(`vars[${pyStr(op.into)}] = ${v}["value"]`);
      return true;
    }
    case 'clock':
      out(
        op.action === 'fastForward'
          ? `${P}.clock.fast_forward(${op.ms})`
          : op.action === 'install'
            ? `${P}.clock.install(${op.time ? `time=clock_time(${pyVal(op.time)})` : ''})`
            : `${P}.clock.set_fixed_time(clock_time(${pyVal(op.time!)}))`,
      );
      return true;
    case 'netSummary': {
      const t = next(s, 'traffic');
      out(`${t} = network.summary(${P}, ${pyStr(op.since)})`);
      for (const a of op.asserts) {
        const m = TRAFFIC.exec(a.target);
        out(
          checkLine(
            m
              ? `${t}["byType"].get(${pyStr(m[2]!)}, {}).get(${pyStr(m[1]!)}, 0)`
              : `${t}[${pyStr(a.target)}]`,
            a,
          ),
        );
      }
      if (op.into) out(`vars[${pyStr(op.into)}] = ${t}`);
      return true;
    }
    default:
      return false;
  }
}

/** The indentation of the lines `out` writes (for multi-line values). */
const ind = (out: ((l: string) => void) & { ind?: string }) => out.ind ?? '';

function printOps(ops: Op[], s: State, ind: string, warn: (m: string) => void): void {
  const out = Object.assign((line: string) => s.lines.push(`${ind}${line}`), { ind });
  for (const op of ops) {
    if (uiOp(op, s, out, warn)) continue;
    switch (op.op) {
      case 'comment':
        out(`# ${oneLine(op.text)}`);
        break;
      case 'todo':
        out(`# TODO(StepForge): ${oneLine(op.text)}`);
        break;
      case 'api': {
        const r = next(s, 'res');
        const headers: string[] = op.headers.map(([k, v]) => `${pyStr(k)}: ${pyText(v)}`);
        const params: string[] = op.query.map(([k, v]) => `${pyStr(k)}: ${pyVal(v)}`);
        let auth = '';
        // Joined with +, not an f-string: before Python 3.12 an f-string cannot hold secret("…")'s quotes.
        if (op.auth?.type === 'bearer') headers.push(`"Authorization": "Bearer " + ${pyText(op.auth.token)}`);
        if (op.auth?.type === 'basic')
          auth = `auth=(${pyText(op.auth.username)}, ${pyText(op.auth.password)}), `;
        if (op.auth?.type === 'apiKey')
          (op.auth.in === 'query' ? params : headers).push(
            `${pyStr(op.auth.name)}: ${pyText(op.auth.value)}`,
          );
        if (op.auth?.type === 'cookie')
          headers.push(`"Cookie": ${pyStr(`${op.auth.name}=`)} + ${pyText(op.auth.value)}`);
        if (op.auth?.type === 'oauth2') {
          const t = next(s, 'token');
          out(
            `${t} = api.oauth2_token(${pyText(op.auth.tokenUrl)}, ${pyText(op.auth.clientId)}, ${pyText(op.auth.clientSecret)}${op.auth.scope ? `, ${pyText(op.auth.scope)}` : ''})`,
          );
          headers.push(`"Authorization": "Bearer " + ${t}`);
        }
        const i2 = `${ind}    `;
        const body =
          op.body === null || op.bodyType === 'none'
            ? []
            : op.bodyType === 'form'
              ? [`form=${pyVal(op.body, i2)},`]
              : op.bodyType === 'multipart'
                ? [`files=${pyVal(op.body, i2)},`]
                : op.bodyType === 'raw'
                  ? [`data=${pyText(op.body)},`]
                  : [`json=${pyVal(op.body, i2)},`];
        if (op.bodyType === 'multipart')
          warn('multipart fields are sent as requests "files"; file fields need open(...) objects');
        out(`${r} = api.call(`);
        out(`    http, ${pyStr(op.method)}, ${pyText(op.url)},`);
        if (headers.length) out(`    headers={${headers.join(', ')}},`);
        if (params.length) out(`    params={${params.join(', ')}},`);
        if (auth) out(`    ${auth}`);
        for (const b of body) out(`    ${b}`);
        out(')');
        // A SOAP fault fails the step in StepForge, unless the step allows it.
        if (op.soap && !op.soap.allowFault) out(`expect_no_fault(${r}["text"])`);
        for (const a of op.asserts) {
          // A fixed code reads best as == 201; anything else goes through check(), which compares "201" == 201.
          const code = a.target === 'status' && a.operator === 'equals' ? statusCode(a.expected) : null;
          if (code !== null) out(`assert ${r}["status"] == ${code}, "status"`);
          else out(checkLine(responseValue(r, a.target, op.soap?.namespaces), a, ind));
        }
        if (op.into) out(`vars[${pyStr(op.into)}] = ${r}["body"]`);
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
            ? `vars[${pyStr(op.into)}] = ${responseValue(s.lastApi, target, s.lastSoap)}`
            : '# TODO(StepForge): api.extract without an earlier request',
        );
        break;
      }
      case 'setVar':
        out(`vars[${pyStr(op.name)}] = ${pyVal(op.value, ind)}`);
        break;
      case 'gen': {
        const kw = Object.entries(op.opts).map(
          ([k, v]) => `${/^[A-Za-z_]\w*$/.test(k) ? k : snake(k)}=${pyJson(v)}`,
        );
        out(`vars[${pyStr(op.into)}] = fake(${[pyStr(op.kind), ...kw].join(', ')})`);
        break;
      }
      case 'wait':
        out(
          s.flavor === 'playwright' && s.usesUi
            ? `${s.pageVar}.wait_for_timeout(${op.ms})`
            : `time.sleep(${op.ms / 1000})`,
        );
        break;
      case 'log':
        out(`print(${pyVal(op.message)})`);
        break;
      case 'script':
        warn('JavaScript "Run script" steps are not translated to Python');
        out('# TODO(StepForge): this JavaScript step was not translated to Python:');
        // Python ends a comment at a lone CR too.
        for (const l of op.code.split(/\r\n?|\n/)) out(`#   ${l}`);
        break;
      case 'if':
        out(`if compare(${pyVal(op.value)}, ${pyStr(op.operator)}, ${pyVal(op.expected)}):`);
        if (op.then.length) printOps(op.then, s, `${ind}    `, warn);
        else out('    pass');
        if (op.else.length) {
          out('else:');
          printOps(op.else, s, `${ind}    `, warn);
        }
        break;
      case 'loop':
        if (op.over) {
          out(`for index, item in enumerate(${pyVal(op.over)}):`);
          out(`    vars[${pyStr(op.as)}] = item`);
        } else out(`for index in range(${pyInt(op.count!)}):`);
        out('    vars["index"] = index');
        printOps(op.body, s, `${ind}    `, warn);
        break;
      case 'ifPage':
        out(`if ${pageCondition(s, op.cond)}:`);
        if (op.then.length) printOps(op.then, s, `${ind}    `, warn);
        else out('    pass');
        if (op.else.length) {
          out('else:');
          printOps(op.else, s, `${ind}    `, warn);
        }
        break;
      case 'while': {
        // StepForge's safety limit: the condition still holding after the last pass fails the test.
        out(`for index in range(${op.max}):`);
        out('    vars["index"] = index');
        out(
          op.cond.kind === 'page'
            ? `    if not ${pageCondition(s, op.cond)}:`
            : `    if not compare(${pyVal(op.cond.value)}, ${pyStr(op.cond.operator)}, ${pyVal(op.cond.expected)}):`,
        );
        out('        break');
        printOps(op.body, s, `${ind}    `, warn);
        out('else:');
        out(
          `    raise AssertionError(${pyStr(`Stopped after the limit of ${op.max} pass(es); the condition still held`)})`,
        );
        break;
      }
      case 'kafka': {
        const k = next(s, 'message');
        const keep = op.asserts.length || op.into ? `${k} = ` : '';
        out(
          op.action === 'produce'
            ? `${keep}kafka.produce(${pyVal(op.params, ind)}, ${op.timeoutMs})`
            : `${keep}kafka.consume(${pyVal(op.params, ind)}, test_start, ${op.timeoutMs})`,
        );
        for (const a of op.asserts) out(checkLine(`kafka.pick_message(${k}, ${pyStr(a.target)})`, a, ind));
        if (op.into) out(`vars[${pyStr(op.into)}] = ${k}`);
        break;
      }
      case 'ftp': {
        const f = next(s, 'ftp');
        out(`${op.asserts.length || op.into ? `${f} = ` : ''}ftp(${pyVal(op.params, ind)})`);
        for (const a of op.asserts)
          out(
            FTP_TARGETS.includes(a.target)
              ? checkLine(`${f}[${pyStr(a.target)}]`, a, ind)
              : `# TODO(StepForge): an FTP ${op.action} has no "${a.target}" to check`,
          );
        if (op.into)
          out(
            `vars[${pyStr(op.into)}] = ${op.action === 'list' ? `${f}["entries"]` : op.action === 'exists' ? `${f}["exists"]` : f}`,
          );
        break;
      }
      case 'mongo': {
        const r = next(s, 'db');
        out(`${r} = mongo.run(${pyStr(op.connection)}, ${pyVal(op.command, ind)})`);
        for (const a of op.asserts) out(checkLine(`pick(${r}, ${pyStr(a.target)})`, a, ind));
        if (op.into) out(`vars[${pyStr(op.into)}] = ${r}["rows"]`);
        s.lastDb = r;
        break;
      }
      case 'check':
        out(`check(${pyVal(op.actual)}, ${pyStr(op.operator)}, ${pyVal(op.expected)}, ${pyStr(op.message)})`);
        break;
      case 'db': {
        const r = next(s, 'db');
        out(`# SQL also in ${op.sqlFile}`);
        out(
          op.kind === 'script'
            ? `${r} = db.script(${pyStr(op.connection)}, ${pyBlock(op.sql)})`
            : `${r} = db.query(${pyStr(op.connection)}, ${pyBlock(op.sql)}${op.params.length ? `, [${op.params.map((p) => pyVal(p)).join(', ')}]` : ''})`,
        );
        for (const a of op.asserts)
          out(
            `check(pick(${r}, ${pyStr(a.target)}), ${pyStr(a.operator)}, ${pyVal(a.expected)}, ${pyStr(`${a.target} ${a.operator}`)})`,
          );
        if (op.into) out(`vars[${pyStr(op.into)}] = ${r}["rows"]`);
        s.lastDb = r;
        break;
      }
      case 'dbExtract':
        out(
          s.lastDb
            ? `vars[${pyStr(op.into)}] = pick(${s.lastDb}, ${pyStr(op.path)})`
            : '# TODO(StepForge): db.extract without an earlier query',
        );
        break;
      case 'emailWait': {
        const m = next(s, 'email');
        const kw = [
          'since=test_start',
          ...(op.to ? [`to=${pyText(op.to)}`] : []),
          ...(op.from ? [`sender=${pyText(op.from)}`] : []),
          ...(op.subject ? [`subject=${pyText(op.subject)}`] : []),
          ...(op.contains ? [`contains=${pyText(op.contains)}`] : []),
          `timeout_ms=${op.timeoutMs}`,
        ];
        out(`${m} = mail.wait_for_email(${kw.join(', ')})`);
        if (op.into) out(`vars[${pyStr(op.into)}] = ${m}`);
        s.lastMail = m;
        break;
      }
      case 'emailAssert': {
        if (!s.lastMail) {
          out('# TODO(StepForge): email check without an earlier wait for email');
          break;
        }
        const names: Record<string, string> = {
          subjectContains: 'subject_contains',
          bodyContains: 'body_contains',
          from: 'sender',
          hasLink: 'has_link',
          hasAttachment: 'has_attachment',
        };
        out(
          `mail.assert_email(${s.lastMail}, ${op.checks.map((c) => `${names[c.kind]}=${c.value.t === 'bool' ? (c.value.v ? 'True' : 'False') : pyText(c.value)}`).join(', ')})`,
        );
        break;
      }
      case 'emailExtract': {
        if (!s.lastMail) {
          out('# TODO(StepForge): email extraction without an earlier wait for email');
          break;
        }
        const call =
          op.kind === 'otp'
            ? `mail.otp(${s.lastMail})`
            : op.kind === 'link'
              ? `mail.link(${s.lastMail}${op.contains ? `, contains=${pyText(op.contains)}` : ''}${op.index !== undefined ? `, index=${op.index}` : ''})`
              : `mail.extract(${s.lastMail}, ${pyStr(op.pattern ?? '(.+)')})`;
        out(`vars[${pyStr(op.into)}] = ${call}`);
        break;
      }
      case 'emailOpenLink': {
        const url = op.url
          ? pyText(op.url)
          : s.lastMail
            ? `mail.link(${s.lastMail}${op.contains ? `, contains=${pyText(op.contains)}` : ''}${op.index !== undefined ? `, index=${op.index}` : ''})`
            : '""';
        if (s.usesUi && s.flavor !== 'api' && s.flavor !== 'appium')
          out(s.flavor === 'playwright' ? `${s.pageVar}.goto(${url})` : `browser.goto(${url})`);
        else {
          const r = next(s, 'res');
          out(`${r} = api.call(http, "GET", ${url})`);
          s.lastApi = r;
        }
        break;
      }
      default:
        break;
    }
  }
}

function has(t: TestPlan, k: Op['op'] | ((o: Op) => boolean)): boolean {
  let found = false;
  walk(t.ops, (o) => {
    if (typeof k === 'function' ? k(o) : o.op === k) found = true;
  });
  return found;
}

const HELPERS = [
  'check',
  'compare',
  'pick',
  'fake',
  'field',
  'capture',
  'text',
  'random_value',
  'RUN_ID',
  'file_text',
];
const WEB = ['watch_network', 'mock_route', 'download', 'storage', 'page_condition', 'clock_time'];

function testFile(plan: Plan, t: TestPlan, flavor: Flavor, warn: (m: string) => void): string {
  const tabs = flavor === 'playwright' && (has(t, 'tab') || has(t, 'closeTab'));
  const s: State = {
    flavor,
    lines: [],
    root: tabs ? 'current' : 'page',
    pageVar: tabs ? 'current' : 'page',
    n: {},
    pages: new Set(),
    imports: new Set(),
    usesUi: t.usesUi,
    plan,
    marksNavigation: has(t, (o) => o.op === 'netSummary' && o.since === 'lastNavigation'),
  };
  printOps(t.ops, s, '    ', warn);
  // Responses and traffic are recorded from the start of the test, as StepForge does.
  if (has(t, 'waitResponse') || has(t, 'netSummary'))
    s.lines.unshift('    network = watch_network(page.context, env["base_url"])');
  const code = s.lines.join('\n').replace(/#.*$/gm, '');
  const uses = (names: string[]) => names.filter((x) => new RegExp(`(?<![.\\w])${x}\\(`).test(code));
  const web = flavor === 'playwright' ? uses(WEB) : [];
  const xml = uses(['xpath_value', 'expect_no_fault']);
  const tap = flavor === 'playwright' && has(t, (o) => o.op === 'act' && o.action === 'tap');
  const helpers = HELPERS.filter(
    (h) => new RegExp(`\\b${h}\\(|\\b${h}\\b(?!\\()`).test(code) && new RegExp(`\\b${h}\\b`).test(code),
  );
  const fixtures = [
    ...(flavor === 'playwright' && (t.usesUi || tabs) ? ['page'] : []),
    ...(flavor === 'selenium' && t.usesUi ? ['browser'] : []),
    ...(flavor === 'appium' && t.usesUi ? ['app'] : []),
    ...(/\bhttp\b/.test(code) ? ['http'] : []),
  ];
  const cases = t.scenario.testCases;
  const name = `test_${snake(t.scenario.name)}`;
  const marks = [...t.scenario.tags.map((x) => snake(x)), t.scenario.priority.toLowerCase()];
  const head = [
    ...headerLines(plan.input, t.scenario).map((l) => `# ${l}`),
    ...(/\bre\./.test(code) ? ['import re'] : []),
    ...(/\btime\./.test(code) || /\btest_start\b/.test(code) ? ['import time'] : []),
    '',
    'import pytest',
    ...(flavor === 'playwright' && /\bexpect\(/.test(code) ? ['from playwright.sync_api import expect'] : []),
    '',
    ...(/\benv\[|\bsecret\(|\babsolute\(/.test(code)
      ? [
          `from support.config import ${['absolute', 'env', 'secret'].filter((x) => new RegExp(`\\b${x}\\b`).test(code)).join(', ')}`,
        ]
      : []),
    ...(helpers.length ? [`from support.helpers import ${helpers.join(', ')}`] : []),
    ...(/\bapi\./.test(code) ? ['from support import api'] : []),
    ...(/\bdb\./.test(code) ? ['from support import db'] : []),
    ...(/\bkafka\./.test(code) ? ['from support import kafka'] : []),
    ...(/\bmongo\./.test(code) ? ['from support import mongo'] : []),
    ...(uses(['ftp']).length ? ['from support.ftp import ftp'] : []),
    ...(uses(['expect_schema']).length ? ['from support.schema import expect_schema'] : []),
    ...(xml.length ? [`from support.xml import ${xml.join(', ')}`] : []),
    ...(web.length ? [`from support.web import ${web.join(', ')}`] : []),
    ...(/\bmail\./.test(code) ? ['from support import mail'] : []),
    ...(s.imports.has('tabs') ? ['from support.tabs import switch_tab'] : []),
    ...[...s.pages].map(
      (p) => `from pages.${snake(plan.pages.get(p)!.className)} import ${plan.pages.get(p)!.className}`,
    ),
    '',
    '',
  ];
  const decorators = [
    ...marks.map((m) => `@pytest.mark.${m}`),
    ...(cases.length
      ? [
          '@pytest.mark.parametrize(',
          '    "data",',
          `    [${cases.map((c) => pyJson(c.data)).join(', ')}],`,
          `    ids=[${cases.map((c) => pyStr(`${c.code} ${c.title}`.trim())).join(', ')}],`,
          ')',
        ]
      : []),
  ];
  const usesData = /\bdata\.get\(|\(data,/.test(code);
  const args = [...fixtures, ...(cases.length ? ['data'] : [])];
  // Tapping needs a touch screen, as StepForge's phone and tablet sizes have.
  const touch = tap
    ? [
        '@pytest.fixture',
        'def browser_context_args(browser_context_args):',
        '    return {**browser_context_args, "has_touch": True}',
        '',
        '',
      ]
    : [];
  return [
    ...head,
    ...touch,
    ...decorators,
    `def ${name}(${args.join(', ')}):`,
    `    """${oneLine(t.scenario.name).replace(/\\/g, '\\\\').replace(/"/g, "'")}"""`,
    ...(!cases.length && usesData ? ['    data = {}'] : []),
    ...(tabs ? ['    current = page'] : []),
    ...(flavor === 'playwright'
      ? [...s.pages].map((p) => `    ${snake(p)}_page = ${plan.pages.get(p)!.className}(page)`)
      : []),
    ...(/\btest_start\b/.test(code) ? ['    test_start = time.time()'] : []),
    '    vars = {}',
    ...s.lines,
    '',
  ].join('\n');
}

function pageFile(plan: Plan, key: string, flavor: Flavor): string {
  const p = plan.pages.get(key)!;
  if (flavor === 'playwright')
    return [
      `# ${CREDIT}`,
      'from playwright.sync_api import Page',
      '',
      '',
      `class ${p.className}:`,
      '    def __init__(self, page: Page):',
      '        self.page = page',
      ...p.elements.flatMap((e) => [
        '',
        '    @property',
        `    def ${snake(e.name)}(self):`,
        `        return ${locatorPw('self.page', e.loc)}`,
      ]),
      '',
    ].join('\n');
  return [
    `# ${CREDIT}`,
    '"""Locators as (strategy, value[, name]) tuples for support/browser.py."""',
    '',
    '',
    `class ${p.className}:`,
    ...p.elements.map((e) => `    ${snake(e.name).toUpperCase()} = ${locatorTuple(e.loc)}`),
    '',
  ].join('\n');
}

const TITLES: Record<Flavor, string> = {
  playwright: 'Playwright tests (Python + pytest)',
  selenium: 'Selenium tests (Python + pytest)',
  appium: 'Appium tests (Python + pytest)',
  api: 'API tests (Python + pytest + requests)',
};

export function generatePython(
  plan: Plan,
  o: CodegenOptions,
  flavor: Flavor,
  target: TargetId,
): GeneratedProject {
  const files: Record<string, string> = {};
  const warnings = [...plan.warnings];
  const tests = flavor === 'api' ? plan.tests.filter((t) => t.usesApi || !t.usesUi) : plan.tests;
  for (const t of plan.tests)
    if (!tests.includes(t))
      warnings.push({
        scenario: t.scenario.name,
        message: 'skipped: it has browser steps and this export contains API tests only',
      });
  for (const t of tests) {
    const path = testPath(t, (b) => `test_${b}.py`, 'tests', snake);
    files[path] = testFile(plan, t, flavor, (message) =>
      warnings.push({ scenario: t.scenario.name, message }),
    );
  }
  const all = Object.values(files).join('\n');
  const used = (re: RegExp) => re.test(all.replace(/#.*$/gm, ''));
  const engines = new Set(plan.tests.flatMap((t) => t.ops.flatMap((x) => (x.op === 'db' ? [x.engine] : []))));
  const any = engines.has('any');
  files['requirements.txt'] = [
    `# ${CREDIT}`,
    'pytest>=8.3',
    'python-dotenv>=1.0',
    'Faker>=30.0',
    'requests>=2.32',
    ...(flavor === 'playwright' ? ['pytest-playwright>=0.7'] : []),
    ...(flavor === 'selenium' ? ['selenium>=4.27'] : []),
    ...(flavor === 'appium' ? ['Appium-Python-Client>=4.0'] : []),
    ...(any || engines.has('pg') ? ['psycopg[binary]>=3.2'] : []),
    ...(any || engines.has('mysql') ? ['PyMySQL>=1.1'] : []),
    ...(used(/\bexpect_schema\(/) ? ['jsonschema>=4.23'] : []),
    ...(used(/\b(xpath_value|expect_no_fault)\(/) ? ['lxml>=5.3'] : []),
    ...(used(/\bkafka\./) ? ['kafka-python>=2.2'] : []),
    ...(used(/\bftp\(/) ? ['paramiko>=3.5'] : []),
    ...(used(/\bmongo\./) ? ['pymongo>=4.10'] : []),
    '',
  ].join('\n');
  const marks = [
    ...new Set(
      plan.tests.flatMap((t) => [...t.scenario.tags.map((x) => snake(x)), t.scenario.priority.toLowerCase()]),
    ),
  ];
  files['pytest.ini'] = [
    '[pytest]',
    `# ${CREDIT}`,
    'testpaths = tests',
    'addopts = -ra --junitxml=results/junit.xml',
    'markers =',
    ...marks.map((m) => `    ${m}: StepForge ${/^p\d$/.test(m) ? 'priority' : 'tag'}`),
    '',
  ].join('\n');
  files['conftest.py'] = [
    `# ${CREDIT}`,
    'import pytest',
    'import requests',
    '',
    'from support.config import env',
    ...(flavor === 'selenium' ? ['from support.browser import Browser'] : []),
    ...(flavor === 'appium'
      ? ['from support.app import App', 'from support.config import APPIUM_URL, CAPABILITIES, PLATFORM']
      : []),
    '',
    '',
    '@pytest.fixture',
    'def http():',
    '    """One requests session per test (cookies are kept between its requests)."""',
    '    with requests.Session() as session:',
    '        yield session',
    ...(flavor === 'playwright'
      ? [
          '',
          '',
          '@pytest.fixture(scope="session")',
          'def base_url():',
          '    """Relative URLs in page.goto() resolve against BASE_URL."""',
          '    return env["base_url"]',
          '',
          '',
          '@pytest.fixture(scope="session")',
          'def browser_context_args(browser_context_args):',
          '    return {**browser_context_args, "base_url": env["base_url"]}',
        ]
      : []),
    ...(flavor === 'selenium'
      ? [
          '',
          '',
          '@pytest.fixture',
          'def browser():',
          '    """Chrome (headless unless HEADED=1); Selenium Manager downloads the matching driver."""',
          '    import os',
          ...(used(/\bbrowser\.download\(/) ? ['    import tempfile'] : []),
          '',
          '    from selenium import webdriver',
          '',
          '    options = webdriver.ChromeOptions()',
          '    if os.environ.get("HEADED") != "1":',
          '        options.add_argument("--headless=new")',
          '    options.add_argument("--window-size=1440,900")',
          ...(used(/\bbrowser\.download\(/)
            ? [
                '    # Downloads go to a folder of their own for each test.',
                '    downloads = tempfile.mkdtemp(prefix="downloads-")',
                '    options.add_experimental_option("prefs", {"download.default_directory": downloads, "download.prompt_for_download": False})',
                '    driver = webdriver.Chrome(options=options)',
                '    yield Browser(driver, env["base_url"], downloads=downloads)',
              ]
            : [
                '    driver = webdriver.Chrome(options=options)',
                '    yield Browser(driver, env["base_url"])',
              ]),
          '    driver.quit()',
        ]
      : []),
    ...(flavor === 'appium'
      ? [
          '',
          '',
          '@pytest.fixture',
          'def app(request):',
          `    """The app, started for each test through ${plan.native === 'linux' ? "StepForge's Linux helper" : 'Appium'} and closed after it."""`,
          '    from appium import webdriver',
          '    from appium.options.common import AppiumOptions',
          '',
          '    driver = webdriver.Remote(APPIUM_URL, options=AppiumOptions().load_capabilities(CAPABILITIES))',
          '    app = App(driver, PLATFORM)',
          '    yield app',
          '    # A failed test keeps a screenshot of the screen.',
          '    report = getattr(request.node, "rep_call", None)',
          '    if report is not None and report.failed:',
          '        app.screenshot(f"{request.node.name}-failed")',
          '    driver.quit()',
          '',
          '',
          '@pytest.hookimpl(hookwrapper=True)',
          'def pytest_runtest_makereport(item, call):',
          '    outcome = yield',
          '    report = outcome.get_result()',
          '    setattr(item, f"rep_{report.when}", report)',
        ]
      : []),
    '',
  ].join('\n');
  files['support/__init__.py'] = '';
  files['support/config.py'] = [
    `"""${CREDIT}. Environment variables; defaults come from the exported environment."""`,
    'import os',
    'from urllib.parse import urljoin',
    '',
    'from dotenv import load_dotenv',
    '',
    'load_dotenv()',
    '',
    'env = {',
    `    "base_url": os.environ.get("BASE_URL", ${pyStr(plan.input.environment.baseUrl)}),`,
    ...plan.variables.map(
      (v) =>
        `    ${pyStr(v)}: os.environ.get(${pyStr(envName(v))}, ${pyStr(plan.input.environment.variables[v] ?? '')}),`,
    ),
    '}',
    '',
    '',
    'def secret(name):',
    '    """A secret from the environment (.env locally, CI secrets in pipelines). Never stored in the code."""',
    '    value = os.environ.get(name)',
    '    if not value:',
    '        raise RuntimeError(f"Set the {name} environment variable (see .env.example)")',
    '    return value',
    '',
    '',
    'def absolute(url):',
    '    return url if url.startswith(("http://", "https://")) else urljoin(env["base_url"].rstrip("/") + "/", url.lstrip("/"))',
    '',
    ...(flavor === 'appium' && plan.native
      ? [
          '',
          `# ${PLATFORM_NAMES[plan.native]}: the capabilities StepForge starts the app with (from the ${plan.input.environment.name} environment).`,
          `PLATFORM = ${pyStr(plan.native)}`,
          'APPIUM_URL = os.environ.get("APPIUM_URL", "http://127.0.0.1:4723")',
          `CAPABILITIES = ${pyVal(capabilities(plan.native, plan.input.environment.launch))}`,
          'if os.environ.get("APP"):',
          `    CAPABILITIES[${pyStr(APP_KEY[plan.native])}] = os.environ["APP"]`,
          `if os.path.exists(CAPABILITIES.get(${pyStr(APP_KEY[plan.native])}) or ""):`,
          `    CAPABILITIES[${pyStr(APP_KEY[plan.native])}] = os.path.abspath(CAPABILITIES[${pyStr(APP_KEY[plan.native])}])`,
          '',
        ]
      : []),
  ].join('\n');
  files['support/helpers.py'] = runtime('py/helpers.py');
  files['support/api.py'] = runtime('py/api.py');
  if (/\bdb\./.test(all)) files['support/db.py'] = runtime('py/db.py');
  if (/\bmail\./.test(all)) files['support/mail.py'] = runtime('py/mail.py');
  if (used(/\bfrom support\.web import/)) files['support/web.py'] = runtime('py/web.py');
  if (used(/\bexpect_schema\(/)) files['support/schema.py'] = runtime('py/schema.py');
  if (used(/\b(xpath_value|expect_no_fault)\(/)) files['support/xml.py'] = runtime('py/xml.py');
  if (used(/\bkafka\./)) files['support/kafka.py'] = runtime('py/kafka.py');
  if (used(/\bftp\(/)) files['support/ftp.py'] = runtime('py/ftp.py');
  if (used(/\bmongo\./)) files['support/mongo.py'] = runtime('py/mongo.py');
  if (flavor === 'selenium') {
    files['support/browser.py'] = runtime('py/browser.py');
    files['support/find.js'] = runtime('selenium/find.js');
  }
  if (flavor === 'appium') {
    files['support/app.py'] = runtime('py/app.py');
    if (plan.native === 'linux') files['tools/stepforge_atspi.py'] = linuxHelper();
  }
  if (/switch_tab\(/.test(all) && flavor === 'playwright')
    files['support/tabs.py'] = [
      `"""${CREDIT}. Tab handling."""`,
      'import time',
      '',
      '',
      'def switch_tab(context, index=None, url_contains=None, timeout=10):',
      '    """Waits for the tab (it may still be opening), brings it to the front and returns it."""',
      '    deadline = time.time() + timeout',
      '    while True:',
      '        pages = context.pages',
      '        if index is not None:',
      '            found = pages[index] if index < len(pages) else None',
      '        elif url_contains is not None:',
      '            found = next((p for p in pages if url_contains in p.url), None)',
      '        else:',
      '            found = pages[-1] if len(pages) > 1 else None',
      '        if found:',
      '            found.bring_to_front()',
      '            found.wait_for_load_state()',
      '            return found',
      '        if time.time() > deadline:',
      '            raise AssertionError("No such tab")',
      '        time.sleep(0.1)',
      '',
    ].join('\n');
  if (flavor !== 'api' && plan.pages.size) {
    files['pages/__init__.py'] = '';
    for (const key of plan.pages.keys())
      files[`pages/${snake(plan.pages.get(key)!.className)}.py`] = pageFile(plan, key, flavor);
  }
  files['tests/__init__.py'] = '';
  for (const path of Object.keys(files))
    if (path.startsWith('tests/') && path.split('/').length > 2) {
      const dir = path.split('/').slice(0, -1).join('/');
      files[`${dir}/__init__.py`] ??= '';
    }
  Object.assign(files, plan.sqlFiles);
  if (flavor === 'appium' && plan.native) {
    Object.assign(
      files,
      nativeCi(
        plan,
        plan.native,
        {
          setup: [
            '      - uses: actions/setup-python@v5',
            '        with:',
            "          python-version: '3.12'",
            '      - run: pip install -r requirements.txt',
          ],
          test: 'pytest',
        },
        o.ci,
        plan.native !== 'linux',
      ),
    );
    if (o.ci?.includes('gitlab')) warnings.push(GITLAB_NATIVE);
  } else Object.assign(files, ciFiles(plan, flavor === 'playwright' ? 'python-playwright' : 'python', o.ci));
  files['.env.example'] = envExample(plan);
  files['.gitignore'] = [
    '.venv/',
    '__pycache__/',
    '.pytest_cache/',
    '.env',
    'results/',
    'screenshots/',
    'test-results/',
    '',
  ].join('\n');
  const install = [
    'python -m venv .venv && . .venv/bin/activate   # Windows: .venv\\Scripts\\activate',
    'pip install -r requirements.txt',
    ...(flavor === 'playwright' ? ['python -m playwright install chromium'] : []),
    ...(flavor === 'appium' && plan.native ? driverSetup(plan.native) : []),
  ];
  files['README.md'] = readme(
    { ...plan, warnings },
    {
      title: TITLES[flavor],
      install,
      run: [
        'pytest                 # all tests (JUnit in results/junit.xml)',
        'pytest -m smoke        # one tag',
        ...(flavor === 'playwright' ? ['pytest --headed         # watch the browser'] : []),
        ...(flavor === 'selenium' ? ['HEADED=1 pytest        # watch the browser'] : []),
      ],
      layout: [
        '`tests/` — one module per scenario, grouped by module folder; test cases are parametrised',
        ...(plan.pages.size && flavor !== 'api' ? ['`pages/` — page objects'] : []),
        `\`support/\` — configuration (environment variables, secrets${flavor === 'appium' ? ', Appium capabilities' : ''}) and helpers`,
        ...(flavor === 'appium' && plan.native === 'linux' ? ["`tools/` — StepForge's Linux helper"] : []),
        ...(Object.keys(plan.sqlFiles).length ? ['`sql/` — the SQL of each database step'] : []),
      ],
      notes: [
        ...(flavor === 'selenium'
          ? [
              'Elements are found by role, label, text and test id like in StepForge (support/find.js), and every lookup and check waits up to 10 s.',
            ]
          : []),
        ...(flavor === 'appium' && plan.native ? nativeNotes(plan.native) : []),
        `Exported on ${day(plan.input)}; re-export from StepForge after changing the scenarios.`,
      ],
    },
  );
  return {
    target,
    files,
    warnings,
    run: `pip install -r requirements.txt${flavor === 'playwright' ? ' && python -m playwright install chromium' : ''} && pytest`,
  };
}
