import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';

/**
 * A condition on one fact. Plain values compare for equality (numbers and strings loosely), arrays mean "one of",
 * and objects use operators: equals, in, notIn, exists, matches (+flags), contains, gt, gte, lt, lte, not.
 */
export type Matcher = unknown;
export type When = Record<string, Matcher> & { any?: When[]; all?: When[] };

const WhenSchema: z.ZodType<When> = z.lazy(() =>
  z
    .record(z.string(), z.unknown())
    .and(z.object({ any: z.array(WhenSchema).optional(), all: z.array(WhenSchema).optional() })),
) as z.ZodType<When>;

export const RuleSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'rule ids are lower-case words joined by dashes'),
  category: z.string().min(1),
  /** Higher runs first; ties are broken by confidence. */
  priority: z.number().default(50),
  confidence: z.number().min(0).max(1),
  owner: z.enum(['test', 'app', 'environment', 'data']),
  when: WhenSchema,
  title: z.string().min(1),
  explanation: z.string().min(1),
  fix: z.string().min(1),
  /** Facts shown as evidence: `label: template`. */
  evidence: z.record(z.string(), z.string()).default({}),
});
export type Rule = z.infer<typeof RuleSchema> & { source?: string };

export function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const part of path.split('.')) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

const looseEq = (a: unknown, b: unknown) =>
  a === b || (a !== undefined && a !== null && b !== undefined && b !== null && String(a) === String(b));

function matchOne(actual: unknown, m: Matcher): boolean {
  if (Array.isArray(m)) return m.some((x) => looseEq(actual, x));
  if (m === null || typeof m !== 'object') return looseEq(actual, m);
  const o = m as Record<string, unknown>;
  const num = Number(actual);
  const has =
    actual !== undefined &&
    actual !== null &&
    actual !== '' &&
    !(Array.isArray(actual) && actual.length === 0);
  for (const [op, v] of Object.entries(o)) {
    switch (op) {
      case 'equals':
        if (!looseEq(actual, v)) return false;
        break;
      case 'in':
        if (!(v as unknown[]).some((x) => looseEq(actual, x))) return false;
        break;
      case 'notIn':
        if ((v as unknown[]).some((x) => looseEq(actual, x))) return false;
        break;
      case 'exists':
        if (has !== Boolean(v)) return false;
        break;
      case 'matches':
        if (!has || !new RegExp(String(v), String(o.flags ?? 'i')).test(String(actual))) return false;
        break;
      case 'flags':
        break;
      case 'contains':
        if (!has || !String(actual).toLowerCase().includes(String(v).toLowerCase())) return false;
        break;
      case 'gt':
        if (!(has && num > Number(v))) return false;
        break;
      case 'gte':
        if (!(has && num >= Number(v))) return false;
        break;
      case 'lt':
        if (!(has && num < Number(v))) return false;
        break;
      case 'lte':
        if (!(has && num <= Number(v))) return false;
        break;
      case 'not':
        if (matchOne(actual, v)) return false;
        break;
      default:
        throw new Error(`Unknown matcher "${op}"`);
    }
  }
  return true;
}

export function matches(when: When, facts: Record<string, unknown>): boolean {
  for (const [key, m] of Object.entries(when)) {
    if (key === 'any') {
      if (!(m as When[]).some((w) => matches(w, facts))) return false;
    } else if (key === 'all') {
      if (!(m as When[]).every((w) => matches(w, facts))) return false;
    } else if (!matchOne(getPath(facts, key), m)) return false;
  }
  return true;
}

/** Fills `{{fact.path}}` placeholders with real values; missing values print as an empty string. */
export function render(template: string, facts: Record<string, unknown>): string {
  return template
    .replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, path: string) => {
      const v = getPath(facts, path);
      if (v === undefined || v === null) return '';
      return typeof v === 'object' ? JSON.stringify(v) : String(v);
    })
    .replace(/[ \t]+/g, ' ')
    .trim();
}

/** Parses one YAML file of rules; errors name the file and the rule. */
export function parseRules(text: string, source = 'rules'): Rule[] {
  const doc = parse(text) as unknown;
  const list = Array.isArray(doc) ? doc : ((doc as { rules?: unknown[] } | null)?.rules ?? []);
  return list.map((raw, i) => {
    const r = RuleSchema.safeParse(raw);
    if (!r.success)
      throw new Error(
        `${source}: rule ${(raw as { id?: string })?.id ?? `#${i + 1}`} is invalid — ${r.error.issues.map((x) => `${x.path.join('.')}: ${x.message}`).join('; ')}`,
      );
    return { ...r.data, source };
  });
}

/** Built-in rules plus any `*.yaml` in extra folders (user rules override built-ins with the same id). */
export function loadRules(dirs: string[]): Rule[] {
  const byId = new Map<string, Rule>();
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir)
      .filter((f) => /\.ya?ml$/.test(f))
      .sort())
      for (const rule of parseRules(readFileSync(join(dir, file), 'utf8'), file)) byId.set(rule.id, rule);
  }
  return [...byId.values()];
}
