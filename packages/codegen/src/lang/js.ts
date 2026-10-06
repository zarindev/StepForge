import type { Ref, Val } from '../values.ts';
import { envName } from '../values.ts';

/** JavaScript/TypeScript rendering of values (shared by the Playwright and Cypress generators). */
export const jsStr = (s: string) =>
  `'${s
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/[\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16)}`)}'`;

const IDENT = /^[A-Za-z_$][\w$]*$/;
export const jsKey = (k: string) => (IDENT.test(k) ? k : jsStr(k));
const member = (obj: string, k: string) => (IDENT.test(k) ? `${obj}.${k}` : `${obj}[${jsStr(k)}]`);

const RANDOM = new Set(['email', 'uuid', 'number', 'digits6', 'string', 'timestamp']);

export function jsRef(r: Ref): string {
  switch (r.scope) {
    case 'baseUrl':
      return 'env.baseUrl';
    case 'env':
      return member('env', r.name);
    case 'secret':
      return `secret(${jsStr(envName(r.name))})`;
    case 'data':
      return r.name.includes('.') ? `field(data, ${jsStr(r.name)})` : member('data', r.name);
    case 'vars':
      return r.name.includes('.') ? `field(vars, ${jsStr(r.name)})` : member('vars', r.name);
    case 'run':
      return 'runId';
    case 'random':
      return `random.${RANDOM.has(r.name) ? r.name : 'string'}()`;
  }
}

const tmpl = (s: string) => s.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');

export function jsVal(v: Val, indent = ''): string {
  switch (v.t) {
    case 'str':
      if (v.parts.every((p) => typeof p === 'string')) return jsStr(v.parts.join(''));
      return `\`${v.parts.map((p) => (typeof p === 'string' ? tmpl(p) : `\${${jsRef(p)}}`)).join('')}\``;
    case 'ref':
      return jsRef(v.ref);
    case 'num':
      return String(v.v);
    case 'bool':
      return String(v.v);
    case 'null':
      return 'null';
    case 'arr':
      return v.items.length ? `[${v.items.map((x) => jsVal(x, indent)).join(', ')}]` : '[]';
    case 'obj': {
      if (!v.entries.length) return '{}';
      const inner = `${indent}  `;
      return `{\n${v.entries.map(([k, x]) => `${inner}${jsKey(k)}: ${jsVal(x, inner)},`).join('\n')}\n${indent}}`;
    }
  }
}

/** A value as a string expression (template literal), e.g. for typing into a field. */
export function jsText(v: Val): string {
  if (v.t === 'str' || v.t === 'ref') {
    const s = jsVal(v);
    // Secrets and environment values are strings already.
    return v.t === 'ref' && !['secret', 'env', 'baseUrl'].includes(v.ref.scope) ? `String(${s})` : s;
  }
  return jsStr(String(v.t === 'num' || v.t === 'bool' ? v.v : ''));
}

/** Plain JSON literal (for test-case data tables). */
export function jsJson(x: unknown, indent = ''): string {
  if (x === null || x === undefined) return 'null';
  if (typeof x === 'string') return jsStr(x);
  if (typeof x === 'number' || typeof x === 'boolean') return String(x);
  if (Array.isArray(x)) return `[${x.map((y) => jsJson(y, indent)).join(', ')}]`;
  const entries = Object.entries(x as Record<string, unknown>);
  if (!entries.length) return '{}';
  return `{ ${entries.map(([k, y]) => `${jsKey(k)}: ${jsJson(y, indent)}`).join(', ')} }`;
}

/** Template literal for multi-line text such as SQL. */
export const jsBlock = (s: string) => (s.includes('\n') ? `\`${tmpl(s)}\`` : jsStr(s));

/** A number: literal when it is one, Number(…) around placeholder values. */
export const jsNum = (v: Val) => (v.t === 'num' ? String(v.v) : `Number(${jsVal(v)})`);
