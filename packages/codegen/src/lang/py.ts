import type { Ref, Val } from '../values.ts';
import { envName } from '../values.ts';

/** Python rendering of values (shared by the Python generators). Double quotes outside, single quotes inside f-strings. */
export const pyStr = (s: string) =>
  `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t')}"`;

const RANDOM = new Set(['email', 'uuid', 'number', 'digits6', 'string', 'timestamp']);
const quoteSingle = (s: string) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

/** `q` is the quote inside the expression: single quotes when it sits in an f-string. */
export function pyRef(r: Ref, q: '"' | "'" = '"'): string {
  const sq = (x: string) => (q === '"' ? pyStr(x) : quoteSingle(x));
  switch (r.scope) {
    case 'baseUrl':
      return q === '"' ? 'env["base_url"]' : "env['base_url']";
    case 'env':
      return `env[${sq(r.name)}]`;
    case 'secret':
      return `secret(${sq(envName(r.name))})`;
    case 'data':
      return r.name.includes('.') ? `field(data, ${sq(r.name)})` : `data.get(${sq(r.name)})`;
    case 'vars':
      return r.name.includes('.') ? `field(vars, ${sq(r.name)})` : `vars.get(${sq(r.name)})`;
    case 'run':
      return 'RUN_ID';
    case 'random':
      return `random_value(${sq(RANDOM.has(r.name) ? r.name : 'string')})`;
  }
}

const fpart = (s: string) =>
  s
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\{/g, '{{')
    .replace(/\}/g, '}}');

export function pyVal(v: Val, indent = ''): string {
  switch (v.t) {
    case 'str':
      if (v.parts.every((p) => typeof p === 'string')) return pyStr(v.parts.join(''));
      return `f"${v.parts.map((p) => (typeof p === 'string' ? fpart(p) : `{text(${pyRef(p, "'")})}`)).join('')}"`;
    case 'ref':
      return pyRef(v.ref);
    case 'num':
      return String(v.v);
    case 'bool':
      return v.v ? 'True' : 'False';
    case 'null':
      return 'None';
    case 'arr':
      return `[${v.items.map((x) => pyVal(x, indent)).join(', ')}]`;
    case 'obj': {
      if (!v.entries.length) return '{}';
      const inner = `${indent}    `;
      return `{\n${v.entries.map(([k, x]) => `${inner}${pyStr(k)}: ${pyVal(x, inner)},`).join('\n')}\n${indent}}`;
    }
  }
}

/** A value as text (typed into fields, used in URLs and headers). */
export function pyText(v: Val): string {
  if (v.t === 'str') return pyVal(v);
  if (v.t === 'ref')
    return ['secret', 'env', 'baseUrl'].includes(v.ref.scope) ? pyRef(v.ref) : `text(${pyRef(v.ref)})`;
  return pyStr(String(v.t === 'num' || v.t === 'bool' ? v.v : ''));
}

export function pyJson(x: unknown): string {
  if (x === null || x === undefined) return 'None';
  if (typeof x === 'string') return pyStr(x);
  if (typeof x === 'boolean') return x ? 'True' : 'False';
  if (typeof x === 'number') return String(x);
  if (Array.isArray(x)) return `[${x.map(pyJson).join(', ')}]`;
  return `{${Object.entries(x as Record<string, unknown>)
    .map(([k, y]) => `${pyStr(k)}: ${pyJson(y)}`)
    .join(', ')}}`;
}

/** Multi-line text such as SQL. */
export const pyBlock = (s: string) =>
  s.includes('\n') ? `"""${s.replace(/\\/g, '\\\\').replace(/"""/g, '\\"\\"\\"')}"""` : pyStr(s);

/** An integer: literal when it is one, int(…) around placeholder values. */
export const pyInt = (v: Val) => (v.t === 'num' ? String(v.v) : `int(${pyVal(v)})`);
