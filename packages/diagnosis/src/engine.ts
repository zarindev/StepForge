import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildFacts } from './facts.ts';
import { loadRules, matches, render, type Rule } from './rules.ts';
import type { Diagnosis, DiagnosisInput, LastGreenDiff } from './types.ts';

/** The rules shipped with StepForge (`packages/diagnosis/rules/*.yaml`). */
export const BUILTIN_RULES_DIR = join(dirname(fileURLToPath(import.meta.url)), '../rules');

const short = (v: unknown, n = 80) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s === undefined ? '—' : s.length > n ? `${s.slice(0, n - 1)}…` : s;
};

/** What changed since the same test last passed. */
export function lastGreenDiff(input: DiagnosisInput): LastGreenDiff | undefined {
  const lg = input.lastGreen;
  if (!lg) return undefined;
  const changes: LastGreenDiff['changes'] = [];
  const before = lg.step;
  const now = input.failed;
  if (before) {
    if (before.status !== now.status)
      changes.push({ what: 'Step result', before: before.status, after: now.status });
    const bs = before.response?.status;
    const ns = now.response?.status;
    if (bs !== undefined && ns !== undefined && bs !== ns)
      changes.push({ what: 'HTTP status', before: String(bs), after: String(ns) });
    // Top-level response fields whose value or type changed.
    const bb = before.response?.body;
    const nb = now.response?.body;
    const firstOf = (b: unknown) => (Array.isArray(b) ? b[0] : b);
    const bo = firstOf(bb);
    const no = firstOf(nb);
    if (bo && no && typeof bo === 'object' && typeof no === 'object') {
      for (const k of new Set([...Object.keys(bo as object), ...Object.keys(no as object)])) {
        const a = (bo as Record<string, unknown>)[k];
        const b = (no as Record<string, unknown>)[k];
        if (typeof a !== typeof b)
          changes.push({
            what: `Response field "${k}" type`,
            before: a === undefined ? 'missing' : typeof a,
            after: b === undefined ? 'missing' : typeof b,
          });
      }
    }
    const br = (before.query as { rowCount?: number } | undefined)?.rowCount;
    const nr = (now.query as { rowCount?: number } | undefined)?.rowCount;
    if (br !== undefined && nr !== undefined && br !== nr)
      changes.push({ what: 'Rows returned', before: String(br), after: String(nr) });
    if (
      before.durationMs !== undefined &&
      now.durationMs !== undefined &&
      now.durationMs > before.durationMs * 2 &&
      now.durationMs - before.durationMs > 500
    )
      changes.push({
        what: 'Step duration',
        before: `${before.durationMs} ms`,
        after: `${now.durationMs} ms`,
      });
    if (before.healedLocator === undefined && now.healedLocator)
      changes.push({ what: 'Locator', before: 'primary locator matched', after: 'only a fallback matched' });
  }
  if (lg.browser && input.current?.browser && lg.browser !== input.current.browser)
    changes.push({ what: 'Browser', before: lg.browser, after: input.current.browser });
  if (lg.baseUrl && input.current?.baseUrl && lg.baseUrl !== input.current.baseUrl)
    changes.push({ what: 'Base URL', before: lg.baseUrl, after: input.current.baseUrl });
  return { runId: lg.runId, at: lg.at, changes };
}

let builtin: Rule[] | undefined;
export const builtinRules = () => (builtin ??= loadRules([BUILTIN_RULES_DIR]));

/**
 * Diagnoses a failure: every rule whose conditions match is a candidate; the highest priority (then confidence)
 * wins and the rest are listed as alternatives. A generic rule always matches, so there is always an answer.
 */
export function diagnose(input: DiagnosisInput, rules: Rule[] = builtinRules()): Diagnosis {
  const facts = buildFacts(input);
  const matched = rules
    .filter((r) => {
      try {
        return matches(r.when, facts);
      } catch {
        return false; // a broken user rule must not break diagnosis
      }
    })
    .sort((a, b) => b.priority - a.priority || b.confidence - a.confidence);
  const best = matched[0];
  const f = input.failed;
  const where = { step: f.label || f.type, path: f.path, type: f.type };
  const diff = lastGreenDiff(input);
  if (!best)
    return {
      ruleId: 'none',
      category: 'unknown',
      title: 'The test failed for a reason StepForge does not recognise',
      explanation: f.message ?? 'No error message',
      owner: 'test',
      fix: 'Open the step evidence (screenshot, trace, logs) to investigate.',
      confidence: 0.1,
      where,
      evidence: [],
      lastGreen: diff,
      alternatives: [],
    };
  const evidence = Object.entries(best.evidence)
    .map(([label, t]) => ({ label, value: short(render(t, facts), 300) }))
    .filter((e) => e.value !== '');
  if (diff?.changes.length)
    evidence.push({
      label: 'Since the last pass',
      value: diff.changes.map((c) => `${c.what}: ${c.before} → ${c.after}`).join('; '),
    });
  const candidate = f.diagnostics?.candidates?.[0];
  return {
    ruleId: best.id,
    category: best.category,
    title: render(best.title, facts),
    explanation: render(best.explanation, facts),
    owner: best.owner,
    fix: render(best.fix, facts),
    confidence: best.confidence,
    where,
    evidence,
    ...(best.category === 'locator_changed' && candidate && { suggestedLocator: candidate.locator }),
    lastGreen: diff,
    // Other plausible explanations (generic catch-alls that just restate the error are left out).
    alternatives: matched
      .slice(1)
      .filter((r) => r.category !== best.category && r.confidence >= 0.5)
      .slice(0, 3)
      .map((r) => ({
        ruleId: r.id,
        category: r.category,
        title: render(r.title, facts),
        confidence: r.confidence,
      })),
  };
}
