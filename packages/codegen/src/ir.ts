import { describeStep } from '@stepforge/core';
import type { CodegenInput, CodegenScenario, CodegenStep, Warning } from './types.ts';
import { camel, isStatic, pascal, plain, str, uniquer, val, type Ref, type Val } from './values.ts';

/**
 * Steps → a small, language-neutral list of operations. Every generator prints these; anything a target cannot
 * express becomes a `todo` op (a `TODO(StepForge)` comment plus a warning), never silently broken code.
 */
export type Loc = { strategy: string; value: string; name?: string };
export type El = { loc: Loc; alts: Loc[]; pom?: { page: string; name: string } };

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
  | { type: 'cookie'; name: string; value: Val };
export type Assert = { target: string; operator: string; expected: Val };

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
        | 'scrollIntoView';
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
  | { op: 'emailOpenLink'; contains?: Val; index?: number; url?: Val };

export type TestPlan = {
  scenario: CodegenScenario;
  /** File-friendly unique base name of the scenario. */
  slug: string;
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

const el = (step: CodegenStep): El | null =>
  step.locators.length ? { loc: step.locators[0]!, alts: step.locators.slice(1) } : null;

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
};

function todo(ctx: Ctx, step: CodegenStep, message: string): Op {
  ctx.warnings.push({ scenario: ctx.scenario.name, step: step.label || step.type, message });
  return { op: 'todo', text: `${step.type}: ${message}` };
}

function stepOps(ctx: Ctx, step: CodegenStep, depth: number): Op[] {
  if (step.enabled === false)
    return [{ op: 'comment', text: `Disabled in StepForge: ${describeStep(step as never)}` }];
  const q = p(step);
  const out: Op[] = [];
  const e = el(step);
  const into = step.captureAs;
  const group = step.type.split('.')[0];
  if (group === 'ui') ctx.flags.ui = true;
  const needEl = (): El | null => {
    if (!e) out.push(todo(ctx, step, 'the step has no locator'));
    return e;
  };

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
      const auth = authOf(q.auth);
      if (q.auth && !auth)
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
        query: Object.entries((q.query as Record<string, unknown>) ?? {}).map(([k, v]) => [k, val(v)]),
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
        out.push(
          todo(ctx, step, 'MongoDB steps are not exported; use the MongoDB driver of the target language'),
        );
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
    case 'db.mongoFind':
      out.push(
        todo(ctx, step, 'MongoDB steps are not exported; use the MongoDB driver of the target language'),
      );
      break;
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
      out.push({ op: 'gen', kind: String(kind ?? 'word'), opts, into: into ?? String(name ?? 'value') });
      break;
    }
    case 'util.wait':
      out.push({ op: 'wait', ms: num(q.ms, 1000) });
      break;
    case 'util.log':
      out.push({ op: 'log', message: val(q.message ?? '') });
      break;
    case 'util.runScript':
      out.push({ op: 'script', code: String(q.code ?? ''), ...(into && { into }) });
      break;
    case 'util.if': {
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
      out.push({ op: 'comment', text: `${isBlock ? 'Block' : 'Scenario'}: ${target.name}` });
      out.push(...listOps(ctx, target.steps, depth + 1));
      break;
    }
    default:
      out.push(todo(ctx, step, 'this step type has no exporter'));
  }

  // Generic assertions on UI steps (API and DB steps carry theirs inside their op).
  if (group === 'ui' && step.type !== 'ui.assert') {
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

/** JSON Schema checks run only in StepForge; anything else is kept. */
function exportableAsserts(ctx: Ctx, step: CodegenStep, out: Op[]): Assert[] {
  return step.assertions.flatMap((a) => {
    if (a.operator === 'matchesSchema') {
      out.push(todo(ctx, step, `the JSON Schema check on "${a.target}" is not exported`));
      return [];
    }
    return [{ target: a.target, operator: a.operator, expected: val(a.expected) }];
  });
}

export function walk(ops: Op[], f: (op: Op) => void): void {
  for (const op of ops) {
    f(op);
    if (op.op === 'if') {
      walk(op.then, f);
      walk(op.else, f);
    } else if (op.op === 'loop') walk(op.body, f);
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
        if (op.op === 'if') {
          visit(op.then);
          visit(op.else);
        }
        if (op.op === 'loop') visit(op.body);
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
  return out;
}

/** Builds the plan shared by every generator. */
export function buildPlan(input: CodegenInput, opts: { pom?: boolean } = {}): Plan {
  const warnings: Warning[] = [];
  const sqlFiles: Record<string, string> = {};
  const slugs = uniquer();
  const tests: TestPlan[] = input.scenarios.map((scenario) => {
    const slug = slugs(camel(scenario.name, 'scenario'));
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
    };
    const ops = listOps(ctx, scenario.steps, 0);
    const refs: Ref[] = [];
    collectRefs(ops, refs);
    return {
      scenario,
      slug,
      ops,
      refs,
      usesUi: flags.ui,
      usesApi: flags.api,
      usesDb: flags.db,
      usesEmail: flags.email,
    };
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
  };
}

export { isStatic };
