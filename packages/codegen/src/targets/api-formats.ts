import { CREDIT, casesOf, ciFiles, day, envExample, headerLines, readme } from '../common.ts';
import type { Op, Plan, TestPlan } from '../ir.ts';
import { jsJson, jsKey, jsStr, jsVal } from '../lang/js.ts';
import type { CodegenOptions, GeneratedProject, Warning } from '../types.ts';
import { envName, kebab, plain, snake, type Part, type Ref, type Val } from '../values.ts';

/** k6, Postman v2.1 and cURL: API steps only. Everything else is reported, never silently dropped. */

const isApi = (t: TestPlan) => t.usesApi;
const SKIP_UI = 'skipped: it has no API steps';

const MAX_UNROLL = 20;
const unrollable = (op: Extract<Op, { op: 'loop' }>) =>
  op.over
    ? op.over.t === 'arr' && op.over.items.length <= MAX_UNROLL
    : !!op.count && op.count.t === 'num' && op.count.v >= 0 && op.count.v <= MAX_UNROLL;

function flat(ops: Op[], warn: (m: string) => void, where: string, allow: Op['op'][]): Op[] {
  const out: Op[] = [];
  for (const op of ops) {
    if (op.op === 'comment' || op.op === 'todo') out.push(op);
    else if (allow.includes(op.op)) out.push(op);
    else if (op.op === 'loop' && allow.includes('setVar') && unrollable(op)) {
      // A loop over a fixed list (or a fixed count) is written out once per item.
      const items = op.over
        ? (op.over as Extract<Val, { t: 'arr' }>).items
        : Array.from({ length: Number(plain(op.count!)) }, (_, i) => ({ t: 'num', v: i }) as Val);
      items.forEach((item, index) => {
        out.push({ op: 'comment', text: `Loop, item ${index + 1} of ${items.length}` });
        if (op.over) out.push({ op: 'setVar', name: op.as, value: item });
        out.push({ op: 'setVar', name: 'index', value: { t: 'num', v: index } });
        out.push(...flat(op.body, warn, where, allow));
      });
    } else if (op.op === 'if' || op.op === 'loop') {
      warn(
        `${op.op === 'if' ? 'conditions' : 'loops'} are not supported by ${where}; their steps are listed once`,
      );
      out.push({
        op: 'comment',
        text: `${op.op === 'if' ? 'Condition' : 'Loop'} (not supported by ${where}): steps listed once`,
      });
      out.push(...flat(op.op === 'if' ? op.then : op.body, warn, where, allow));
    } else {
      warn(`${op.op} steps are not supported by ${where}`);
      out.push({ op: 'todo', text: `${op.op} step not exported (${where} runs HTTP requests only)` });
    }
  }
  return out;
}

// ─── k6 ─────────────────────────────────────────────────────────────────────
const K6_HELPERS = `// Helpers (StepForge's checks; a small JSONPath).
function field(obj, path) {
  return path.split('.').reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), obj);
}
function jsonPath(json, path) {
  const keys = path.replace(/^\\$\\.?/, '').replace(/\\[(\\d+)\\]/g, '.$1').split('.').filter(Boolean);
  return keys.reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), json);
}
function body(res) {
  try {
    return res.json();
  } catch (e) {
    return res.body;
  }
}
function pick(res, target) {
  if (target === 'status') return res.status;
  if (target === 'time') return res.timings.duration;
  if (target === 'size') return (res.body || '').length;
  if (target === 'body') return body(res);
  if (target === 'text') return res.body;
  if (target.indexOf('header:') === 0) return res.headers[target.slice(7).replace(/(^|-)([a-z])/g, (m, a, b) => a + b.toUpperCase())];
  if (target.indexOf('$') === 0) return jsonPath(body(res), target);
  return undefined;
}
function compare(actual, op, expected) {
  const same = (a, b) => a === b || String(a) === String(b) || JSON.stringify(a) === JSON.stringify(b);
  switch (op) {
    case 'equals': return same(actual, expected);
    case 'notEquals': return !same(actual, expected);
    case 'contains': return Array.isArray(actual) ? actual.some((x) => same(x, expected)) : String(actual).indexOf(String(expected)) >= 0;
    case 'notContains': return !compare(actual, 'contains', expected);
    case 'matches': return new RegExp(String(expected)).test(String(actual));
    case 'lt': return Number(actual) < Number(expected);
    case 'lte': return Number(actual) <= Number(expected);
    case 'gt': return Number(actual) > Number(expected);
    case 'gte': return Number(actual) >= Number(expected);
    case 'exists': return actual !== undefined && actual !== null;
    case 'notExists': return actual === undefined || actual === null;
    case 'isEmpty': return actual === undefined || actual === null || actual === '' || actual.length === 0;
    case 'isNotEmpty': return !compare(actual, 'isEmpty');
    case 'lengthEquals': return actual != null && actual.length === Number(expected);
    default: return false;
  }
}
const random = {
  email: () => 'sf.' + Date.now().toString(36) + Math.floor(Math.random() * 9000 + 1000) + '@example.test',
  uuid: () => uuidv4(),
  number: () => Math.floor(Math.random() * 1000000),
  digits6: () => String(Math.floor(Math.random() * 1000000)).padStart(6, '0'),
  string: () => Math.random().toString(36).slice(2, 10),
  timestamp: () => Date.now(),
};
const NAMES = ['Ana Lima', 'Ben Okafor', 'Chen Wei', 'Dana Cruz', 'Eli Novak', 'Fatima Khan', 'Gus Berg', 'Hana Sato'];
function fake(kind) {
  const n = NAMES[Math.floor(Math.random() * NAMES.length)];
  switch (kind) {
    case 'name': return n;
    case 'firstName': return n.split(' ')[0];
    case 'lastName': return n.split(' ')[1];
    case 'email': return random.email();
    case 'uuid': return uuidv4();
    case 'number': return random.number();
    case 'phone': return '+1-555-' + String(Math.floor(Math.random() * 9000000 + 1000000)).replace(/(\\d{3})(\\d{4})/, '$1-$2');
    default: return random.string();
  }
}
function secret(name) {
  const v = __ENV[name];
  if (!v) fail('Set the ' + name + ' environment variable (k6 run -e ' + name + '=…)');
  return v;
}`;

function k6Ops(ops: Op[], lines: string[], ind: string): void {
  for (const op of ops) {
    if (op.op === 'comment') lines.push(`${ind}// ${op.text}`);
    else if (op.op === 'todo') lines.push(`${ind}// TODO(StepForge): ${op.text}`);
    else if (op.op === 'setVar') lines.push(`${ind}vars.${op.name} = ${jsVal(op.value, ind)};`);
    else if (op.op === 'gen') lines.push(`${ind}vars.${op.into} = fake(${jsStr(op.kind)});`);
    else if (op.op === 'wait') lines.push(`${ind}sleep(${op.ms / 1000});`);
    else if (op.op === 'log') lines.push(`${ind}console.log(${jsVal(op.message)});`);
    else if (op.op === 'check')
      lines.push(
        `${ind}check(null, { ${jsStr(op.message)}: () => compare(${jsVal(op.actual)}, ${jsStr(op.operator)}, ${jsVal(op.expected)}) });`,
      );
    else if (op.op === 'apiExtract') {
      const target =
        op.from === 'status'
          ? 'status'
          : op.from === 'header'
            ? `header:${op.name ?? ''}`
            : (op.path ?? 'body');
      lines.push(`${ind}vars.${op.into} = pick(last, ${jsStr(target)});`);
    } else if (op.op === 'if') {
      lines.push(`${ind}if (compare(${jsVal(op.value)}, ${jsStr(op.operator)}, ${jsVal(op.expected)})) {`);
      k6Ops(op.then, lines, `${ind}  `);
      if (op.else.length) {
        lines.push(`${ind}} else {`);
        k6Ops(op.else, lines, `${ind}  `);
      }
      lines.push(`${ind}}`);
    } else if (op.op === 'loop') {
      lines.push(
        op.over
          ? `${ind}(${jsVal(op.over)}).forEach((item, index) => {\n${ind}  vars.${op.as} = item;\n${ind}  vars.index = index;`
          : `${ind}for (let index = 0; index < Number(${jsVal(op.count!)}); index++) {\n${ind}  vars.index = index;`,
      );
      k6Ops(op.body, lines, `${ind}  `);
      lines.push(op.over ? `${ind}});` : `${ind}}`);
    } else if (op.op === 'api') {
      const headers: string[] = op.headers.map(([k, v]) => `${jsKey(k)}: ${jsVal(v)}`);
      const query = op.query.map(([k, v]) => `${encodeURIComponent(k)}=\${encodeURIComponent(${jsVal(v)})}`);
      if (op.auth?.type === 'bearer') headers.push(`Authorization: \`Bearer \${${jsVal(op.auth.token)}}\``);
      if (op.auth?.type === 'basic')
        headers.push(
          `Authorization: \`Basic \${encoding.b64encode(${jsVal(op.auth.username)} + ':' + ${jsVal(op.auth.password)})}\``,
        );
      if (op.auth?.type === 'apiKey') {
        if (op.auth.in === 'query')
          query.push(`${encodeURIComponent(op.auth.name)}=\${encodeURIComponent(${jsVal(op.auth.value)})}`);
        else headers.push(`${jsKey(op.auth.name)}: ${jsVal(op.auth.value)}`);
      }
      if (op.auth?.type === 'cookie') headers.push(`Cookie: \`${op.auth.name}=\${${jsVal(op.auth.value)}}\``);
      let body = 'null';
      if (op.body && op.bodyType !== 'none') {
        if (op.bodyType === 'json') {
          headers.push("'Content-Type': 'application/json'");
          body = `JSON.stringify(${jsVal(op.body, ind)})`;
        } else body = jsVal(op.body, ind);
      }
      const urlExpr = `url(${jsVal(op.url)})${query.length ? ` + \`?${query.join('&')}\`` : ''}`;
      lines.push(
        `${ind}last = http.request(${jsStr(op.method)}, ${urlExpr}, ${body}, { headers: { ${headers.join(', ')} }, tags: { name: ${jsStr(op.label)} } });`,
      );
      if (op.asserts.length)
        lines.push(
          `${ind}check(last, {`,
          ...op.asserts.map(
            (a) =>
              `${ind}  ${jsStr(`${op.label}: ${a.target} ${a.operator}${a.expected.t !== 'null' ? ` ${JSON.stringify(plain(a.expected))}` : ''}`)}: (r) => compare(pick(r, ${jsStr(a.target)}), ${jsStr(a.operator)}, ${jsVal(a.expected)}),`,
          ),
          `${ind}});`,
        );
      if (op.into) lines.push(`${ind}vars.${op.into} = body(last);`);
    }
  }
}

export function generateK6(plan: Plan, o: CodegenOptions): GeneratedProject {
  const warnings: Warning[] = [...plan.warnings];
  const lines: string[] = [];
  const tests = plan.tests.filter(isApi);
  for (const t of plan.tests) if (!isApi(t)) warnings.push({ scenario: t.scenario.name, message: SKIP_UI });
  for (const t of tests) {
    const warn = (message: string) => warnings.push({ scenario: t.scenario.name, message });
    const ops = flat(t.ops, warn, 'k6', [
      'api',
      'apiExtract',
      'setVar',
      'gen',
      'wait',
      'log',
      'check',
      'if',
      'loop',
    ]);
    const cases = casesOf(t.scenario);
    lines.push(`  // ${[...t.scenario.modulePath, t.scenario.name].join(' › ')} (${t.scenario.priority})`);
    lines.push(`  for (const data of ${jsJson(cases.map((c) => c.data))}) {`);
    lines.push(`    group(${jsStr(t.scenario.name)}, () => {`);
    lines.push('      const vars = {};', '      let last;');
    k6Ops(ops, lines, '      ');
    lines.push('    });', '  }');
  }
  const { input } = plan;
  const script = [
    ...headerLines(input).map((l) => `// ${l}`),
    `// Functional checks of ${tests.length} API scenario${tests.length === 1 ? '' : 's'}: one virtual user, one iteration.`,
    '// Raise vus/duration in options for a load test (only against systems you own or may test).',
    "import http from 'k6/http';",
    "import encoding from 'k6/encoding';",
    "import { check, fail, group, sleep } from 'k6';",
    "import { uuidv4 } from 'https://jslib.k6.io/k6-utils/1.4.0/index.js';",
    '',
    'export const options = {',
    '  vus: 1,',
    '  iterations: 1,',
    "  thresholds: { checks: ['rate==1.0'] },",
    '};',
    '',
    'const env = {',
    `  baseUrl: __ENV.BASE_URL || ${jsStr(input.environment.baseUrl)},`,
    ...plan.variables.map(
      (v) => `  ${jsKey(v)}: __ENV.${envName(v)} || ${jsStr(input.environment.variables[v] ?? '')},`,
    ),
    '};',
    'const runId = Date.now().toString(36);',
    "const url = (path) => (/^https?:\\/\\//.test(path) ? path : env.baseUrl.replace(/\\/$/, '') + '/' + path.replace(/^\\//, ''));",
    '',
    K6_HELPERS,
    '',
    'export default function () {',
    ...lines,
    '}',
    '',
  ].join('\n');
  const files: Record<string, string> = {
    'script.js': script,
    '.env.example': envExample(plan),
    ...ciFiles(plan, 'k6', o.ci),
  };
  files['README.md'] = readme(
    { ...plan, warnings },
    {
      title: 'k6 API checks',
      install: ['# k6: https://grafana.com/docs/k6/latest/set-up/install-k6/'],
      run: [`k6 run ${plan.secrets.map((s) => `-e ${envName(s)}=… `).join('')}script.js`],
      layout: [
        '`script.js` — every API scenario as a k6 group, test cases as data, StepForge assertions as checks',
      ],
      notes: [
        'The script fails (non-zero exit) when any check fails (`checks: rate==1.0`).',
        'For a load test, raise `vus`/`duration` in `options` — only against systems you own or are authorised to test.',
        `Exported on ${day(input)}.`,
      ],
    },
  );
  return { target: 'k6', files, warnings, run: 'k6 run script.js' };
}

// ─── Postman ────────────────────────────────────────────────────────────────
/** Postman understands {{name}} variables natively; StepForge placeholders map onto them. */
function pmRef(r: Ref): string {
  switch (r.scope) {
    case 'baseUrl':
      return '{{baseUrl}}';
    case 'env':
    case 'secret':
    case 'data':
    case 'vars':
      return `{{${r.name}}}`;
    case 'run':
      return '{{$timestamp}}';
    case 'random':
      return (
        {
          email: '{{$randomEmail}}',
          uuid: '{{$guid}}',
          number: '{{$randomInt}}',
          timestamp: '{{$timestamp}}',
        }[r.name] ?? '{{$randomUUID}}'
      );
  }
}
const pmText = (v: Val): string =>
  v.t === 'str'
    ? v.parts.map((p: Part) => (typeof p === 'string' ? p : pmRef(p))).join('')
    : v.t === 'ref'
      ? pmRef(v.ref)
      : String(plain(v) ?? '');
function pmJson(v: Val): unknown {
  if (v.t === 'obj') return Object.fromEntries(v.entries.map(([k, x]) => [k, pmJson(x)]));
  if (v.t === 'arr') return v.items.map(pmJson);
  if (v.t === 'str' || v.t === 'ref') return pmText(v);
  return plain(v);
}

/** Generated data through Postman's dynamic variables. */
const PM_FAKE: Record<string, string> = {
  name: '{{$randomFullName}}',
  firstName: '{{$randomFirstName}}',
  lastName: '{{$randomLastName}}',
  email: '{{$randomEmail}}',
  phone: '{{$randomPhoneNumber}}',
  uuid: '{{$randomUUID}}',
  number: '{{$randomInt}}',
  word: '{{$randomWord}}',
  sentence: '{{$randomLoremSentence}}',
  address: '{{$randomStreetAddress}}',
  company: '{{$randomCompanyName}}',
};

const PM_HELPERS = [
  'const jp = (json, path) => path.replace(/^\\$\\.?/, "").replace(/\\[(\\d+)\\]/g, ".$1").split(".").filter(Boolean).reduce((o, k) => (o && typeof o === "object" ? o[k] : undefined), json);',
  'let body; try { body = pm.response.json(); } catch (e) { body = pm.response.text(); }',
  '/** Saves a value as variables (objects flattened: session.token). */',
  'const save = (name, value) => { if (value && typeof value === "object") { pm.collectionVariables.set(name, JSON.stringify(value)); Object.entries(value).forEach(([k, v]) => save(`${name}.${k}`, v)); } else pm.collectionVariables.set(name, value); };',
];

function pmAssert(target: string, operator: string, expected: Val): string {
  const actual =
    target === 'status'
      ? 'pm.response.code'
      : target === 'time'
        ? 'pm.response.responseTime'
        : target === 'body'
          ? 'body'
          : target === 'text'
            ? 'pm.response.text()'
            : target.startsWith('header:')
              ? `pm.response.headers.get(${JSON.stringify(target.slice(7))})`
              : `jp(body, ${JSON.stringify(target)})`;
  const raw = pmJson(expected);
  // Inside scripts {{…}} is not replaced automatically.
  const e =
    typeof raw === 'string' && raw.includes('{{')
      ? `pm.variables.replaceIn(${JSON.stringify(raw)})`
      : JSON.stringify(raw);
  const expr: Record<string, string> = {
    equals: `pm.expect(String(${actual})).to.eql(String(${e}))`,
    notEquals: `pm.expect(String(${actual})).to.not.eql(String(${e}))`,
    contains: `pm.expect(${actual}).to.include(${e})`,
    notContains: `pm.expect(${actual}).to.not.include(${e})`,
    matches: `pm.expect(String(${actual})).to.match(new RegExp(${e}))`,
    lt: `pm.expect(Number(${actual})).to.be.below(Number(${e}))`,
    lte: `pm.expect(Number(${actual})).to.be.at.most(Number(${e}))`,
    gt: `pm.expect(Number(${actual})).to.be.above(Number(${e}))`,
    gte: `pm.expect(Number(${actual})).to.be.at.least(Number(${e}))`,
    exists: `pm.expect(${actual}).to.exist`,
    notExists: `pm.expect(${actual}).to.not.exist`,
    isEmpty: `pm.expect(${actual}).to.be.empty`,
    isNotEmpty: `pm.expect(${actual}).to.not.be.empty`,
    lengthEquals: `pm.expect(${actual}).to.have.lengthOf(Number(${e}))`,
  };
  return expr[operator] ?? `pm.expect.fail(${JSON.stringify(`operator ${operator} is not exported`)})`;
}

export function generatePostman(plan: Plan): GeneratedProject {
  const warnings: Warning[] = [...plan.warnings];
  const { input } = plan;
  const folders = new Map<string, unknown[]>();
  const dataFiles: Record<string, string> = {};
  for (const t of plan.tests) {
    if (!isApi(t)) {
      warnings.push({ scenario: t.scenario.name, message: SKIP_UI });
      continue;
    }
    const warn = (message: string) => warnings.push({ scenario: t.scenario.name, message });
    const ops = flat(t.ops, warn, 'Postman', ['api', 'apiExtract', 'setVar', 'gen']);
    const items: unknown[] = [];
    let lastLabel = '';
    for (const op of ops) {
      if (op.op === 'apiExtract') {
        const target =
          op.from === 'status'
            ? 'status'
            : op.from === 'header'
              ? `header:${op.name ?? ''}`
              : (op.path ?? '$');
        const last = items.at(-1) as { event: { script: { exec: string[] } }[] } | undefined;
        last?.event[0]!.script.exec.push(
          `save(${JSON.stringify(op.into)}, ${target === 'status' ? 'pm.response.code' : target.startsWith('header:') ? `pm.response.headers.get(${JSON.stringify(target.slice(7))})` : `jp(body, ${JSON.stringify(target)})`});`,
        );
        if (!last) warn(`"${op.into}" is read before any request`);
        continue;
      }
      if (op.op === 'gen') {
        const dyn = PM_FAKE[op.kind];
        if (!dyn) warn(`generated "${op.kind}" data has no Postman equivalent; a random UUID is used`);
        lastLabel += `pm.collectionVariables.set(${JSON.stringify(op.into)}, pm.variables.replaceIn(${JSON.stringify(dyn ?? '{{$randomUUID}}')}));`;
        continue;
      }
      if (op.op === 'setVar') {
        lastLabel += `pm.collectionVariables.set(${JSON.stringify(op.name)}, pm.variables.replaceIn(${JSON.stringify(typeof pmJson(op.value) === 'string' ? pmJson(op.value) : JSON.stringify(pmJson(op.value)))}));`;
        continue;
      }
      if (op.op !== 'api') continue;
      const headers = op.headers.map(([k, v]) => ({ key: k, value: pmText(v) }));
      let auth: unknown;
      if (op.auth?.type === 'bearer')
        auth = { type: 'bearer', bearer: [{ key: 'token', value: pmText(op.auth.token), type: 'string' }] };
      if (op.auth?.type === 'basic')
        auth = {
          type: 'basic',
          basic: [
            { key: 'username', value: pmText(op.auth.username) },
            { key: 'password', value: pmText(op.auth.password) },
          ],
        };
      if (op.auth?.type === 'apiKey')
        auth = {
          type: 'apikey',
          apikey: [
            { key: 'key', value: op.auth.name },
            { key: 'value', value: pmText(op.auth.value) },
            { key: 'in', value: op.auth.in },
          ],
        };
      if (op.auth?.type === 'cookie')
        headers.push({ key: 'Cookie', value: `${op.auth.name}=${pmText(op.auth.value)}` });
      const rawUrl = pmText(op.url);
      const query = op.query.map(([k, v]) => ({ key: k, value: pmText(v) }));
      // A plain string URL (v2.1 allows it); Postman parses host, path and query itself.
      const url = `${rawUrl.startsWith('/') ? '{{baseUrl}}' : ''}${rawUrl}${query.length ? `?${query.map((q) => `${q.key}=${q.value}`).join('&')}` : ''}`;
      const body =
        op.body && op.bodyType !== 'none'
          ? op.bodyType === 'json'
            ? {
                mode: 'raw',
                raw: JSON.stringify(pmJson(op.body), null, 2),
                options: { raw: { language: 'json' } },
              }
            : op.bodyType === 'form'
              ? {
                  mode: 'urlencoded',
                  urlencoded: Object.entries(pmJson(op.body) as Record<string, unknown>).map(([k, v]) => ({
                    key: k,
                    value: String(v),
                  })),
                }
              : op.bodyType === 'multipart'
                ? {
                    mode: 'formdata',
                    formdata: Object.entries(pmJson(op.body) as Record<string, unknown>).map(([k, v]) => ({
                      key: k,
                      value: String(v),
                    })),
                  }
                : { mode: 'raw', raw: pmText(op.body) }
          : undefined;
      const tests = [
        ...PM_HELPERS,
        ...op.asserts.map(
          (a) =>
            `pm.test(${JSON.stringify(`${a.target} ${a.operator}${a.expected.t !== 'null' ? ` ${JSON.stringify(pmJson(a.expected))}` : ''}`)}, () => ${pmAssert(a.target, a.operator, a.expected)});`,
        ),
        ...(op.into ? [`save(${JSON.stringify(op.into)}, body);`] : []),
      ];
      items.push({
        name: op.label,
        event: [
          { listen: 'test', script: { type: 'text/javascript', exec: tests } },
          ...(lastLabel
            ? [{ listen: 'prerequest', script: { type: 'text/javascript', exec: [lastLabel] } }]
            : []),
        ],
        request: {
          method: op.method,
          header: headers,
          url,
          ...(body && { body }),
          ...(auth ? { auth } : {}),
        },
      });
      lastLabel = '';
    }
    const folderName = [...t.scenario.modulePath].join(' › ') || input.application.name;
    folders.set(folderName, [
      ...(folders.get(folderName) ?? []),
      {
        name: t.scenario.name,
        description: `${t.scenario.priority}${t.scenario.tags.length ? ` · ${t.scenario.tags.map((x) => `#${x}`).join(' ')}` : ''}`,
        item: items,
      },
    ]);
    if (t.scenario.testCases.length) {
      dataFiles[`data/${kebab(t.scenario.name)}.json`] = `${JSON.stringify(
        t.scenario.testCases.map((c) => c.data),
        null,
        2,
      )}\n`;
      warn(
        `its ${t.scenario.testCases.length} test case(s) are in data/${kebab(t.scenario.name)}.json; run the folder with that file as iteration data`,
      );
    }
  }
  const variables = [
    { key: 'baseUrl', value: input.environment.baseUrl },
    ...plan.variables.map((v) => ({ key: v, value: input.environment.variables[v] ?? '' })),
    ...plan.secrets.map((s) => ({
      key: s,
      value: '',
      type: 'secret',
      description: 'Secret: fill in locally, never commit',
    })),
  ];
  const collection = {
    info: {
      name: `${input.application.name} — StepForge export`,
      description: `${CREDIT} on ${day(input)} from the ${input.environment.name} environment. Secrets are empty: fill in the collection variables.`,
      schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
    },
    item: [...folders].map(([name, item]) => ({ name, item })),
    variable: variables,
  };
  const name = `${kebab(input.application.slug || input.application.name)}.postman_collection.json`;
  const files: Record<string, string> = { [name]: `${JSON.stringify(collection, null, 2)}\n`, ...dataFiles };
  files['README.md'] = readme(
    { ...plan, warnings },
    {
      title: 'Postman collection',
      install: ['# Postman: File → Import → ' + name, '# or the CLI: npm install -g newman'],
      run: [`newman run ${name}${plan.secrets.map((s) => ` --env-var ${s}=…`).join('')}`],
      layout: [
        `\`${name}\` — folders per module, one sub-folder per scenario, tests per assertion`,
        ...(Object.keys(dataFiles).length ? ['`data/` — test-case data (iteration data files)'] : []),
      ],
      notes: [
        'Captured values are saved as collection variables; objects are flattened (`{{session.token}}`).',
        `Exported on ${day(input)}.`,
      ],
    },
  );
  return { target: 'postman', files, warnings, run: `newman run ${name}` };
}

// ─── cURL ───────────────────────────────────────────────────────────────────
function shVar(name: string) {
  return envName(name);
}
/** A value as a double-quoted shell word; captured values are read back with jq. */
function shText(v: Val): string {
  const ref = (r: Ref): string => {
    switch (r.scope) {
      case 'baseUrl':
        return '${BASE_URL}';
      case 'env':
      case 'secret':
        return `\${${shVar(r.name)}}`;
      case 'data':
        return `\${DATA_${shVar(r.name)}}`;
      case 'vars': {
        const [head, ...rest] = r.name.split('.');
        return `$(value ${snake(head!)}${rest.length ? ` '.${rest.join('.')}'` : ''})`;
      }
      case 'run':
        return '${RUN_ID}';
      case 'random':
        return r.name === 'uuid'
          ? '$(uuidgen)'
          : r.name === 'email'
            ? 'sf.$(date +%s)${RANDOM}@example.test'
            : '${RANDOM}';
    }
  };
  const esc = (s: string) => s.replace(/(["\\$`])/g, '\\$1');
  if (v.t === 'str') return `"${v.parts.map((p) => (typeof p === 'string' ? esc(p) : ref(p))).join('')}"`;
  if (v.t === 'ref') return `"${ref(v.ref)}"`;
  if (v.t === 'obj' || v.t === 'arr') return jqBuild(v);
  return `"${String(plain(v))}"`;
}
/** JSON bodies are built with jq so captured values and secrets are escaped correctly. */
function jqBuild(v: Val): string {
  const args: string[] = [];
  const expr = (x: Val): string => {
    if (x.t === 'obj') return `{${x.entries.map(([k, y]) => `${JSON.stringify(k)}: ${expr(y)}`).join(', ')}}`;
    if (x.t === 'arr') return `[${x.items.map(expr).join(', ')}]`;
    if (x.t === 'str' || x.t === 'ref') {
      if (x.t === 'str' && x.parts.every((p) => typeof p === 'string'))
        return JSON.stringify(x.parts.join(''));
      const name = `a${args.length}`;
      args.push(`--arg ${name} ${shText(x)}`);
      return `$${name}`;
    }
    return JSON.stringify(plain(x));
  };
  const e = expr(v);
  return `"$(jq -n ${args.join(' ')} '${e.replace(/'/g, "'\\''")}')"`;
}

/** Bash's =~ is POSIX ERE: no \\d, \\w or \\s shorthands. */
const bashRegex = (word: string) =>
  word.replace(/\\\\d/g, '[0-9]').replace(/\\\\w/g, '[A-Za-z0-9_]').replace(/\\\\s/g, '[[:space:]]');

export function generateCurl(plan: Plan): GeneratedProject {
  const warnings: Warning[] = [...plan.warnings];
  const { input } = plan;
  const lines: string[] = [];
  const dataKeys = new Set<string>();
  for (const t of plan.tests) {
    if (!isApi(t)) {
      warnings.push({ scenario: t.scenario.name, message: SKIP_UI });
      continue;
    }
    const warn = (message: string) => warnings.push({ scenario: t.scenario.name, message });
    const ops = flat(t.ops, warn, 'the cURL script', ['api', 'apiExtract', 'setVar', 'gen']);
    const first = t.scenario.testCases[0];
    if (t.scenario.testCases.length > 1) warn('only the first test case is used by the cURL script');
    lines.push(
      '',
      `# ── ${[...t.scenario.modulePath, t.scenario.name].join(' › ')} (${t.scenario.priority})`,
      `scenario ${JSON.stringify(t.scenario.name)}`,
    );
    if (first)
      for (const [k, v] of Object.entries(first.data)) {
        dataKeys.add(k);
        lines.push(`DATA_${shVar(k)}=${shText({ t: 'str', parts: [String(v)] })}`);
      }
    for (const op of ops) {
      if (op.op === 'comment') lines.push(`# ${op.text}`);
      else if (op.op === 'todo') lines.push(`# TODO(StepForge): ${op.text}`);
      else if (op.op === 'gen')
        lines.push(`save ${snake(op.into)} "$(jq -n --arg v "$(fake ${op.kind})" '$v')"`);
      else if (op.op === 'setVar')
        lines.push(
          `save ${snake(op.name)} ${op.value.t === 'obj' || op.value.t === 'arr' ? shText(op.value) : `"$(jq -n --arg v ${shText(op.value)} '$v')"`}`,
        );
      else if (op.op === 'apiExtract') {
        const path = op.from === 'status' ? null : op.from === 'header' ? null : (op.path ?? '$');
        if (path === null) {
          warn(`extracting the ${op.from} is not supported by the cURL script`);
          lines.push(`# TODO(StepForge): extract the ${op.from} (not supported here)`);
        } else lines.push(`save ${snake(op.into)} "$(jq '${path.replace(/^\$/, '') || '.'}' "$RESPONSE")"`);
      } else if (op.op === 'api') {
        const args = [`-X ${op.method}`];
        for (const [k, v] of op.headers)
          args.push(
            `-H ${shText({ t: 'str', parts: [`${k}: `, ...(v.t === 'str' ? v.parts : v.t === 'ref' ? [v.ref] : [String(plain(v))])] })}`,
          );
        if (op.auth?.type === 'bearer')
          args.push(
            `-H ${shText({ t: 'str', parts: ['Authorization: Bearer ', ...(op.auth.token.t === 'str' ? op.auth.token.parts : op.auth.token.t === 'ref' ? [op.auth.token.ref] : [])] })}`,
          );
        if (op.auth?.type === 'basic')
          args.push(
            `-u ${shText({ t: 'str', parts: [...(op.auth.username.t === 'str' ? op.auth.username.parts : op.auth.username.t === 'ref' ? [op.auth.username.ref] : []), ':', ...(op.auth.password.t === 'str' ? op.auth.password.parts : op.auth.password.t === 'ref' ? [op.auth.password.ref] : [])] })}`,
          );
        if (op.auth?.type === 'apiKey' && op.auth.in === 'header')
          args.push(
            `-H ${shText({ t: 'str', parts: [`${op.auth.name}: `, ...(op.auth.value.t === 'str' ? op.auth.value.parts : op.auth.value.t === 'ref' ? [op.auth.value.ref] : [])] })}`,
          );
        if (op.auth?.type === 'cookie')
          args.push(
            `--cookie ${shText({ t: 'str', parts: [`${op.auth.name}=`, ...(op.auth.value.t === 'str' ? op.auth.value.parts : op.auth.value.t === 'ref' ? [op.auth.value.ref] : [])] })}`,
          );
        const query = [
          ...op.query,
          ...(op.auth?.type === 'apiKey' && op.auth.in === 'query'
            ? [[op.auth.name, op.auth.value] as [string, Val]]
            : []),
        ];
        // --url-query (curl 7.87+) adds encoded query parameters without turning the body into a query.
        for (const [k, v] of query)
          args.push(
            `--url-query ${shText({ t: 'str', parts: [`${k}=`, ...(v.t === 'str' ? v.parts : v.t === 'ref' ? [v.ref] : [String(plain(v))])] })}`,
          );
        if (op.body && op.bodyType !== 'none') {
          if (op.bodyType === 'json')
            args.push('-H "Content-Type: application/json"', `--data-binary ${shText(op.body)}`);
          else if (op.bodyType === 'form' && op.body.t === 'obj')
            for (const [k, v] of op.body.entries)
              args.push(
                `--data-urlencode ${shText({ t: 'str', parts: [`${k}=`, ...(v.t === 'str' ? v.parts : v.t === 'ref' ? [v.ref] : [String(plain(v))])] })}`,
              );
          else if (op.bodyType === 'multipart' && op.body.t === 'obj')
            for (const [k, v] of op.body.entries)
              args.push(
                `-F ${shText({ t: 'str', parts: [`${k}=`, ...(v.t === 'str' ? v.parts : v.t === 'ref' ? [v.ref] : [String(plain(v))])] })}`,
              );
          else args.push(`--data-binary ${shText(op.body)}`);
        }
        const url =
          op.url.t === 'str' && typeof op.url.parts[0] === 'string' && op.url.parts[0].startsWith('/')
            ? { ...op.url, parts: [{ scope: 'baseUrl', name: 'baseUrl' } as Ref, ...op.url.parts] }
            : op.url;
        lines.push(`# ${op.label}`, `request ${args.join(' \\\n  ')} \\\n  ${shText(url)}`);
        for (const a of op.asserts) {
          if (a.target === 'status' && a.operator === 'equals')
            lines.push(`expect_status ${String(plain(a.expected))}`);
          else if (
            a.target.startsWith('$') &&
            ['equals', 'exists', 'notExists', 'matches', 'contains'].includes(a.operator)
          ) {
            const path = a.target.replace(/^\$/, '') || '.';
            const e =
              a.expected.t === 'null'
                ? ''
                : ` ${shText(a.expected.t === 'num' || a.expected.t === 'bool' ? { t: 'str', parts: [String(a.expected.v)] } : a.expected)}`;
            lines.push(`expect_json '${path}' ${a.operator}${a.operator === 'matches' ? bashRegex(e) : e}`);
          } else {
            warn(`the "${a.target} ${a.operator}" check is not exported to the cURL script`);
            lines.push(
              `# TODO(StepForge): check ${a.target} ${a.operator} (not supported in the cURL script)`,
            );
          }
        }
        if (op.into) lines.push(`save ${snake(op.into)} "$(cat "$RESPONSE")"`);
      }
    }
  }
  const script = [
    '#!/usr/bin/env bash',
    ...headerLines(input).map((l) => `# ${l}`),
    '# The API scenarios as cURL requests, with their checks. Needs bash, curl 7.87+ and jq.',
    'set -euo pipefail',
    '',
    `BASE_URL="\${BASE_URL:-${input.environment.baseUrl}}"`,
    ...plan.variables.map(
      (v) => `${shVar(v)}="\${${shVar(v)}:-${(input.environment.variables[v] ?? '').replace(/"/g, '\\"')}}"`,
    ),
    ...plan.secrets.map((s) => `${shVar(s)}="\${${shVar(s)}:?Set ${shVar(s)} (a secret; see .env.example)}"`),
    'RUN_ID="$(date +%s)"',
    'WORK="$(mktemp -d)"; trap \'rm -rf "$WORK"\' EXIT',
    'RESPONSE="$WORK/response"',
    'FAILED=0',
    '',
    '# Captured values are kept as JSON files and read back with jq.',
    'save() { printf \'%s\' "$2" > "$WORK/$1.json"; }',
    'value() { jq -r "${2:-.}" "$WORK/$1.json"; }',
    'scenario() { echo; echo "▶ $1"; }',
    '# Simple generated data, like StepForge\'s "Generate data" step.',
    'fake() {',
    '  local names=("Ana Lima" "Ben Okafor" "Chen Wei" "Dana Cruz" "Eli Novak" "Fatima Khan" "Gus Berg" "Hana Sato")',
    '  case "$1" in',
    '    name) echo "${names[RANDOM % ${#names[@]}]}" ;;',
    '    firstName) echo "${names[RANDOM % ${#names[@]}]% *}" ;;',
    '    lastName) echo "${names[RANDOM % ${#names[@]}]#* }" ;;',
    '    email) echo "sf.$(date +%s)${RANDOM}@example.test" ;;',
    '    uuid) uuidgen | tr "[:upper:]" "[:lower:]" ;;',
    '    phone) printf "+1-555-%03d-%04d\\n" $((RANDOM % 1000)) $((RANDOM % 10000)) ;;',
    '    number) echo $((RANDOM % 1001)) ;;',
    '    *) echo "$(date +%s)${RANDOM}" ;;',
    '  esac',
    '}',
    'request() { STATUS="$(curl -sS -o "$RESPONSE" -w \'%{http_code}\' "$@")"; }',
    'pass() { echo "  ✓ $1"; }',
    'fail() { echo "  ✗ $1"; FAILED=1; }',
    'expect_status() { [ "$STATUS" = "$1" ] && pass "status $1" || fail "status $1 (got $STATUS)"; }',
    'expect_json() {',
    '  local actual; actual="$(jq -r "$1 // empty" "$RESPONSE" 2>/dev/null || true)"',
    '  case "$2" in',
    '    exists) [ -n "$actual" ] && pass "$1 exists" || fail "$1 exists" ;;',
    '    notExists) [ -z "$actual" ] && pass "$1 does not exist" || fail "$1 does not exist (got $actual)" ;;',
    '    equals) [ "$actual" = "$3" ] && pass "$1 = $3" || fail "$1 = $3 (got $actual)" ;;',
    '    contains) [[ "$actual" == *"$3"* ]] && pass "$1 contains $3" || fail "$1 contains $3 (got $actual)" ;;',
    '    matches) [[ "$actual" =~ $3 ]] && pass "$1 matches $3" || fail "$1 matches $3 (got $actual)" ;;',
    '  esac',
    '}',
    ...lines,
    '',
    'echo',
    '[ "$FAILED" = 0 ] && echo "All checks passed" || { echo "Some checks failed"; exit 1; }',
    '',
  ].join('\n');
  const files: Record<string, string> = { 'requests.sh': script, '.env.example': envExample(plan) };
  files['README.md'] = readme(
    { ...plan, warnings },
    {
      title: 'cURL script',
      install: ['# bash, curl and jq (Windows: Git Bash or WSL)'],
      run: ['set -a; . ./.env; set +a', 'bash requests.sh'],
      layout: [
        '`requests.sh` — each API request with its status and JSON checks; exits 1 when a check fails',
      ],
      notes: [
        ...(dataKeys.size
          ? ['Test-case data is set as DATA_* variables at the top of each scenario (first test case).']
          : []),
        `Exported on ${day(input)}.`,
      ],
    },
  );
  return { target: 'curl', files, warnings, run: 'bash requests.sh' };
}
