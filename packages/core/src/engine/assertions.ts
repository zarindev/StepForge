import type { Assertion } from '../schemas/steps.ts';
import type { AssertionResult } from './types.ts';

const fmt = (v: unknown) =>
  typeof v === 'string' ? JSON.stringify(v) : v === undefined ? 'undefined' : JSON.stringify(v);

/** A number, or NaN for anything that is not one (a missing value must not count as 0). */
function asNumber(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '') return Number(v);
  return NaN;
}

/** JSON with object keys sorted, so `{a:1,b:2}` and `{b:2,a:1}` compare equal. */
function stableJson(v: unknown): string {
  return JSON.stringify(v, (_k, x: unknown) =>
    x && typeof x === 'object' && !Array.isArray(x)
      ? Object.fromEntries(
          Object.entries(x as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
        )
      : x,
  );
}

/** Text to search in: strings as they are, objects and arrays as their JSON. */
const textOf = (v: unknown) =>
  typeof v === 'string'
    ? v
    : v === undefined || v === null
      ? ''
      : typeof v === 'object'
        ? JSON.stringify(v)
        : String(v);

function lengthOf(v: unknown): number | undefined {
  if (typeof v === 'string' || Array.isArray(v)) return v.length;
  if (v && typeof v === 'object') return Object.keys(v).length;
  return undefined;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  // Loose equality with text: "200" equals 200 and "true" equals true — values from the DOM are always strings.
  const scalar = (x: unknown) => typeof x === 'number' || typeof x === 'boolean';
  if ((scalar(a) && typeof b === 'string') || (typeof a === 'string' && scalar(b)))
    return String(a) === String(b);
  return stableJson(a) === stableJson(b);
}

/**
 * Reads a range from `{min,max}`, `[min,max]` or `"min..max"` (either bound may be omitted, not both); null when it
 * is not a range, so a check never passes on a range it could not read.
 */
export function parseRange(exp: unknown): { min?: number; max?: number } | null {
  const num = (v: unknown) =>
    v === undefined || v === null || (typeof v === 'string' && v.trim() === '') ? undefined : Number(v);
  let r: { min?: number; max?: number } | null = null;
  if (Array.isArray(exp)) r = { min: num(exp[0]), max: num(exp[1]) };
  else if (exp && typeof exp === 'object') {
    const o = exp as { min?: unknown; max?: unknown };
    r = { min: num(o.min), max: num(o.max) };
  } else {
    const parts = String(exp ?? '').split('..');
    if (parts.length === 2) r = { min: num(parts[0]), max: num(parts[1]) };
  }
  if (!r || (r.min === undefined && r.max === undefined)) return null;
  if ([r.min, r.max].some((x) => x !== undefined && !Number.isFinite(x))) return null;
  return r;
}

const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : [v]);

/** Evaluates one assertion against an already-obtained actual value. Pure and synchronous. */
export function evaluateAssertion(a: Assertion, actual: unknown): AssertionResult {
  const exp = a.expected;
  let passed: boolean;
  switch (a.operator) {
    case 'equals':
      passed = deepEqual(actual, exp);
      break;
    case 'notEquals':
      passed = !deepEqual(actual, exp);
      break;
    case 'contains':
      passed = Array.isArray(actual)
        ? actual.some((x) => deepEqual(x, exp))
        : textOf(actual).includes(textOf(exp));
      break;
    case 'notContains':
      passed = Array.isArray(actual)
        ? !actual.some((x) => deepEqual(x, exp))
        : !textOf(actual).includes(textOf(exp));
      break;
    case 'matches':
      try {
        passed = new RegExp(String(exp)).test(String(actual ?? ''));
      } catch {
        passed = false;
      }
      break;
    case 'lt':
      passed = asNumber(actual) < asNumber(exp);
      break;
    case 'lte':
      passed = asNumber(actual) <= asNumber(exp);
      break;
    case 'gt':
      passed = asNumber(actual) > asNumber(exp);
      break;
    case 'gte':
      passed = asNumber(actual) >= asNumber(exp);
      break;
    case 'exists':
      passed = actual !== undefined && actual !== null;
      break;
    case 'notExists':
      passed = actual === undefined || actual === null;
      break;
    case 'isEmpty':
      passed = actual === '' || actual === null || actual === undefined || lengthOf(actual) === 0;
      break;
    case 'isNotEmpty':
      passed = !(actual === '' || actual === null || actual === undefined || lengthOf(actual) === 0);
      break;
    case 'lengthEquals':
      passed = lengthOf(actual) === asNumber(exp);
      break;
    case 'noNulls':
      passed = list(actual).every((x) => x !== null && x !== undefined);
      break;
    case 'unique': {
      const seen = list(actual).map((x) => JSON.stringify(x));
      passed = new Set(seen).size === seen.length;
      break;
    }
    case 'inRange': {
      const range = parseRange(exp);
      const { min, max } = range ?? {};
      passed =
        !!range &&
        list(actual).every((x) => {
          const n = asNumber(x);
          return (
            x !== null &&
            Number.isFinite(n) &&
            (min === undefined || n >= min) &&
            (max === undefined || n <= max)
          );
        });
      break;
    }
    case 'matchesSchema':
      // JSON Schema validation is provided by the API executor (Phase 5); here it cannot be judged.
      return {
        target: a.target,
        operator: a.operator,
        expected: exp,
        actual,
        passed: false,
        message: 'matchesSchema is evaluated by the API executor',
      };
    default:
      passed = false;
  }
  const message = passed
    ? `${a.target} ${a.operator}${exp !== undefined ? ` ${fmt(exp)}` : ''}`
    : (a.message ??
      `Expected ${a.target} ${a.operator}${exp !== undefined ? ` ${fmt(exp)}` : ''}, but got ${fmt(actual)}`);
  return { target: a.target, operator: a.operator, expected: exp, actual, passed, message };
}

/** Numeric difference for failed numeric comparisons, used by diagnosis ("off by 12.5"). */
export function numericDelta(r: AssertionResult): number | undefined {
  const a = Number(r.actual);
  const e = Number(r.expected);
  return Number.isFinite(a) && Number.isFinite(e) ? a - e : undefined;
}
