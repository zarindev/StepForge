import type { Assertion } from '../schemas/steps.ts';
import type { AssertionResult } from './types.ts';

const fmt = (v: unknown) =>
  typeof v === 'string' ? JSON.stringify(v) : v === undefined ? 'undefined' : JSON.stringify(v);

function asNumber(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  return n;
}

function lengthOf(v: unknown): number | undefined {
  if (typeof v === 'string' || Array.isArray(v)) return v.length;
  if (v && typeof v === 'object') return Object.keys(v).length;
  return undefined;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  // Loose numeric/string equality: "200" equals 200 — values from the DOM are always strings.
  if ((typeof a === 'number' && typeof b === 'string') || (typeof a === 'string' && typeof b === 'number')) {
    return String(a) === String(b);
  }
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Reads a range from `{min,max}`, `[min,max]` or `"min..max"` (either bound may be omitted). */
export function parseRange(exp: unknown): { min?: number; max?: number } {
  const num = (v: unknown) => (v === undefined || v === null || v === '' ? undefined : Number(v));
  if (Array.isArray(exp)) return { min: num(exp[0]), max: num(exp[1]) };
  if (exp && typeof exp === 'object') {
    const o = exp as { min?: unknown; max?: unknown };
    return { min: num(o.min), max: num(o.max) };
  }
  const m = /^\s*(-?[\d.]*)\s*\.\.\s*(-?[\d.]*)\s*$/.exec(String(exp ?? ''));
  return m ? { min: num(m[1]), max: num(m[2]) } : {};
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
        : String(actual ?? '').includes(String(exp));
      break;
    case 'notContains':
      passed = Array.isArray(actual)
        ? !actual.some((x) => deepEqual(x, exp))
        : !String(actual ?? '').includes(String(exp));
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
      const { min, max } = parseRange(exp);
      passed = list(actual).every((x) => {
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
