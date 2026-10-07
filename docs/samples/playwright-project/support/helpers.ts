// Runtime helpers for tests exported by StepForge (by Md Zarin Tasnim). Same rules as StepForge's own checks.
import { faker } from '@faker-js/faker';

/** A unique id for this test run, like StepForge's {{run.id}}. */
export const runId = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;

const lengthOf = (v: unknown): number | undefined =>
  typeof v === 'string' || Array.isArray(v)
    ? v.length
    : v && typeof v === 'object'
      ? Object.keys(v).length
      : undefined;

function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  // "200" equals 200: values read from the page are always strings.
  if ((typeof a === 'number' && typeof b === 'string') || (typeof a === 'string' && typeof b === 'number'))
    return String(a) === String(b);
  return JSON.stringify(a) === JSON.stringify(b);
}

function range(e: unknown): { min?: number; max?: number } {
  const n = (v: unknown) => (v === undefined || v === null || v === '' ? undefined : Number(v));
  if (Array.isArray(e)) return { min: n(e[0]), max: n(e[1]) };
  if (e && typeof e === 'object')
    return { min: n((e as { min?: unknown }).min), max: n((e as { max?: unknown }).max) };
  const m = /^\s*(-?[\d.]*)\s*\.\.\s*(-?[\d.]*)\s*$/.exec(String(e ?? ''));
  return m ? { min: n(m[1]), max: n(m[2]) } : {};
}

const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : [v]);
const empty = (v: unknown) => v === '' || v === null || v === undefined || lengthOf(v) === 0;

/** Compares a value with one of StepForge's operators (equals, contains, gt, matches, inRange…). */
export function compare(actual: unknown, operator: string, expected?: unknown): boolean {
  switch (operator) {
    case 'equals':
      return same(actual, expected);
    case 'notEquals':
      return !same(actual, expected);
    case 'contains':
      return Array.isArray(actual)
        ? actual.some((x) => same(x, expected))
        : String(actual ?? '').includes(String(expected));
    case 'notContains':
      return Array.isArray(actual)
        ? !actual.some((x) => same(x, expected))
        : !String(actual ?? '').includes(String(expected));
    case 'matches':
      return new RegExp(String(expected)).test(String(actual ?? ''));
    case 'lt':
      return Number(actual) < Number(expected);
    case 'lte':
      return Number(actual) <= Number(expected);
    case 'gt':
      return Number(actual) > Number(expected);
    case 'gte':
      return Number(actual) >= Number(expected);
    case 'exists':
      return actual !== undefined && actual !== null;
    case 'notExists':
      return actual === undefined || actual === null;
    case 'isEmpty':
      return empty(actual);
    case 'isNotEmpty':
      return !empty(actual);
    case 'lengthEquals':
      return lengthOf(actual) === Number(expected);
    case 'noNulls':
      return list(actual).every((x) => x !== null && x !== undefined);
    case 'unique': {
      const seen = list(actual).map((x) => JSON.stringify(x));
      return new Set(seen).size === seen.length;
    }
    case 'inRange': {
      const { min, max } = range(expected);
      return list(actual).every((x) => {
        const n = Number(x);
        return (
          x !== null &&
          Number.isFinite(n) &&
          (min === undefined || n >= min) &&
          (max === undefined || n <= max)
        );
      });
    }
    default:
      throw new Error(`Unknown operator "${operator}"`);
  }
}

/** Fails the test unless `compare` holds. */
export function check(actual: unknown, operator: string, expected: unknown, what: string): void {
  if (!compare(actual, operator, expected))
    throw new Error(
      `Expected ${what}${expected !== undefined && expected !== null ? ` ${JSON.stringify(expected)}` : ''}, but got ${JSON.stringify(actual)}`,
    );
}

/** A small JSONPath: $, .key, ['key'], [n], [*] and ..key. Lists come back for wildcards. */
export function jsonPath(json: unknown, path: string): unknown {
  const tokens = [
    ...path
      .replace(/^\$/, '')
      .matchAll(/\.\.([\w$-]+)|\.([\w$-]+)|\[\s*'([^']*)'\s*\]|\[\s*"([^"]*)"\s*\]|\[(\*|-?\d+)\]|\.(\*)/g),
  ];
  let nodes: unknown[] = [json];
  let multi = false;
  const kids = (n: unknown) => (Array.isArray(n) ? n : n && typeof n === 'object' ? Object.values(n) : []);
  for (const t of tokens) {
    const [, deep, dot, sq, dq, idx, star] = t;
    if (deep) {
      multi = true;
      const found: unknown[] = [];
      const visit = (n: unknown) => {
        if (n && typeof n === 'object') {
          if (!Array.isArray(n) && deep in n) found.push((n as Record<string, unknown>)[deep]);
          kids(n).forEach(visit);
        }
      };
      nodes.forEach(visit);
      nodes = found;
    } else if (idx === '*' || star) {
      multi = true;
      nodes = nodes.flatMap(kids);
    } else if (idx !== undefined) {
      const i = Number(idx);
      nodes = nodes.flatMap((n) => (Array.isArray(n) ? [n[i < 0 ? n.length + i : i]] : []));
    } else {
      const key = dot ?? sq ?? dq!;
      nodes = nodes.flatMap((n) =>
        n && typeof n === 'object' && key in n ? [(n as Record<string, unknown>)[key]] : [],
      );
    }
  }
  return multi ? nodes : nodes[0];
}

/** Reads `data.user.email`-style nested values. */
export const field = (obj: unknown, path: string): unknown =>
  path
    .split('.')
    .reduce<unknown>(
      (o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
      obj,
    );

/** First capture group of a regular expression (or the whole match). */
export function capture(text: unknown, pattern: string): string | undefined {
  const m = new RegExp(pattern).exec(String(text ?? ''));
  return m ? (m[1] ?? m[0]) : undefined;
}

/** A RegExp matching `s` literally (URL/title "contains" checks). */
export const containing = (s: unknown) => new RegExp(String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));

/** {{random.*}} values. */
export const random = {
  email: () => `sf.${Date.now().toString(36)}${faker.number.int({ min: 1000, max: 9999 })}@example.test`,
  uuid: () => faker.string.uuid(),
  number: () => faker.number.int({ min: 0, max: 999_999 }),
  digits6: () => String(faker.number.int({ min: 0, max: 999_999 })).padStart(6, '0'),
  string: () => faker.string.alphanumeric(8).toLowerCase(),
  timestamp: () => Date.now(),
};

const fromPattern = (p: string) =>
  p.replace(/[#?*]/g, (c) =>
    c === '#'
      ? String(faker.number.int(9))
      : c === '?'
        ? faker.string.alpha({ casing: 'upper' })
        : faker.string.alphanumeric(1).toUpperCase(),
  );

/** Test data, like StepForge's "Generate data" step. */
export function fake(kind: string, o: Record<string, unknown> = {}): unknown {
  switch (kind) {
    case 'name':
      return faker.person.fullName();
    case 'firstName':
      return faker.person.firstName();
    case 'lastName':
      return faker.person.lastName();
    case 'email':
      return faker.internet.email({ provider: String(o.domain ?? 'example.test') }).toLowerCase();
    case 'phone':
      return fromPattern(String(o.pattern ?? '+1-555-###-####'));
    case 'date':
      return (
        o.direction === 'future'
          ? faker.date.soon({ days: Number(o.days ?? 30) })
          : faker.date.past({ years: Number(o.years ?? 1) })
      )
        .toISOString()
        .slice(0, 10);
    case 'birthdate':
      return faker.date
        .birthdate({ min: Number(o.minAge ?? 18), max: Number(o.maxAge ?? 80), mode: 'age' })
        .toISOString()
        .slice(0, 10);
    case 'number':
      return faker.number.int({ min: Number(o.min ?? 0), max: Number(o.max ?? 1000) });
    case 'uuid':
      return faker.string.uuid();
    case 'word':
      return faker.lorem.word();
    case 'sentence':
      return faker.lorem.sentence();
    case 'address':
      return faker.location.streetAddress();
    case 'company':
      return faker.company.name();
    case 'pattern':
      return fromPattern(String(o.pattern ?? '####'));
    default:
      throw new Error(`Unknown data kind "${kind}"`);
  }
}

/** Reads an assertion target from an API or database result, as StepForge does. */
export function pick(result: ApiLike | DbLike, target: string): unknown {
  const t = target.trim();
  if ('rows' in result) {
    if (t === 'rowCount' || t === 'count') return result.rowCount;
    if (t === 'affected' || t === 'affectedRows') return result.affected ?? 0;
    if (t === 'rows') return result.rows;
    if (t === 'columns') return result.columns;
    if (t === 'time' || t === 'durationMs') return result.ms;
    if (t === 'value' || t === 'scalar') {
      const first = result.rows[0];
      return first ? first[result.columns[0] ?? Object.keys(first)[0]!] : undefined;
    }
    const col = /^(?:column|col)[:.](.+)$/.exec(t);
    if (col) return result.rows.map((r) => r[col[1]!]);
    const cell = /^rows?\[(\d+)\](?:\.(.+))?$/.exec(t);
    if (cell) {
      const row = result.rows[Number(cell[1])];
      return cell[2] ? row?.[cell[2]] : row;
    }
    if (t.startsWith('$')) return jsonPath(result.rows, t);
    return result.rows[0]?.[t];
  }
  if (t === 'status') return result.status;
  if (t === 'time') return result.ms;
  if (t === 'size') return result.size;
  if (t === 'body') return result.body;
  if (t === 'text') return result.text;
  if (t.startsWith('header:')) return result.headers[t.slice(7).toLowerCase()];
  if (t.startsWith('$')) return jsonPath(result.body, t);
  return undefined;
}

export type ApiLike = {
  status: number;
  headers: Record<string, string>;
  body: unknown;
  text: string;
  ms: number;
  size: number;
};
export type DbLike = {
  rows: Record<string, unknown>[];
  columns: string[];
  rowCount: number;
  affected?: number;
  ms: number;
};
