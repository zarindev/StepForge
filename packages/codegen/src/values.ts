/**
 * Values with StepForge placeholders (`{{data.email}}`, `{{secret.password}}`…) parsed into a small tree that each
 * language renders as idiomatic code: config lookups, environment variables, test data, local variables.
 */
export type RefScope = 'baseUrl' | 'env' | 'secret' | 'data' | 'vars' | 'run' | 'random';
export type Ref = { scope: RefScope; name: string };
export type Part = string | Ref;

export type Val =
  | { t: 'str'; parts: Part[] }
  | { t: 'ref'; ref: Ref }
  | { t: 'num'; v: number }
  | { t: 'bool'; v: boolean }
  | { t: 'null' }
  | { t: 'arr'; items: Val[] }
  | { t: 'obj'; entries: [string, Val][] };

const PLACEHOLDER = /\{\{\s*([a-zA-Z]+)\.([^}\s]+)\s*\}\}/g;

function toRef(scope: string, name: string): Ref | null {
  if (scope === 'env' && name === 'baseUrl') return { scope: 'baseUrl', name };
  if (['env', 'secret', 'data', 'vars', 'run', 'random'].includes(scope))
    return { scope: scope as RefScope, name };
  return null;
}

export function parseString(s: string): Val {
  const parts: Part[] = [];
  let last = 0;
  for (const m of s.matchAll(PLACEHOLDER)) {
    const ref = toRef(m[1]!, m[2]!);
    if (!ref) continue;
    if (m.index! > last) parts.push(s.slice(last, m.index));
    parts.push(ref);
    last = m.index! + m[0].length;
  }
  if (last < s.length) parts.push(s.slice(last));
  // A value that is exactly one placeholder keeps its type (as in StepForge itself).
  if (parts.length === 1 && typeof parts[0] !== 'string') return { t: 'ref', ref: parts[0]! };
  return { t: 'str', parts: parts.length ? parts : [''] };
}

export function val(v: unknown): Val {
  if (v === null || v === undefined) return { t: 'null' };
  if (typeof v === 'string') return parseString(v);
  if (typeof v === 'number') return { t: 'num', v };
  if (typeof v === 'boolean') return { t: 'bool', v };
  if (Array.isArray(v)) return { t: 'arr', items: v.map(val) };
  if (typeof v === 'object') return { t: 'obj', entries: Object.entries(v).map(([k, x]) => [k, val(x)]) };
  return { t: 'str', parts: [String(v)] };
}

export const str = (s: string): Val => ({ t: 'str', parts: [s] });

/** True when a value contains no placeholders at all. */
export function isStatic(v: Val): boolean {
  switch (v.t) {
    case 'str':
      return v.parts.every((p) => typeof p === 'string');
    case 'ref':
      return false;
    case 'arr':
      return v.items.every(isStatic);
    case 'obj':
      return v.entries.every(([, x]) => isStatic(x));
    default:
      return true;
  }
}

/** The plain JavaScript value of a static Val (placeholders kept as their {{…}} text). */
export function plain(v: Val): unknown {
  switch (v.t) {
    case 'str':
      return v.parts
        .map((p) => (typeof p === 'string' ? p : `{{${p.scope === 'baseUrl' ? 'env' : p.scope}.${p.name}}}`))
        .join('');
    case 'ref':
      return `{{${v.ref.scope === 'baseUrl' ? 'env' : v.ref.scope}.${v.ref.name}}}`;
    case 'num':
    case 'bool':
      return v.v;
    case 'null':
      return null;
    case 'arr':
      return v.items.map(plain);
    case 'obj':
      return Object.fromEntries(v.entries.map(([k, x]) => [k, plain(x)]));
  }
}

/** Every reference used by a value (to collect env variables, secrets and data fields). */
export function refsOf(v: Val, out: Ref[] = []): Ref[] {
  if (v.t === 'ref') out.push(v.ref);
  else if (v.t === 'str') {
    for (const p of v.parts) if (typeof p !== 'string') out.push(p);
  } else if (v.t === 'arr') {
    for (const x of v.items) refsOf(x, out);
  } else if (v.t === 'obj') {
    for (const [, x] of v.entries) refsOf(x, out);
  }
  return out;
}

// ─── Names ──────────────────────────────────────────────────────────────────
const words = (s: string) =>
  s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);

export const camel = (s: string, fallback = 'item') => {
  const w = words(s);
  if (!w.length) return fallback;
  const out = w
    .map((x, i) => (i ? x[0]!.toUpperCase() + x.slice(1).toLowerCase() : x.toLowerCase()))
    .join('');
  return /^[0-9]/.test(out) ? `_${out}` : out;
};
export const pascal = (s: string, fallback = 'Item') => {
  const c = camel(s, fallback);
  return c.startsWith('_') ? `_${c.slice(1)}` : c[0]!.toUpperCase() + c.slice(1);
};
export const snake = (s: string, fallback = 'item') => {
  const w = words(s).map((x) => x.toLowerCase());
  if (!w.length) return fallback;
  const out = w.join('_');
  return /^[0-9]/.test(out) ? `_${out}` : out;
};
export const kebab = (s: string, fallback = 'item') =>
  snake(s, fallback).replace(/^_/, '').replace(/_/g, '-');
/** Environment variable name for a secret or variable key: apiToken → API_TOKEN. */
export const envName = (s: string) => snake(s).toUpperCase().replace(/^_/, '');

/** Makes names unique within a scope: name, name2, name3… */
export function uniquer() {
  const used = new Map<string, number>();
  return (name: string) => {
    const n = (used.get(name) ?? 0) + 1;
    used.set(name, n);
    return n === 1 ? name : `${name}${n}`;
  };
}
