import { CREDIT, ciFiles, day, envExample, headerLines, readme, runtime, testPath } from '../common.ts';
import type { El, Loc, Op, Plan, TestPlan } from '../ir.ts';
import { pyInt, pyBlock, pyJson, pyStr, pyText, pyVal } from '../lang/py.ts';
import type { CodegenOptions, GeneratedProject, TargetId } from '../types.ts';
import { envName, parseString, snake } from '../values.ts';

/**
 * Python + pytest: Playwright (sync API), Selenium, or API only (requests). API, database and email steps are
 * printed the same way for all three; only the browser part differs.
 */
type Flavor = 'playwright' | 'selenium' | 'api';

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
};

const next = (s: State, k: string) => `${k}${(s.n[k] = (s.n[k] ?? 0) + 1)}`;

function el(s: State, e: El): string {
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

function uiOp(op: Op, s: State, out: (l: string) => void, warn: (m: string) => void): boolean {
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
          out(`${f} = ${P}.frame_locator(${pyStr(op.selector)})`);
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
    default:
      return false;
  }
}

function printOps(ops: Op[], s: State, ind: string, warn: (m: string) => void): void {
  const out = (line: string) => s.lines.push(`${ind}${line}`);
  for (const op of ops) {
    if (uiOp(op, s, out, warn)) continue;
    switch (op.op) {
      case 'comment':
        out(`# ${op.text}`);
        break;
      case 'todo':
        out(`# TODO(StepForge): ${op.text}`);
        break;
      case 'api': {
        const r = next(s, 'res');
        const headers: string[] = op.headers.map(([k, v]) => `${pyStr(k)}: ${pyText(v)}`);
        const params: string[] = op.query.map(([k, v]) => `${pyStr(k)}: ${pyVal(v)}`);
        let auth = '';
        if (op.auth?.type === 'bearer') headers.push(`"Authorization": f"Bearer {${pyText(op.auth.token)}}"`);
        if (op.auth?.type === 'basic')
          auth = `auth=(${pyText(op.auth.username)}, ${pyText(op.auth.password)}), `;
        if (op.auth?.type === 'apiKey')
          (op.auth.in === 'query' ? params : headers).push(
            `${pyStr(op.auth.name)}: ${pyText(op.auth.value)}`,
          );
        if (op.auth?.type === 'cookie')
          headers.push(`"Cookie": f"${op.auth.name}={${pyText(op.auth.value)}}"`);
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
        for (const a of op.asserts) {
          if (a.target === 'status' && a.operator === 'equals')
            out(`assert ${r}["status"] == ${pyVal(a.expected)}, "status"`);
          else
            out(
              `check(pick(${r}, ${pyStr(a.target)}), ${pyStr(a.operator)}, ${pyVal(a.expected)}, ${pyStr(`${a.target} ${a.operator}`)})`,
            );
        }
        if (op.into) out(`vars[${pyStr(op.into)}] = ${r}["body"]`);
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
            ? `vars[${pyStr(op.into)}] = pick(${s.lastApi}, ${pyStr(target)})`
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
        for (const l of op.code.split('\n')) out(`#   ${l}`);
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
        if (s.usesUi && s.flavor !== 'api')
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

function has(t: TestPlan, k: Op['op']): boolean {
  let found = false;
  const walk = (ops: Op[]) =>
    ops.forEach((o) => {
      if (o.op === k) found = true;
      if (o.op === 'if') {
        walk(o.then);
        walk(o.else);
      }
      if (o.op === 'loop') walk(o.body);
    });
  walk(t.ops);
  return found;
}

const HELPERS = ['check', 'compare', 'pick', 'fake', 'field', 'capture', 'text', 'random_value', 'RUN_ID'];

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
  };
  printOps(t.ops, s, '    ', warn);
  const code = s.lines.join('\n').replace(/#.*$/gm, '');
  const helpers = HELPERS.filter(
    (h) => new RegExp(`\\b${h}\\(|\\b${h}\\b(?!\\()`).test(code) && new RegExp(`\\b${h}\\b`).test(code),
  );
  const fixtures = [
    ...(flavor === 'playwright' && (t.usesUi || tabs) ? ['page'] : []),
    ...(flavor === 'selenium' && t.usesUi ? ['browser'] : []),
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
  return [
    ...head,
    ...decorators,
    `def ${name}(${args.join(', ')}):`,
    `    """${t.scenario.name.replace(/"/g, "'")}"""`,
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
    ...(any || engines.has('pg') ? ['psycopg[binary]>=3.2'] : []),
    ...(any || engines.has('mysql') ? ['PyMySQL>=1.1'] : []),
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
          '',
          '    from selenium import webdriver',
          '',
          '    options = webdriver.ChromeOptions()',
          '    if os.environ.get("HEADED") != "1":',
          '        options.add_argument("--headless=new")',
          '    options.add_argument("--window-size=1440,900")',
          '    driver = webdriver.Chrome(options=options)',
          '    yield Browser(driver, env["base_url"])',
          '    driver.quit()',
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
  ].join('\n');
  files['support/helpers.py'] = runtime('py/helpers.py');
  files['support/api.py'] = runtime('py/api.py');
  if (/\bdb\./.test(all)) files['support/db.py'] = runtime('py/db.py');
  if (/\bmail\./.test(all)) files['support/mail.py'] = runtime('py/mail.py');
  if (flavor === 'selenium') {
    files['support/browser.py'] = runtime('py/browser.py');
    files['support/find.js'] = runtime('selenium/find.js');
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
  Object.assign(files, ciFiles(plan, flavor === 'playwright' ? 'python-playwright' : 'python', o.ci));
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
        '`support/` — configuration (environment variables, secrets) and helpers',
        ...(Object.keys(plan.sqlFiles).length ? ['`sql/` — the SQL of each database step'] : []),
      ],
      notes: [
        ...(flavor === 'selenium'
          ? [
              'Elements are found by role, label, text and test id like in StepForge (support/find.js), and every lookup and check waits up to 10 s.',
            ]
          : []),
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
