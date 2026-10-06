import type { Ref, Val } from '../values.ts';
import { envName } from '../values.ts';

/** Java rendering of values (shared by the Selenium and REST Assured generators). */
export const javaStr = (s: string) =>
  `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t')}"`;

const RANDOM = new Set(['email', 'uuid', 'number', 'digits6', 'string', 'timestamp']);

export function javaRef(r: Ref): string {
  switch (r.scope) {
    case 'baseUrl':
      return 'Config.baseUrl()';
    case 'env':
      return `Config.env(${javaStr(r.name)})`;
    case 'secret':
      return `Config.secret(${javaStr(envName(r.name))})`;
    case 'data':
      return r.name.includes('.') ? `field(data, ${javaStr(r.name)})` : `data.get(${javaStr(r.name)})`;
    case 'vars':
      return r.name.includes('.') ? `field(vars, ${javaStr(r.name)})` : `vars.get(${javaStr(r.name)})`;
    case 'run':
      return 'Config.RUN_ID';
    case 'random':
      return `Fake.random(${javaStr(RANDOM.has(r.name) ? r.name : 'string')})`;
  }
}

const isText = (r: Ref) => ['secret', 'env', 'baseUrl', 'run'].includes(r.scope);

/** A value as a Java expression (Object). */
export function javaVal(v: Val): string {
  switch (v.t) {
    case 'str':
      if (v.parts.every((p) => typeof p === 'string')) return javaStr(v.parts.join(''));
      return v.parts
        .map((p) => (typeof p === 'string' ? javaStr(p) : isText(p) ? javaRef(p) : `text(${javaRef(p)})`))
        .join(' + ');
    case 'ref':
      return javaRef(v.ref);
    case 'num':
      return Number.isInteger(v.v) ? (Math.abs(v.v) > 2_147_483_647 ? `${v.v}L` : String(v.v)) : String(v.v);
    case 'bool':
      return String(v.v);
    case 'null':
      return 'null';
    case 'arr':
      return `J.list(${v.items.map(javaVal).join(', ')})`;
    case 'obj':
      return `J.map(${v.entries.map(([k, x]) => `${javaStr(k)}, ${javaVal(x)}`).join(', ')})`;
  }
}

/** A value as a String expression. */
export function javaText(v: Val): string {
  if (v.t === 'str') {
    const s = javaVal(v);
    // A lone non-string part (e.g. "{{vars.x}}" inside text) is already wrapped in text().
    return s;
  }
  if (v.t === 'ref') return isText(v.ref) ? javaRef(v.ref) : `text(${javaRef(v.ref)})`;
  return javaStr(String(v.t === 'num' || v.t === 'bool' ? v.v : ''));
}

export function javaJson(x: unknown): string {
  if (x === null || x === undefined) return 'null';
  if (typeof x === 'string') return javaStr(x);
  if (typeof x === 'number' || typeof x === 'boolean') return String(x);
  if (Array.isArray(x)) return `J.list(${x.map(javaJson).join(', ')})`;
  return `J.map(${Object.entries(x as Record<string, unknown>)
    .map(([k, y]) => `${javaStr(k)}, ${javaJson(y)}`)
    .join(', ')})`;
}

/** Multi-line text such as SQL, as a text block. */
export const javaBlock = (s: string) =>
  s.includes('\n') ? `"""\n${s.replace(/\\/g, '\\\\').replace(/"""/g, '\\"""')}"""` : javaStr(s);

/** An int: literal when it is one, J.toInt(…) around placeholder values. */
export const javaInt = (v: Val) => (v.t === 'num' ? String(v.v) : `J.toInt(${javaVal(v)})`);
