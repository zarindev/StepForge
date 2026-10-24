import { describeStep, type Locator } from '@stepforge/core';
import {
  androidQueries,
  iosQueries,
  linuxQueries,
  macQueries,
  windowsQueries,
  type Query,
} from '@stepforge/executor-native/locators';
import type { AppPlatform, CodegenInput, CodegenScenario, CodegenStep, Warning } from './types.ts';
import { camel, isStatic, kebab, pascal, plain, str, uniquer, val, type Ref, type Val } from './values.ts';

/**
 * Steps → a small, language-neutral list of operations. Every generator prints these; anything a target cannot
 * express becomes a `todo` op (a `TODO(StepForge)` comment plus a warning), never silently broken code.
 */
export type Loc = { strategy: string; value: string; name?: string };
/** `queries`: for phone and desktop apps, the Appium selectors of all its locators, best first. */
export type El = { loc: Loc; alts: Loc[]; pom?: { page: string; name: string }; queries?: Query[] };
export type { Query };

/**
 * Phone and desktop-app actions (Appium and Maestro exports), printed as calls of the exported project's helper:
 * `app.<method>(...els, ...args)`.
 */
export type AppMethod =
  | 'select'
  | 'scroll'
  | 'swipe'
  | 'swipeOn'
  | 'drag'
  | 'longPress'
  | 'scrollTo'
  | 'back'
  | 'hideKeyboard'
  | 'rotate'
  | 'launchApp'
  | 'closeApp'
  | 'resetApp'
  | 'backgroundApp'
  | 'deepLink'
  | 'setLocation'
  | 'permission'
  | 'pushNotification'
  | 'menu'
  | 'handleDialog';

export type Check =
  | 'visible'
  | 'hidden'
  | 'text'
  | 'textContains'
  | 'textMatches'
  | 'value'
  | 'count'
  | 'attribute'
  | 'enabled'
  | 'disabled'
  | 'checked'
  | 'unchecked'
  | 'url'
  | 'urlContains'
  | 'urlMatches'
  | 'title'
  | 'titleContains';
export type Source = 'text' | 'value' | 'attribute' | 'count' | 'url' | 'title';
export type Auth =
  | { type: 'bearer'; token: Val }
  | { type: 'basic'; username: Val; password: Val }
  | { type: 'apiKey'; in: 'header' | 'query'; name: string; value: Val }
  | { type: 'cookie'; name: string; value: Val }
  /** Client-credentials grant, as StepForge fetches it: Basic client id/secret, form body, token cached. */
  | { type: 'oauth2'; tokenUrl: Val; clientId: Val; clientSecret: Val; scope: Val | null };
/** `matchesSchema` asserts (with feature `schema`) carry the JSON Schema as `expected`. */
export type Assert = { target: string; operator: string; expected: Val };

/**
 * What an export can express beyond the basic steps. Each target lists the ones it prints (see features.ts); a step
 * needing a feature its target lacks becomes a TODO with a warning, so no printer ever meets an op it cannot print.
 */
export type Feature =
  | 'tap'
  | 'download'
  | 'waitResponse'
  | 'mockRoute'
  | 'offline'
  | 'storage'
  | 'clock'
  | 'netSummary'
  | 'pageCondition'
  | 'repeatWhile'
  | 'soap'
  | 'schema'
  | 'oauth2'
  | 'kafka'
  | 'ftp'
  | 'mongo';
/** true: exported; a string: why not (the TODO text); missing: the default reason. */
export type Features = Partial<Record<Feature, true | string>>;

/** Page conditions (util.if / util.loop "while" on an element), as StepForge's probe checks them. */
export type PageCheck = 'visible' | 'hidden' | 'present' | 'absent' | 'enabled' | 'textContains' | 'count';
export type PageCond = { el: El; check: PageCheck; expected?: Val; timeoutMs: number };
export type ValueCond = { value: Val; operator: string; expected: Val };

export type Op =
  | { op: 'comment'; text: string }
  | { op: 'todo'; text: string }
  | { op: 'goto'; url: Val }
  | {
      op: 'act';
      action:
        | 'click'
        | 'dblclick'
        | 'rightclick'
        | 'hover'
        | 'fill'
        | 'type'
        | 'clear'
        | 'check'
        | 'uncheck'
        | 'scrollIntoView'
        /** A touch tap (feature `tap`; Playwright needs a touch screen, `hasTouch`). */
        | 'tap';
      el: El;
      value?: Val;
    }
  | { op: 'press'; el: El | null; key: string }
  | { op: 'select'; el: El; by: 'value' | 'label' | 'index'; value: Val }
  | { op: 'upload'; el: El; files: Val[] }
  | { op: 'drag'; el: El; to: El }
  | { op: 'scroll'; x: number; y: number }
  | { op: 'waitFor'; el: El; state: 'visible' | 'hidden' | 'attached' | 'detached' }
  | { op: 'waitUrl'; url: Val }
  | { op: 'waitLoad'; state: string }
  | { op: 'assert'; check: Check; el: El | null; expected?: Val; attribute?: string; soft: boolean }
  | { op: 'read'; source: Source; el: El | null; attribute?: string; regex?: string; into: string }
  | { op: 'screenshot'; el: El | null; fullPage: boolean; name: string }
  | { op: 'dialog'; accept: boolean; promptText?: Val }
  | { op: 'frame'; selector: string | null }
  | { op: 'tab'; index?: number; urlContains?: string }
  | { op: 'closeTab' }
  | {
      op: 'api';
      method: string;
      url: Val;
      headers: [string, Val][];
      query: [string, Val][];
      body: Val | null;
      bodyType: 'json' | 'form' | 'multipart' | 'raw' | 'none';
      auth: Auth | null;
      asserts: Assert[];
      into?: string;
      label: string;
      /**
       * A SOAP call (feature `soap`): the envelope is the raw body and its headers are in `headers`. Asserts may be
       * XPath (`//m:Price`, `count(//x)`, `xpath:…`; the document's own prefixes plus `namespaces`); unless
       * `allowFault`, a SOAP fault fails the test.
       */
      soap?: { namespaces: Record<string, string>; allowFault: boolean };
    }
  | { op: 'apiExtract'; from: 'body' | 'header' | 'status'; path?: string; name?: string; into: string }
  | { op: 'setVar'; name: string; value: Val }
  | { op: 'gen'; kind: string; opts: Record<string, unknown>; into: string }
  | { op: 'wait'; ms: number }
  | { op: 'log'; message: Val }
  | { op: 'script'; code: string; into?: string }
  | { op: 'if'; value: Val; operator: string; expected: Val; then: Op[]; else: Op[] }
  | { op: 'loop'; count?: Val; over?: Val; as: string; body: Op[] }
  | { op: 'check'; actual: Val; operator: string; expected: Val; message: string }
  | {
      op: 'db';
      kind: 'query' | 'script' | 'procedure';
      connection: string;
      engine: string;
      sql: string;
      params: Val[];
      asserts: Assert[];
      into?: string;
      /** Path of the SQL file written next to the tests. */
      sqlFile: string;
    }
  | { op: 'dbExtract'; path: string; into: string }
  | { op: 'emailWait'; to?: Val; from?: Val; subject?: Val; contains?: Val; timeoutMs: number; into?: string }
  | {
      op: 'emailAssert';
      checks: {
        kind: 'subjectContains' | 'bodyContains' | 'from' | 'hasLink' | 'hasAttachment';
        value: Val;
      }[];
    }
  | {
      op: 'emailExtract';
      kind: 'otp' | 'link' | 'regex';
      contains?: Val;
      index?: number;
      pattern?: string;
      into: string;
    }
  | { op: 'emailOpenLink'; contains?: Val; index?: number; url?: Val }
  | { op: 'app'; method: AppMethod; els: El[]; args: Val[] }
  // ─── Browser steps with a feature each ───────────────────────────────────
  /** Clicks the element and keeps the file it downloads. Asserts: `fileName`, `size`, `content`. */
  | { op: 'download'; el: El; asserts: Assert[]; into?: string }
  /**
   * The first response since the test started to a matching URL (part of it, or a glob) that no earlier step took,
   * else the next one. Asserts as on an API response, plus `url`; `into` keeps the body.
   */
  | {
      op: 'waitResponse';
      url: Val;
      method?: string;
      status?: number;
      timeoutMs: number;
      asserts: Assert[];
      into?: string;
    }
  /**
   * Answers matching requests until the test ends: `fulfill` (status, body — text or a value sent as JSON —,
   * content type), `abort`, `delay`; `remove` drops the mocks of that URL (and method). `times`: only that many.
   */
  | {
      op: 'mockRoute';
      url: Val;
      action: 'fulfill' | 'abort' | 'delay' | 'remove';
      method?: string;
      status: number;
      body: Val | null;
      contentType?: string;
      delayMs: number;
      times?: number;
    }
  | { op: 'offline'; offline: boolean }
  /** Cookies, localStorage or sessionStorage. `get` asserts: `value`, `exists`; `into` keeps the value. */
  | {
      op: 'storage';
      kind: 'cookie' | 'local' | 'session';
      action: 'get' | 'set' | 'remove' | 'clear';
      name: Val;
      value: Val;
      asserts: Assert[];
      into?: string;
    }
  /** `set`: the page's Date is fixed at `time`; `install`: the clock runs from `time` (or now); `fastForward` ms. */
  | { op: 'clock'; action: 'set' | 'install' | 'fastForward'; time?: Val; ms: number }
  /**
   * The page's traffic since the test started (or the last `goto`), as numbers to check: `requests`, `bytes`, `kb`,
   * `failed`, `thirdPartyRequests`, `thirdPartyHosts`, `hosts`, `thirdPartyHostNames`, `requests:<type>`, `bytes:<type>`.
   */
  | { op: 'netSummary'; since: 'test' | 'lastNavigation'; asserts: Assert[]; into?: string }
  // ─── Control flow on the page ────────────────────────────────────────────
  /** Tries the check every 100 ms for up to timeoutMs; false picks `else` (never fails by itself). */
  | { op: 'ifPage'; cond: PageCond; then: Op[]; else: Op[] }
  /**
   * Repeat while: `vars.index` is the pass number; the condition is checked before every pass; after `max` passes
   * with the condition still holding, the test fails (StepForge's safety limit).
   */
  | {
      op: 'while';
      cond: ({ kind: 'value' } & ValueCond) | ({ kind: 'page' } & PageCond);
      max: number;
      body: Op[];
    }
  // ─── Integrations ────────────────────────────────────────────────────────
  /**
   * Kafka (feature `kafka`). `params`: the step's params as written (brokers, topic, key, value, headers, partition,
   * ssl, sasl; consume: since, key, contains, path, equals, timeoutMs). Produce asserts: `topic`, `partition`,
   * `offset`; consume asserts: `key`, `value`, `$…` (in the value), `header:<name>`, `partition`, `offset`.
   */
  | {
      op: 'kafka';
      action: 'produce' | 'consume';
      params: Val;
      timeoutMs: number;
      asserts: Assert[];
      into?: string;
    }
  /**
   * FTP, FTPS or SFTP (feature `ftp`). `params`: protocol, host, port, username, password, privateKey, action,
   * remotePath, localPath, content. Asserts: download `content`, `size`, `path`; list `count`, `names`; `exists`.
   */
  | {
      op: 'ftp';
      action: 'upload' | 'download' | 'list' | 'delete' | 'exists';
      params: Val;
      asserts: Assert[];
      into?: string;
    }
  /**
   * A MongoDB command (feature `mongo`) on `DB_<CONNECTION>_URL`: `command` is JSON text (a `db.query`) or a value
   * (`db.mongoFind`, already in command form), with `collection` and one operation (find, aggregate,
   * countDocuments, distinct, insertOne…). The result reads like a database result (rows, rowCount, value…).
   */
  | { op: 'mongo'; connection: string; command: Val; asserts: Assert[]; into?: string };

export type TestPlan = {
  scenario: CodegenScenario;
  /** File-friendly unique base name of the scenario. */
  slug: string;
  /** Kebab-case file name, unique among the scenarios of its module folder (names that read the same get 2, 3…). */
  file: string;
  /** Operations in order; one generated test per test case (or one without data). */
  ops: Op[];
  /** Variables and secrets this test reads. */
  refs: Ref[];
  usesUi: boolean;
  usesApi: boolean;
  usesDb: boolean;
  usesEmail: boolean;
};

export type PomPage = { className: string; elements: { name: string; loc: Loc }[] };

export type Plan = {
  input: CodegenInput;
  tests: TestPlan[];
  /** Page objects (filled only when POM is requested). */
  pages: Map<string, PomPage>;
  /** SQL files, path → content. */
  sqlFiles: Record<string, string>;
  warnings: Warning[];
  secrets: string[];
  variables: string[];
  /** The phone or desktop platform of an Appium or Maestro export, else null. */
  native: AppPlatform | null;
};

const MAX_DEPTH = 5;
const CHECKS: Check[] = [
  'visible',
  'hidden',
  'text',
  'textContains',
  'textMatches',
  'value',
  'count',
  'attribute',
  'enabled',
  'disabled',
  'checked',
  'unchecked',
  'url',
  'urlContains',
  'urlMatches',
  'title',
  'titleContains',
];

const QUERIES: Record<AppPlatform, (l: Locator) => Query[]> = {
  android: androidQueries,
  ios: iosQueries,
  macos: macQueries,
  windows: windowsQueries,
  linux: linuxQueries,
};

/** A locator's Appium selectors on that platform, as StepForge itself finds the element; [] when it has none. */
export function queriesOf(platform: AppPlatform, l: Loc): Query[] {
  try {
    return QUERIES[platform](l as Locator);
  } catch {
    return [];
  }
}

/**
 * The step's locators for export: image locators (pictures) have no code equivalent and are left out. For phone and
 * desktop apps, locators with no Appium equivalent (CSS) are left out too.
 */
const elOf = (locators: Loc[], platform: AppPlatform | null): El | null => {
  const locs = locators.filter((l) => l.strategy !== 'image');
  if (!platform) return locs.length ? { loc: locs[0]!, alts: locs.slice(1) } : null;
  const usable = locs.filter((l) => queriesOf(platform, l).length);
  return usable.length
    ? { loc: usable[0]!, alts: usable.slice(1), queries: usable.flatMap((l) => queriesOf(platform, l)) }
    : null;
};

const p = (step: CodegenStep) => step.params ?? {};
const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

/** Maps a generic UI step assertion (`target` + operator) to a native check, or null. */
function nativeCheck(
  target: string,
  operator: string,
  expected: unknown,
): { check: Check; attribute?: string } | null {
  const isAttr = target.startsWith('attr:');
  const base = isAttr ? 'attribute' : target;
  const table: Record<string, Partial<Record<string, Check>>> = {
    url: { equals: 'url', contains: 'urlContains', matches: 'urlMatches' },
    title: { equals: 'title', contains: 'titleContains' },
    text: { equals: 'text', contains: 'textContains', matches: 'textMatches' },
    value: { equals: 'value' },
    count: { equals: 'count' },
    attribute: { equals: 'attribute' },
  };
  if (base === 'visible' && operator === 'equals')
    return { check: expected === false ? 'hidden' : 'visible' };
  if (base === 'enabled' && operator === 'equals')
    return { check: expected === false ? 'disabled' : 'enabled' };
  if (base === 'checked' && operator === 'equals')
    return { check: expected === false ? 'unchecked' : 'checked' };
  if (operator === 'exists') return { check: 'visible' };
  if (operator === 'notExists') return { check: 'hidden' };
  const c = table[base]?.[operator];
  return c ? { check: c, ...(isAttr && { attribute: target.slice(5) }) } : null;
}

const SOURCE: Record<string, Source> = {
  text: 'text',
  value: 'value',
  count: 'count',
  url: 'url',
  title: 'title',
};

type Ctx = {
  input: CodegenInput;
  scenario: CodegenScenario;
  warnings: Warning[];
  sqlFiles: Record<string, string>;
  sqlName: (s: string) => string;
  slug: string;
  tmp: () => string;
  flags: { ui: boolean; api: boolean; db: boolean; email: boolean };
  /** Set for the Appium and Maestro exports of a phone or desktop app. */
  native: AppPlatform | null;
  /** What the target prints; null: everything (a plan without a target). */
  features: Features | null;
  /** The target's name, for TODO texts ("not exported to Cypress"). */
  label: string;
};

function todo(ctx: Ctx, step: CodegenStep, message: string): Op {
  ctx.warnings.push({ scenario: ctx.scenario.name, step: step.label || step.type, message });
  return { op: 'todo', text: `${step.type}: ${message}` };
}

const BROWSER_TODO = 'this browser step is not exported to {target}; write it with the framework’s own API';
const WHY_NOT: Record<Feature, string> = {
  tap: BROWSER_TODO,
  download: BROWSER_TODO,
  waitResponse: BROWSER_TODO,
  mockRoute: BROWSER_TODO,
  offline: BROWSER_TODO,
  storage: BROWSER_TODO,
  clock: BROWSER_TODO,
  netSummary: BROWSER_TODO,
  pageCondition:
    'page conditions (if the element is …) are not exported to {target}; write the check by hand',
  repeatWhile: '“repeat while” loops are not exported to {target}; write the loop by hand',
  soap: 'SOAP steps are not exported to {target}; send the envelope with an HTTP client',
  schema: 'the JSON Schema check on "{assert}" is not exported to {target}',
  oauth2: 'auth type "oauth2" is not exported to {target}; set the header yourself',
  kafka: 'Kafka steps are not exported to {target}; use a Kafka client of the target language',
  ftp: 'FTP steps are not exported to {target}; use an FTP client of the target language',
  mongo: 'MongoDB steps are not exported to {target}; use the MongoDB driver of the target language',
};

/** True when the target prints the feature; otherwise pushes the TODO (with its warning) and returns false. */
function can(ctx: Ctx, step: CodegenStep, f: Feature, out: Op[], assert?: string): boolean {
  const v = ctx.features === null ? true : ctx.features[f];
  if (v === true) return true;
  out.push(
    todo(ctx, step, (v ?? WHY_NOT[f]).replace('{target}', ctx.label).replace('{assert}', assert ?? '')),
  );
  return false;
}

/** Asserts of a browser step that reads its own result; other targets become TODOs. */
function ownAsserts(ctx: Ctx, step: CodegenStep, out: Op[], ok: (target: string) => boolean): Assert[] {
  return step.assertions.flatMap((a) => {
    if (!ok(a.target)) {
      out.push(todo(ctx, step, `assertion on "${a.target}" is not exported`));
      return [];
    }
    return [{ target: a.target, operator: a.operator, expected: val(a.expected) }];
  });
}

const PAGE_CHECKS: PageCheck[] = [
  'visible',
  'hidden',
  'present',
  'absent',
  'enabled',
  'textContains',
  'count',
];
const MAX_LOOP_ITERATIONS = 1000;

function stepOps(ctx: Ctx, step: CodegenStep, depth: number): Op[] {
  if (step.enabled === false)
    return [{ op: 'comment', text: `Disabled in StepForge: ${describeStep(step as never)}` }];
  const q = p(step);
  const out: Op[] = [];
  const e = elOf(step.locators, ctx.native);
  const into = step.captureAs;
  const group = step.type.split('.')[0];
  if (group === 'ui') ctx.flags.ui = true;
  const needEl = (): El | null => {
    if (!e)
      out.push(
        todo(
          ctx,
          step,
          !step.locators.length
            ? 'the step has no locator'
            : ctx.native && step.locators.some((l) => l.strategy !== 'image')
              ? 'its locators (CSS) do not exist in phone and desktop apps; add an id, text, label or XPath locator'
              : `image locators (pictures) are not exported; add an id, text${ctx.native ? ', label' : ' or CSS'} locator`,
        ),
      );
    return e;
  };

  if (ctx.native && group === 'ui' && nativeStep(ctx, step, e, needEl, out)) return out;

  switch (step.type) {
    case 'ui.navigate':
      out.push({ op: 'goto', url: val(q.url ?? '/') });
      break;
    case 'ui.click':
    case 'ui.dblclick':
    case 'ui.rightclick':
    case 'ui.hover':
    case 'ui.clear':
    case 'ui.check':
    case 'ui.uncheck': {
      const x = needEl();
      if (x) out.push({ op: 'act', action: step.type.slice(3) as 'click', el: x });
      break;
    }
    case 'ui.fill':
    case 'ui.type': {
      const x = needEl();
      if (x) out.push({ op: 'act', action: step.type.slice(3) as 'fill', el: x, value: val(q.value ?? '') });
      break;
    }
    case 'ui.press':
      out.push({ op: 'press', el: e, key: String(q.key ?? 'Enter') });
      break;
    case 'ui.select': {
      const x = needEl();
      const by = q.label !== undefined ? 'label' : q.index !== undefined ? 'index' : 'value';
      if (x) out.push({ op: 'select', el: x, by, value: val(q[by]) });
      break;
    }
    case 'ui.upload': {
      const x = needEl();
      const files = Array.isArray(q.files) ? q.files : q.file !== undefined ? [q.file] : [];
      if (x) out.push({ op: 'upload', el: x, files: files.map(val) });
      break;
    }
    case 'ui.dragDrop': {
      const x = needEl();
      const to = Array.isArray(q.target) && q.target.length ? (q.target as Loc[]) : null;
      if (x && to) out.push({ op: 'drag', el: x, to: { loc: to[0]!, alts: to.slice(1) } });
      else if (x) out.push(todo(ctx, step, 'the drop target has no locator'));
      break;
    }
    case 'ui.scroll':
      if (e) out.push({ op: 'act', action: 'scrollIntoView', el: e });
      else out.push({ op: 'scroll', x: num(q.x, 0), y: num(q.y, 500) });
      break;
    case 'ui.switchTab':
      out.push({
        op: 'tab',
        ...(typeof q.index === 'number' && { index: q.index }),
        ...(typeof q.urlContains === 'string' && { urlContains: q.urlContains }),
      });
      break;
    case 'ui.closeTab':
      out.push({ op: 'closeTab' });
      break;
    case 'ui.handleDialog':
      out.push({
        op: 'dialog',
        accept: q.action !== 'dismiss',
        ...(q.promptText !== undefined && { promptText: val(q.promptText) }),
      });
      break;
    case 'ui.switchFrame':
      out.push({ op: 'frame', selector: q.main ? null : String(q.selector ?? 'iframe') });
      break;
    case 'ui.waitFor':
      if (e) out.push({ op: 'waitFor', el: e, state: (q.state as 'visible') ?? 'visible' });
      else if (q.url !== undefined) out.push({ op: 'waitUrl', url: val(q.url) });
      else out.push({ op: 'waitLoad', state: String(q.loadState ?? 'load') });
      break;
    case 'ui.screenshot':
      out.push({
        op: 'screenshot',
        el: e,
        fullPage: !!q.fullPage,
        name: camel(step.label ?? 'screenshot', 'screenshot'),
      });
      break;
    case 'ui.extract': {
      const from = String(q.from ?? 'text');
      const source = from === 'attribute' ? 'attribute' : (SOURCE[from] ?? 'text');
      if (!into) {
        out.push({ op: 'comment', text: `${describeStep(step as never)} (no captureAs: value not kept)` });
        break;
      }
      out.push({
        op: 'read',
        source,
        el: e,
        ...(source === 'attribute' && { attribute: String(q.attribute ?? '') }),
        ...(typeof q.regex === 'string' && { regex: q.regex }),
        into,
      });
      break;
    }
    case 'ui.assert': {
      const check = String(q.check ?? 'visible') as Check;
      if (!CHECKS.includes(check)) {
        out.push(todo(ctx, step, `unknown check "${check}"`));
        break;
      }
      const pageLevel = check.startsWith('url') || check.startsWith('title');
      if (!pageLevel && !e) {
        out.push(todo(ctx, step, 'the step has no locator'));
        break;
      }
      out.push({
        op: 'assert',
        check,
        el: pageLevel ? null : e,
        ...(q.expected !== undefined && { expected: val(q.expected) }),
        ...(typeof q.attribute === 'string' && { attribute: q.attribute }),
        soft: !!step.continueOnFail,
      });
      break;
    }
    case 'ui.visualCheckpoint':
      out.push(
        todo(
          ctx,
          step,
          'visual checkpoints are not exported; add a screenshot comparison in the target framework',
        ),
      );
      break;

    // ─── API ──────────────────────────────────────────────────────────────
    case 'api.request':
    case 'api.graphql': {
      ctx.flags.api = true;
      const gql = step.type === 'api.graphql';
      const oauth = (q.auth as { type?: string } | undefined)?.type === 'oauth2';
      const auth = oauth && !can(ctx, step, 'oauth2', out) ? null : authOf(q.auth);
      if (q.auth && !auth && !oauth)
        out.push(
          todo(
            ctx,
            step,
            `auth type "${(q.auth as { type?: string }).type}" is not exported; set the header yourself`,
          ),
        );
      const asserts = exportableAsserts(ctx, step, out);
      if (gql && !q.allowErrors)
        asserts.push({ target: '$.errors', operator: 'notExists', expected: { t: 'null' } });
      if (q.contract)
        out.push({
          op: 'comment',
          text: 'StepForge also checked this response against the OpenAPI contract (not exported).',
        });
      out.push({
        op: 'api',
        method: gql ? 'POST' : String(q.method ?? 'GET').toUpperCase(),
        url: val(q.url ?? '/'),
        headers: Object.entries((q.headers as Record<string, unknown>) ?? {}).map(([k, v]) => [k, val(v)]),
        // A GraphQL step's `query` is the GraphQL text (sent in the body), not URL parameters.
        query:
          !gql && q.query && typeof q.query === 'object'
            ? Object.entries(q.query as Record<string, unknown>).map(([k, v]) => [k, val(v)])
            : [],
        body: gql
          ? val({
              query: q.query ?? '',
              ...(q.variables !== undefined && { variables: q.variables }),
              ...(q.operationName !== undefined && { operationName: q.operationName }),
            })
          : q.body === undefined || q.bodyType === 'none'
            ? null
            : val(q.body),
        bodyType: gql
          ? 'json'
          : ((q.bodyType as 'json') ??
            (q.body === undefined ? 'none' : typeof q.body === 'string' ? 'raw' : 'json')),
        auth,
        asserts,
        ...(into && { into }),
        label: step.label || describeStep(step as never),
      });
      if (gql) ctx.flags.api = true;
      break;
    }
    case 'api.extract':
      ctx.flags.api = true;
      if (!into) break;
      out.push({
        op: 'apiExtract',
        from: (q.from as 'body') ?? 'body',
        ...(typeof q.path === 'string' && { path: q.path }),
        ...(typeof q.name === 'string' && { name: q.name }),
        into,
      });
      break;

    // ─── Database ─────────────────────────────────────────────────────────
    case 'db.query':
    case 'db.runScript':
    case 'db.callProcedure': {
      const conn = String(q.connection ?? '');
      const known = ctx.input.connections.find((c) => c.name === conn)?.engine;
      // Not configured in the exported environment: the helper picks the driver from DB_<NAME>_URL at run time.
      const engine = known ?? 'any';
      if (!known)
        ctx.warnings.push({
          scenario: ctx.scenario.name,
          step: step.label || step.type,
          message: `the "${conn}" connection is not set up in this environment; all database drivers are included and DB_${conn.replace(/[^A-Za-z0-9]+/g, '_').toUpperCase()}_URL decides`,
        });
      if (engine === 'mongo') {
        if (step.type !== 'db.query') {
          out.push(
            todo(ctx, step, 'MongoDB has no SQL scripts or procedures; use a Mongo command in a query step'),
          );
          break;
        }
        if (!can(ctx, step, 'mongo', out)) break;
        ctx.flags.db = true;
        out.push({
          op: 'mongo',
          connection: conn,
          // A command written as JSON text (placeholders inside), parsed at run time as StepForge does.
          command: typeof q.sql === 'string' ? val(q.sql) : val(q.sql ?? {}),
          asserts: exportableAsserts(ctx, step, out),
          ...(into && { into }),
        });
        break;
      }
      if (engine === 'mssql') {
        out.push(
          todo(ctx, step, 'SQL Server helpers are not generated; the SQL file is exported for reference'),
        );
      }
      ctx.flags.db = true;
      const kind = step.type === 'db.query' ? 'query' : step.type === 'db.runScript' ? 'script' : 'procedure';
      const sql =
        kind === 'procedure'
          ? `CALL ${String(q.procedure ?? '')}(${((q.args as unknown[]) ?? []).map((_, i) => (engine === 'pg' ? `$${i + 1}` : '?')).join(', ')})`
          : String(kind === 'script' ? (q.script ?? '') : (q.sql ?? ''));
      const file = `sql/${ctx.slug}/${ctx.sqlName(camel(step.label || kind, kind))}.sql`;
      ctx.sqlFiles[file] =
        `-- ${ctx.scenario.name}: ${step.label || describeStep(step as never)}\n-- connection: ${conn} (${engine})\n${sql.trim()}\n`;
      if (engine === 'mssql') break;
      out.push({
        op: 'db',
        kind,
        connection: conn,
        engine,
        sql: sql.trim(),
        params: (((kind === 'procedure' ? q.args : q.params) as unknown[]) ?? []).map(val),
        asserts: exportableAsserts(ctx, step, out),
        ...(into && { into }),
        sqlFile: file,
      });
      break;
    }
    case 'db.extract':
      if (into) out.push({ op: 'dbExtract', path: String(q.path ?? 'value'), into });
      break;
    case 'db.mongoFind': {
      if (!can(ctx, step, 'mongo', out)) break;
      ctx.flags.db = true;
      // The same command StepForge builds from the step's fields.
      out.push({
        op: 'mongo',
        connection: String(q.connection ?? ''),
        command: val({
          collection: q.collection ?? '',
          find: q.filter ?? {},
          ...(q.projection ? { projection: q.projection } : {}),
          ...(q.sort ? { sort: q.sort } : {}),
          ...(q.limit ? { limit: Number(q.limit) } : {}),
        }),
        asserts: exportableAsserts(ctx, step, out),
        ...(into && { into }),
      });
      break;
    }
    case 'db.dataQualityCheck':
      out.push(todo(ctx, step, 'the data-quality audit runs only in StepForge'));
      break;

    // ─── Email ────────────────────────────────────────────────────────────
    case 'email.waitForEmail': {
      const inbox = q.inbox ? ctx.input.inboxes.find((i) => i.name === q.inbox) : undefined;
      if (inbox?.kind === 'imap') {
        out.push(
          todo(ctx, step, 'IMAP inboxes are not exported; the helper reads a Mailpit server (MAILPIT_URL)'),
        );
      }
      ctx.flags.email = true;
      out.push({
        op: 'emailWait',
        ...(q.to !== undefined && { to: val(q.to) }),
        ...(q.from !== undefined && { from: val(q.from) }),
        ...(q.subject !== undefined && { subject: val(q.subject) }),
        ...(q.contains !== undefined && { contains: val(q.contains) }),
        timeoutMs: num(q.timeoutMs, step.timeoutMs ?? 20_000),
        ...(into && { into }),
      });
      break;
    }
    case 'email.assertEmail': {
      const checks = (['subjectContains', 'bodyContains', 'from', 'hasLink', 'hasAttachment'] as const)
        .filter((k) => q[k] !== undefined && q[k] !== false)
        .map((k) => ({ kind: k, value: val(q[k]) }));
      out.push({ op: 'emailAssert', checks });
      break;
    }
    case 'email.extractFromEmail': {
      const kind = (q.kind as 'otp') ?? 'otp';
      out.push({
        op: 'emailExtract',
        kind,
        ...(q.contains !== undefined && { contains: val(q.contains) }),
        ...(typeof q.index === 'number' && { index: q.index }),
        ...(typeof q.pattern === 'string' && { pattern: q.pattern }),
        into: into ?? (kind === 'otp' ? 'otp' : kind),
      });
      break;
    }
    case 'email.openEmailLink':
      out.push({
        op: 'emailOpenLink',
        ...(q.contains !== undefined && { contains: val(q.contains) }),
        ...(typeof q.index === 'number' && { index: q.index }),
        ...(q.url !== undefined && { url: val(q.url) }),
      });
      break;

    // ─── Performance ──────────────────────────────────────────────────────
    case 'perf.pageMetrics':
    case 'perf.lighthouse':
    case 'perf.queryPlan':
      out.push(todo(ctx, step, 'performance measurements run only in StepForge'));
      break;
    case 'perf.loadTest':
      out.push(
        todo(ctx, step, 'load tests are not part of functional tests; export the scenario to k6 instead'),
      );
      break;

    // ─── Utility ──────────────────────────────────────────────────────────
    case 'util.setVariable':
      out.push({ op: 'setVar', name: String(q.name ?? into ?? 'value'), value: val(q.value) });
      break;
    case 'util.generateData': {
      const { kind, name, ...opts } = q as { kind?: string; name?: string };
      // Same default kind as StepForge's own "Generate data" step.
      out.push({ op: 'gen', kind: String(kind ?? 'name'), opts, into: into ?? String(name ?? 'value') });
      break;
    }
    case 'util.useData':
      out.push(
        todo(
          ctx,
          step,
          `rows of the test data source "${String(q.source ?? '')}" are read by StepForge at run time; set vars.${String(q.as || 'row')} from your own data`,
        ),
      );
      break;
    case 'util.wait':
      out.push({ op: 'wait', ms: num(q.ms, 1000) });
      break;
    case 'api.soap': {
      ctx.flags.api = true;
      if (!can(ctx, step, 'soap', out)) break;
      const oauth = (q.auth as { type?: string } | undefined)?.type === 'oauth2';
      const auth = oauth && !can(ctx, step, 'oauth2', out) ? null : authOf(q.auth);
      if (q.auth && !auth && !oauth)
        out.push(todo(ctx, step, `auth type "${(q.auth as { type?: string }).type}" is not exported`));
      const soap = soapRequest(String(q.body ?? ''), q.header ? String(q.header) : '', q.action, q.version);
      const own = Object.entries((q.headers as Record<string, unknown>) ?? {});
      out.push({
        op: 'api',
        method: 'POST',
        url: val(q.url ?? '/'),
        // The step's own headers win, as in StepForge.
        headers: [
          ...soap.headers
            .filter(([k]) => !own.some(([o]) => o.toLowerCase() === k))
            .map(([k, v]): [string, Val] => [k, str(v)]),
          ...own.map(([k, v]): [string, Val] => [k, val(v)]),
        ],
        query: [],
        body: val(soap.xml),
        bodyType: 'raw',
        auth,
        asserts: exportableAsserts(ctx, step, out),
        ...(into && { into }),
        label: step.label || describeStep(step as never),
        soap: {
          namespaces: Object.fromEntries(
            Object.entries((q.namespaces as Record<string, unknown>) ?? {}).map(([k, v]) => [k, String(v)]),
          ),
          allowFault: q.allowFault === true,
        },
      });
      break;
    }
    case 'api.kafkaProduce':
    case 'api.kafkaConsume': {
      ctx.flags.api = true;
      if (!can(ctx, step, 'kafka', out)) break;
      out.push({
        op: 'kafka',
        action: step.type === 'api.kafkaProduce' ? 'produce' : 'consume',
        params: val(q),
        timeoutMs: num(Number(q.timeoutMs), step.timeoutMs ?? DEFAULT_TIMEOUT),
        asserts: exportableAsserts(ctx, step, out),
        ...(into && { into }),
      });
      break;
    }
    case 'api.ftp': {
      ctx.flags.api = true;
      if (!can(ctx, step, 'ftp', out)) break;
      const action = String(q.action ?? 'list');
      if (!['upload', 'download', 'list', 'delete', 'exists'].includes(action)) {
        out.push(todo(ctx, step, `unknown FTP action "${action}"`));
        break;
      }
      out.push({
        op: 'ftp',
        action: action as 'list',
        params: val(q),
        asserts: exportableAsserts(ctx, step, out),
        ...(into && { into }),
      });
      break;
    }
    case 'util.manual':
      out.push(todo(ctx, step, `a manual check, done by a person: ${String(q.instruction ?? '')}`));
      break;
    case 'util.log':
      out.push({ op: 'log', message: val(q.message ?? '') });
      break;
    case 'util.runScript':
      out.push({ op: 'script', code: String(q.code ?? ''), ...(into && { into }) });
      break;
    case 'util.if': {
      if ((q.condition as { type?: string } | undefined)?.type === 'element') {
        const cond = pageCond(ctx, step, e, q.condition, out);
        if (!cond) break;
        out.push({
          op: 'ifPage',
          cond,
          then: listOps(ctx, (q.steps as CodegenStep[]) ?? [], depth),
          else: listOps(ctx, (q.else as CodegenStep[]) ?? [], depth),
        });
        break;
      }
      const c = (q.condition as { value?: unknown; operator?: string; expected?: unknown }) ?? {};
      out.push({
        op: 'if',
        value: val(c.value),
        operator: String(c.operator ?? 'equals'),
        expected: val(c.expected),
        then: listOps(ctx, (q.steps as CodegenStep[]) ?? [], depth),
        else: listOps(ctx, (q.else as CodegenStep[]) ?? [], depth),
      });
      break;
    }
    case 'util.loop':
      if (q.while !== undefined) {
        if (!can(ctx, step, 'repeatWhile', out)) break;
        // The count is the safety limit (default 100, at most 1000), as in StepForge.
        const limit = q.count === undefined || q.count === '' ? 100 : Number(q.count);
        if (!Number.isFinite(limit)) {
          out.push(todo(ctx, step, 'the loop limit must be a number to be exported'));
          break;
        }
        const w = (q.while ?? {}) as {
          type?: string;
          value?: unknown;
          operator?: string;
          expected?: unknown;
        };
        let cond: Extract<Op, { op: 'while' }>['cond'] | null;
        if (w.type === 'element') {
          const pc = pageCond(ctx, step, e, w, out);
          cond = pc && { kind: 'page', ...pc };
        } else
          cond = {
            kind: 'value',
            value: val(w.value),
            operator: String(w.operator ?? 'equals'),
            expected: val(w.expected),
          };
        if (!cond) break;
        out.push({
          op: 'while',
          cond,
          max: Math.min(limit || 100, MAX_LOOP_ITERATIONS),
          body: listOps(ctx, (q.steps as CodegenStep[]) ?? [], depth),
        });
        break;
      }
      out.push({
        op: 'loop',
        ...(q.over !== undefined ? { over: val(q.over) } : { count: val(q.count ?? 1) }),
        as: String(q.as ?? 'item'),
        body: listOps(ctx, (q.steps as CodegenStep[]) ?? [], depth),
      });
      break;
    case 'util.useBlock':
    case 'util.callScenario': {
      const isBlock = step.type === 'util.useBlock';
      const id = String(isBlock ? q.blockId : q.scenarioId);
      const target = isBlock ? ctx.input.blocks[id] : ctx.input.library[id];
      if (!target) {
        out.push(todo(ctx, step, `the ${isBlock ? 'block' : 'scenario'} it uses was not found`));
        break;
      }
      if (depth >= MAX_DEPTH) {
        out.push(todo(ctx, step, 'calls are nested too deeply (recursion?)'));
        break;
      }
      // Hook calls (inlined by the export) say so; they run only when the test gets that far.
      const hook =
        q.hook === 'before'
          ? 'Before each test — block'
          : q.hook === 'after'
            ? 'After each test — block'
            : null;
      out.push({ op: 'comment', text: `${hook ?? (isBlock ? 'Block' : 'Scenario')}: ${target.name}` });
      // Block inputs: the value this use passes (or the default) becomes a variable, as when StepForge runs it.
      if (isBlock) {
        const given = (q.inputs && typeof q.inputs === 'object' ? q.inputs : {}) as Record<string, unknown>;
        const declared = (target as { inputs?: { name: string; default?: string }[] }).inputs ?? [];
        const names = [
          ...declared.map((d) => d.name),
          ...Object.keys(given).filter((k) => !declared.some((d) => d.name === k)),
        ];
        for (const name of names) {
          const value =
            given[name] !== undefined && given[name] !== ''
              ? given[name]
              : declared.find((d) => d.name === name)?.default;
          if (value !== undefined) out.push({ op: 'setVar', name, value: val(value) });
        }
      }
      out.push(...listOps(ctx, target.steps, depth + 1));
      break;
    }
    case 'ui.tap': {
      if (!can(ctx, step, 'tap', out)) break;
      const x = needEl();
      if (x) out.push({ op: 'act', action: 'tap', el: x });
      break;
    }
    case 'ui.download': {
      if (!can(ctx, step, 'download', out)) break;
      const x = needEl();
      if (x)
        out.push({
          op: 'download',
          el: x,
          asserts: ownAsserts(ctx, step, out, (t) => ['fileName', 'size', 'content'].includes(t)),
          ...(into && { into }),
        });
      break;
    }
    case 'ui.waitForResponse': {
      if (!can(ctx, step, 'waitResponse', out)) break;
      if (!q.url) {
        out.push(todo(ctx, step, 'the step has no URL to wait for'));
        break;
      }
      out.push({
        op: 'waitResponse',
        url: val(q.url),
        ...(q.method ? { method: String(q.method).toUpperCase() } : {}),
        ...(q.status !== undefined && q.status !== '' && { status: Number(q.status) }),
        timeoutMs: step.timeoutMs ?? DEFAULT_TIMEOUT,
        asserts: ownAsserts(
          ctx,
          step,
          out,
          (t) => ['status', 'body', 'url'].includes(t) || t.startsWith('header:') || t.startsWith('$'),
        ),
        ...(into && { into }),
      });
      break;
    }
    case 'ui.mockRoute': {
      if (!can(ctx, step, 'mockRoute', out)) break;
      const action = String(q.action ?? 'fulfill');
      const times =
        q.times !== undefined && q.times !== '' && Number(q.times) !== 0 ? Number(q.times) : undefined;
      if (
        !q.url ||
        !['fulfill', 'abort', 'delay', 'remove'].includes(action) ||
        (times !== undefined && !(Number.isInteger(times) && times > 0))
      ) {
        out.push(todo(ctx, step, 'the mock needs a URL, a known action and a whole number of times'));
        break;
      }
      out.push({
        op: 'mockRoute',
        url: val(q.url),
        action: action as 'fulfill',
        ...(q.method ? { method: String(q.method).toUpperCase() } : {}),
        status: num(Number(q.status ?? 200), 200),
        body: q.body === undefined || q.body === null ? null : val(q.body),
        ...(q.contentType ? { contentType: String(q.contentType) } : {}),
        delayMs: num(Number(q.delayMs ?? 0), 0),
        ...(times !== undefined && { times }),
      });
      break;
    }
    case 'ui.setOffline': {
      if (!can(ctx, step, 'offline', out)) break;
      // `state` (offline/online) wins; older steps have only `offline`, where missing means offline.
      const offline =
        q.state !== undefined && q.state !== ''
          ? String(q.state) !== 'online'
          : q.offline === undefined
            ? true
            : !!q.offline && q.offline !== 'false';
      out.push({ op: 'offline', offline });
      break;
    }
    case 'ui.storage': {
      if (!can(ctx, step, 'storage', out)) break;
      const kind = String(q.kind ?? 'cookie');
      const action = String(q.action ?? 'get');
      if (!['get', 'set', 'remove', 'clear'].includes(action) || (!q.name && action !== 'clear')) {
        out.push(todo(ctx, step, `storage ${action} needs a name`));
        break;
      }
      out.push({
        op: 'storage',
        kind:
          kind === 'session' || kind === 'sessionStorage'
            ? 'session'
            : kind === 'cookie'
              ? 'cookie'
              : 'local',
        action: action as 'get',
        name: val(q.name === undefined ? '' : String(q.name)),
        // A value that is not text is stored as JSON, as StepForge does.
        value:
          q.value === undefined || q.value === null
            ? str('')
            : typeof q.value === 'string'
              ? val(q.value)
              : str(JSON.stringify(q.value)),
        asserts: action === 'get' ? ownAsserts(ctx, step, out, (t) => t === 'value' || t === 'exists') : [],
        ...(into && action === 'get' && { into }),
      });
      break;
    }
    case 'ui.setClock': {
      if (!can(ctx, step, 'clock', out)) break;
      const action = String(q.action ?? 'set');
      const hasTime = q.time !== undefined && q.time !== '';
      if (!['set', 'install', 'fastForward'].includes(action) || (action === 'set' && !hasTime)) {
        out.push(todo(ctx, step, 'setClock needs a known action, and a "time" to fix the clock at'));
        break;
      }
      out.push({
        op: 'clock',
        action: action as 'set',
        // An epoch in milliseconds (number or digits) or an ISO date, as StepForge reads it.
        ...(hasTime && {
          time:
            typeof q.time === 'string' && q.time.trim() !== '' && !isNaN(Number(q.time))
              ? val(Number(q.time))
              : val(q.time),
        }),
        ms: num(Number(q.ms ?? 60_000), 60_000),
      });
      break;
    }
    case 'ui.networkSummary': {
      if (!can(ctx, step, 'netSummary', out)) break;
      out.push({
        op: 'netSummary',
        since: q.since === 'lastNavigation' ? 'lastNavigation' : 'test',
        asserts: ownAsserts(ctx, step, out, (t) => NET_TARGETS.includes(t) || /^(requests|bytes):.+/.test(t)),
        ...(into && { into }),
      });
      break;
    }
    case 'ui.swipe':
    case 'ui.longPress':
    case 'ui.scrollTo':
    case 'ui.back':
    case 'ui.hideKeyboard':
    case 'ui.rotate':
    case 'ui.appState':
    case 'ui.deepLink':
    case 'ui.setLocation':
    case 'ui.permission':
    case 'ui.pushNotification':
    case 'ui.menu':
      out.push(todo(ctx, step, 'phone and desktop-app steps are exported by the Appium and Maestro exports'));
      break;
    default:
      out.push(todo(ctx, step, 'this step type has no exporter'));
  }

  // Generic assertions on UI steps (API and DB steps carry theirs inside their op).
  if (group === 'ui' && step.type !== 'ui.assert' && !OWN_ASSERTS.has(step.type)) {
    for (const a of step.assertions) {
      const native = nativeCheck(a.target, a.operator, a.expected);
      const pageLevel = a.target === 'url' || a.target === 'title';
      if (native && (pageLevel || e)) {
        out.push({
          op: 'assert',
          check: native.check,
          el: pageLevel ? null : e,
          ...(a.expected !== undefined &&
            native.check !== 'visible' &&
            native.check !== 'hidden' && { expected: val(a.expected) }),
          ...(native.attribute && { attribute: native.attribute }),
          soft: !!step.continueOnFail,
        });
        continue;
      }
      const src: Source | undefined = a.target.startsWith('attr:') ? 'attribute' : SOURCE[a.target];
      if (!src || (!pageLevel && !e)) {
        out.push(todo(ctx, step, `assertion on "${a.target}" is not exported`));
        continue;
      }
      const tmp = ctx.tmp();
      out.push({
        op: 'read',
        source: src,
        el: pageLevel ? null : e,
        ...(src === 'attribute' && { attribute: a.target.slice(5) }),
        into: tmp,
      });
      out.push({
        op: 'check',
        actual: { t: 'ref', ref: { scope: 'vars', name: tmp } },
        operator: a.operator,
        expected: val(a.expected),
        message: a.message ?? `${a.target} ${a.operator}`,
      });
    }
  }
  return out;
}

/** Steps that check their own result (a file, a response, a stored value, the traffic), not the page. */
const OWN_ASSERTS = new Set(['ui.download', 'ui.waitForResponse', 'ui.storage', 'ui.networkSummary']);
const NET_TARGETS = [
  'requests',
  'bytes',
  'kb',
  'failed',
  'thirdPartyRequests',
  'thirdPartyHosts',
  'hosts',
  'thirdPartyHostNames',
];
const DEFAULT_TIMEOUT = 15_000;

/** A page condition on the control step's own element, or null (with a TODO). */
function pageCond(ctx: Ctx, step: CodegenStep, e: El | null, raw: unknown, out: Op[]): PageCond | null {
  if (!can(ctx, step, 'pageCondition', out)) return null;
  const c = (raw ?? {}) as { check?: string; expected?: unknown; timeoutMs?: unknown };
  const check = String(c.check ?? 'visible') as PageCheck;
  if (!PAGE_CHECKS.includes(check)) {
    out.push(todo(ctx, step, `unknown page check "${check}"`));
    return null;
  }
  if (!e) {
    out.push(
      todo(
        ctx,
        step,
        step.locators.length
          ? 'image locators (pictures) are not exported; add an id, text or CSS locator'
          : 'a page condition needs an element (set a locator)',
      ),
    );
    return null;
  }
  // The test needs a browser page even when its other steps are API calls.
  ctx.flags.ui = true;
  const t = Number(c.timeoutMs ?? 2000);
  return {
    el: e,
    check,
    ...(c.expected !== undefined && c.expected !== null && { expected: val(c.expected) }),
    timeoutMs: Number.isFinite(t) ? Math.max(0, t) : 2000,
  };
}

const ENVELOPE_NS = {
  '1.1': 'http://schemas.xmlsoap.org/soap/envelope/',
  '1.2': 'http://www.w3.org/2003/05/soap-envelope',
} as const;

/**
 * The envelope and headers StepForge sends for a SOAP step: a whole envelope as written, or the body wrapped in one
 * of the chosen version (with an optional header). SOAP 1.1: text/xml and SOAPAction; 1.2: the action in the type.
 */
function soapRequest(
  rawBody: string,
  header: string,
  rawAction: unknown,
  rawVersion: unknown,
): { xml: string; headers: [string, string][] } {
  const body = rawBody.trim();
  const whole =
    /^(?:\s*(?:<\?[\s\S]*?\?>|<!--[\s\S]*?-->|<!DOCTYPE[^>[]*(?:\[[\s\S]*?\])?\s*>))*\s*<([\w.-]+:)?Envelope[\s>/]/.test(
      body,
    );
  // Without a version, a whole envelope says which one it is through its namespace.
  const declared = /<(?:[\w.-]+:)?Envelope\b[^>]*\bxmlns(?::[\w.-]+)?\s*=\s*["']([^"']+)["']/.exec(body)?.[1];
  const version =
    rawVersion === '1.2' || (!rawVersion && whole && declared === ENVELOPE_NS['1.2']) ? '1.2' : '1.1';
  const xml = whole
    ? body
    : `<?xml version="1.0" encoding="utf-8"?>\n<soap:Envelope xmlns:soap="${ENVELOPE_NS[version]}">${
        header.trim() ? `\n  <soap:Header>${header.trim()}</soap:Header>` : ''
      }\n  <soap:Body>${body}</soap:Body>\n</soap:Envelope>`;
  const action = rawAction === undefined || rawAction === null ? '' : String(rawAction).trim();
  return {
    xml,
    headers:
      version === '1.2'
        ? [['content-type', `application/soap+xml; charset=utf-8${action ? `; action="${action}"` : ''}`]]
        : [
            ['content-type', 'text/xml; charset=utf-8'],
            ['soapaction', `"${action}"`],
          ],
  };
}

const WEB_ONLY = new Set([
  'ui.hover',
  'ui.rightclick',
  'ui.upload',
  'ui.switchTab',
  'ui.closeTab',
  'ui.switchFrame',
  'ui.download',
  'ui.waitForResponse',
  'ui.mockRoute',
  'ui.setOffline',
  'ui.storage',
  'ui.setClock',
  'ui.networkSummary',
]);

/**
 * UI steps of a phone or desktop app that differ from the web: app actions, and web-page steps that have no
 * equivalent (TODO). Returns false for the steps shared with the web (click, fill, assert…), handled as usual.
 */
function nativeStep(ctx: Ctx, step: CodegenStep, e: El | null, needEl: () => El | null, out: Op[]): boolean {
  const q = p(step);
  const app = (method: AppMethod, els: El[], ...args: unknown[]) =>
    out.push({ op: 'app', method, els, args: args.map(val) });
  const withEl = (f: (x: El) => void) => {
    const x = needEl();
    if (x) f(x);
  };
  if (WEB_ONLY.has(step.type)) {
    out.push(todo(ctx, step, 'this is a web-page step; phone and desktop apps have no equivalent'));
    return true;
  }
  switch (step.type) {
    case 'ui.navigate': {
      const url = String(q.url ?? '');
      if (/^[a-z][a-z0-9+.-]*:/i.test(url) && !/^https?:/i.test(url)) app('deepLink', [], url);
      else
        out.push(
          todo(
            ctx,
            step,
            'phone and desktop apps have no pages to open; use a deep link (myapp://…) instead',
          ),
        );
      return true;
    }
    case 'ui.tap':
      withEl((x) => out.push({ op: 'act', action: 'click', el: x }));
      return true;
    case 'ui.select':
      withEl((x) => app('select', [x], q.label ?? q.value ?? ''));
      return true;
    case 'ui.scroll':
      if (e) app('scrollTo', [e], 'down', 10);
      else app('scroll', [], num(q.y, 600) < 0 ? 'up' : 'down');
      return true;
    case 'ui.swipe':
    case 'ui.dragDrop': {
      const target = Array.isArray(q.target) ? elOf(q.target as Loc[], ctx.native) : null;
      if (step.type === 'ui.dragDrop' || (Array.isArray(q.target) && q.target.length)) {
        withEl((x) => {
          if (target) app('drag', [x, target]);
          else out.push(todo(ctx, step, 'the drop target has no usable locator'));
        });
        return true;
      }
      const direction = String(q.direction ?? 'up');
      const percent = num(q.percent, 0.75);
      if (step.locators.length) withEl((x) => app('swipeOn', [x], direction, percent));
      else app('swipe', [], direction, percent);
      return true;
    }
    case 'ui.longPress':
      withEl((x) => app('longPress', [x], num(q.durationMs, 1000)));
      return true;
    case 'ui.scrollTo':
      withEl((x) => app('scrollTo', [x], q.direction === 'up' ? 'up' : 'down', num(q.maxSwipes, 10)));
      return true;
    case 'ui.back':
      app('back', []);
      return true;
    case 'ui.hideKeyboard':
      app('hideKeyboard', []);
      return true;
    case 'ui.rotate':
      app('rotate', [], q.orientation === 'portrait' ? 'portrait' : 'landscape');
      return true;
    case 'ui.appState': {
      const action = String(q.action ?? 'launch');
      if (action === 'background')
        app(
          'backgroundApp',
          [],
          q.seconds === undefined || q.seconds === '' ? -1 : num(Number(q.seconds), -1),
        );
      else if (action === 'close') app('closeApp', []);
      else if (action === 'reset') app('resetApp', []);
      else app('launchApp', []);
      return true;
    }
    case 'ui.deepLink':
      app('deepLink', [], q.url ?? '');
      return true;
    case 'ui.setLocation':
      app('setLocation', [], num(Number(q.latitude), 0), num(Number(q.longitude), 0));
      return true;
    case 'ui.permission':
      app('permission', [], String(q.permission ?? ''), q.action !== 'revoke');
      return true;
    case 'ui.pushNotification':
      app('pushNotification', [], q.title ?? '', q.body ?? '');
      return true;
    case 'ui.menu':
      app('menu', [], q.path ?? '');
      return true;
    case 'ui.handleDialog':
      app('handleDialog', [], q.action !== 'dismiss', q.buttonLabel ? q.buttonLabel : null);
      return true;
    case 'ui.waitFor':
      if (!e) {
        out.push(todo(ctx, step, 'in phone and desktop apps, wait for an element (set a locator)'));
        return true;
      }
      return false;
    case 'ui.assert': {
      const check = String(q.check ?? 'visible');
      if (check.startsWith('url') || check.startsWith('title')) {
        out.push(todo(ctx, step, 'phone and desktop apps have no URL or page title to check'));
        return true;
      }
      return false;
    }
    case 'ui.extract':
      if (['url', 'title'].includes(String(q.from ?? ''))) {
        out.push(todo(ctx, step, 'phone and desktop apps have no URL or page title to read'));
        return true;
      }
      return false;
    default:
      return false;
  }
}

function authOf(a: unknown): Auth | null {
  if (!a || typeof a !== 'object') return null;
  const x = a as Record<string, unknown>;
  switch (x.type) {
    case 'bearer':
      return { type: 'bearer', token: val(x.token ?? '') };
    case 'basic':
      return { type: 'basic', username: val(x.username ?? ''), password: val(x.password ?? '') };
    case 'apiKey':
      return {
        type: 'apiKey',
        in: x.in === 'query' ? 'query' : 'header',
        name: String(x.name ?? 'x-api-key'),
        value: val(x.value ?? ''),
      };
    case 'cookie':
      return { type: 'cookie', name: String(x.name ?? ''), value: val(x.value ?? '') };
    case 'oauth2':
      return {
        type: 'oauth2',
        tokenUrl: val(x.tokenUrl ?? ''),
        clientId: val(x.clientId ?? ''),
        clientSecret: val(x.clientSecret ?? ''),
        scope: x.scope === undefined || x.scope === '' ? null : val(x.scope),
      };
    default:
      return null;
  }
}

const normalise = (s: Partial<CodegenStep> & { type: string }): CodegenStep => ({
  ...s,
  params: s.params ?? {},
  locators: s.locators ?? [],
  assertions: s.assertions ?? [],
});

/** Each step starts with a comment: its label, or the plain-English sentence StepForge shows. */
function listOps(ctx: Ctx, steps: CodegenStep[], depth: number): Op[] {
  // Nested steps (inside util.if / util.loop params) are stored as written, without defaults.
  return steps.map(normalise).flatMap((s) => {
    const ops = stepOps(ctx, s, depth);
    if (
      s.enabled === false ||
      ops[0]?.op === 'todo' ||
      s.type === 'util.useBlock' ||
      s.type === 'util.callScenario'
    )
      return ops;
    return [{ op: 'comment' as const, text: s.label || describeStep(s as never) }, ...ops];
  });
}

/** JSON Schema checks are kept where the target has a validator (feature `schema`); anything else is kept. */
function exportableAsserts(ctx: Ctx, step: CodegenStep, out: Op[]): Assert[] {
  return step.assertions.flatMap((a) => {
    if (a.operator === 'matchesSchema' && !can(ctx, step, 'schema', out, a.target)) return [];
    return [{ target: a.target, operator: a.operator, expected: val(a.expected) }];
  });
}

/** The ops nested in a control op (then and else branches, loop bodies). */
export function children(op: Op): Op[] {
  if (op.op === 'if' || op.op === 'ifPage') return [...op.then, ...op.else];
  if (op.op === 'loop' || op.op === 'while') return op.body;
  return [];
}

export function walk(ops: Op[], f: (op: Op) => void): void {
  for (const op of ops) {
    f(op);
    walk(children(op), f);
  }
}

const SCOPES = new Set(['baseUrl', 'env', 'secret', 'data', 'vars', 'run', 'random']);
/** Every placeholder reference anywhere inside the ops. */
function collectRefs(x: unknown, out: Ref[]): void {
  if (!x || typeof x !== 'object') return;
  if (Array.isArray(x)) return x.forEach((y) => collectRefs(y, out));
  const o = x as Record<string, unknown>;
  if (typeof o.scope === 'string' && typeof o.name === 'string' && SCOPES.has(o.scope)) {
    out.push(o as Ref);
    return;
  }
  for (const v of Object.values(o)) collectRefs(v, out);
}

// ─── Page objects ───────────────────────────────────────────────────────────
const ROLE_SUFFIX: Record<string, string> = {
  button: 'Button',
  link: 'Link',
  textbox: 'Field',
  checkbox: 'Checkbox',
  radio: 'Option',
  combobox: 'Select',
  heading: 'Heading',
  status: 'Status',
  alert: 'Alert',
  tab: 'Tab',
  row: 'Row',
};

function elementName(l: Loc, n: number): string {
  switch (l.strategy) {
    case 'testId':
      return camel(l.value, `element${n}`);
    case 'role':
      return camel(`${l.name ?? ''} ${ROLE_SUFFIX[l.value] ?? l.value}`, `element${n}`);
    case 'label':
    case 'placeholder':
      return camel(`${l.value} field`, `element${n}`);
    case 'text':
      return camel(`${l.value.split(/\s+/).slice(0, 4).join(' ')} text`, `element${n}`);
    default:
      return `element${n}`;
  }
}

function pageKey(url: Val): string {
  const s = String(plain(url))
    .replace(/^\{\{env\.baseUrl\}\}/, '')
    .replace(/^https?:\/\/[^/]+/, '');
  const path = s.split(/[?#]/)[0]!;
  const segs = path
    .split('/')
    .filter((x) => x && !/^\d+$/.test(x) && !/^[0-9A-Z]{26}$/.test(x) && !x.includes('{{'));
  return segs.length ? pascal(segs.join(' ')) : 'Home';
}

function assignPages(tests: TestPlan[]): Map<string, PomPage> {
  const pages = new Map<string, PomPage & { names: (s: string) => string; byLoc: Map<string, string> }>();
  for (const t of tests) {
    let current = 'Home';
    let inFrame = false;
    const visit = (ops: Op[]) => {
      for (const op of ops) {
        if (op.op === 'goto') current = pageKey(op.url);
        // A URL check also tells which page we are on ("URL matches /$", "URL contains /verify").
        const urlHint =
          op.op === 'waitUrl'
            ? op.url
            : op.op === 'assert' && op.check.startsWith('url')
              ? op.expected
              : undefined;
        if (urlHint && isStatic(urlHint)) {
          const path = String(plain(urlHint)).replace(/^\^/, '').replace(/\$$/, '').replace(/\\/g, '');
          if (path.startsWith('/') && !/[*+?()[\]{}|]/.test(path)) current = pageKey(str(path));
        }
        if (op.op === 'frame') inFrame = op.selector !== null;
        // After a tab switch the page objects would point at the first tab: keep those locators inline.
        if (op.op === 'tab' || op.op === 'closeTab') inFrame = true;
        if (op.op === 'if' || op.op === 'ifPage') {
          visit(op.then);
          visit(op.else);
        }
        if (op.op === 'loop' || op.op === 'while') visit(op.body);
        for (const e of elsOf(op)) {
          if (inFrame || e.pom) continue;
          // Locators with placeholders stay inline (page objects hold static locators).
          if ([e.loc.value, e.loc.name ?? ''].some((s) => s.includes('{{'))) continue;
          let page = pages.get(current);
          if (!page) {
            page = { className: `${current}Page`, elements: [], names: uniquer(), byLoc: new Map() };
            pages.set(current, page);
          }
          const key = JSON.stringify(e.loc);
          let name = page.byLoc.get(key);
          if (!name) {
            name = page.names(elementName(e.loc, page.elements.length + 1));
            page.byLoc.set(key, name);
            page.elements.push({ name, loc: e.loc });
          }
          e.pom = { page: current, name };
        }
      }
    };
    visit(t.ops);
  }
  return new Map([...pages].map(([k, v]) => [k, { className: v.className, elements: v.elements }]));
}

function elsOf(op: Op): El[] {
  const out: El[] = [];
  if ('el' in op && op.el) out.push(op.el);
  if (op.op === 'drag') out.push(op.to);
  if (op.op === 'app') out.push(...op.els);
  return out;
}

/** Builds the plan shared by every generator. */
export function buildPlan(
  input: CodegenInput,
  opts: { pom?: boolean; native?: boolean; features?: Features; label?: string } = {},
): Plan {
  const platform = input.application.platform;
  const native =
    opts.native && platform && platform !== 'web' && platform !== 'electron'
      ? (platform as AppPlatform)
      : null;
  const warnings: Warning[] = [];
  const sqlFiles: Record<string, string> = {};
  const slugs = uniquer();
  const files = new Map<string, (name: string) => string>();
  const tests: TestPlan[] = input.scenarios.map((scenario) => {
    const slug = slugs(camel(scenario.name, 'scenario'));
    // Scenarios whose names read the same (or have no Latin letters) must not overwrite each other's test file.
    const folder = scenario.modulePath.map((m) => kebab(m, 'module')).join('/');
    if (!files.has(folder)) files.set(folder, uniquer());
    const file = files.get(folder)!(kebab(scenario.name, 'scenario'));
    let n = 0;
    const flags = { ui: false, api: false, db: false, email: false };
    const ctx: Ctx = {
      input,
      scenario,
      warnings,
      sqlFiles,
      sqlName: uniquer(),
      slug,
      tmp: () => `actual${++n}`,
      flags,
      native,
      features: opts.features ?? null,
      label: opts.label ?? 'this export',
    };
    const ops = listOps(ctx, scenario.steps, 0);
    const refs: Ref[] = [];
    collectRefs(ops, refs);
    return {
      scenario,
      slug,
      file,
      ops,
      refs,
      usesUi: flags.ui,
      usesApi: flags.api,
      usesDb: flags.db,
      usesEmail: flags.email,
    };
  });
  if (input.application.platform === 'electron' && tests.some((t) => t.usesUi))
    warnings.push({
      message:
        'This is a desktop (Electron) app: the exported UI tests open a browser at the base URL. Start the app ' +
        "with Playwright's _electron.launch() instead (see docs/DESKTOP_APPS.md).",
    });
  const phone = {
    android: 'an Android',
    ios: 'an iOS',
    macos: 'a macOS desktop',
    windows: 'a Windows desktop',
    linux: 'a Linux desktop',
  }[input.application.platform as 'android' | 'ios' | 'macos' | 'windows' | 'linux'];
  if (phone && !native && tests.some((t) => t.usesUi))
    warnings.push({
      message:
        `This is ${phone} app: the exported UI tests open a browser at the base URL. Use the Appium or ` +
        'Maestro export for its screens; API, database and email steps export as usual here.',
    });
  const all = tests.flatMap((t) => t.refs);
  const secrets = [...new Set([...all.filter((r) => r.scope === 'secret').map((r) => r.name)])].sort();
  const variables = [
    ...new Set([
      ...Object.keys(input.environment.variables),
      ...all.filter((r) => r.scope === 'env').map((r) => r.name),
    ]),
  ].sort();
  return {
    input,
    tests,
    pages: opts.pom ? assignPages(tests) : new Map(),
    sqlFiles,
    warnings,
    secrets,
    variables,
    native,
  };
}

export { isStatic };
