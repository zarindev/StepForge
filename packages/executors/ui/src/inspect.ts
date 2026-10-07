import type { Locator as StepLocator } from '@stepforge/core';
import type { Locator } from 'playwright';
import { buildLocator, type Scope } from './locators.ts';

export type Candidate = { locator: StepLocator; text?: string; score: number; count: number };
export type FailureDiagnostics = {
  matchCount: number;
  visible?: boolean;
  candidates: Candidate[];
  pageUrl?: string;
};

/** What the browser reports about one element (computed in the page). */
type ElementInfo = {
  testId: string | null;
  tag: string;
  role: string | null;
  text: string;
  ariaLabel: string | null;
  placeholder: string | null;
  labelText: string | null;
  type: string | null;
  visible: boolean;
};

const words = (s: string) =>
  s
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1);

function levenshtein(a: string, b: string): number {
  const d = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = d[0]!;
    d[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = d[j]!;
      d[j] = Math.min(d[j]! + 1, d[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return d[b.length]!;
}

/** 0–1 similarity: the better of word overlap and edit distance. */
export function similarity(a: string, b: string): number {
  const x = a.toLowerCase().trim();
  const y = b.toLowerCase().trim();
  if (!x || !y) return 0;
  if (x === y) return 1;
  const wa = new Set(words(x));
  const wb = new Set(words(y));
  const inter = [...wa].filter((w) => wb.has(w)).length;
  const jaccard = wa.size + wb.size - inter ? inter / (wa.size + wb.size - inter) : 0;
  const edit = 1 - levenshtein(x, y) / Math.max(x.length, y.length);
  return Math.max(jaccard, edit);
}

const INPUT_STEPS = new Set(['fill', 'type', 'clear', 'select', 'check', 'uncheck', 'upload']);
const CLICKABLE = new Set(['button', 'a', 'summary', 'option']);

function implicitRole(e: ElementInfo): string | null {
  if (e.role) return e.role;
  if (e.tag === 'button' || (e.tag === 'input' && ['submit', 'button'].includes(e.type ?? '')))
    return 'button';
  if (e.tag === 'a') return 'link';
  if (e.tag === 'select') return 'combobox';
  if (
    e.tag === 'textarea' ||
    (e.tag === 'input' && ['text', 'email', 'search', 'tel', 'url', 'password', null].includes(e.type))
  )
    return 'textbox';
  if (e.tag === 'input' && e.type === 'checkbox') return 'checkbox';
  return null;
}

/** The most robust locator for an element, in the recorder's order of preference. */
function locatorFor(e: ElementInfo): StepLocator | null {
  if (e.testId) return { strategy: 'testId', value: e.testId };
  const role = implicitRole(e);
  const name = e.ariaLabel || e.labelText || e.text;
  if (role && name) return { strategy: 'role', value: role, name };
  if (e.labelText) return { strategy: 'label', value: e.labelText };
  if (e.placeholder) return { strategy: 'placeholder', value: e.placeholder };
  if (e.text) return { strategy: 'text', value: e.text };
  return null;
}

/**
 * Looks at the page when a step fails: does the element exist (hidden?), and if nothing matches, which elements
 * now look like the one the step wanted (a renamed button, a changed test id…). Candidates are verified to match
 * exactly one element. Returns the element to highlight in the failure screenshot.
 */
export async function inspectFailure(
  scope: Scope,
  stepName: string,
  locators: StepLocator[],
): Promise<{ diagnostics: FailureDiagnostics; target?: Locator }> {
  let matchCount = 0;
  let target: Locator | undefined;
  for (const l of locators) {
    try {
      const loc = buildLocator(scope, l);
      const n = await loc.count();
      if (n > matchCount) {
        matchCount = n;
        target = loc.first();
      }
    } catch {
      // invalid selector: ignore
    }
  }
  if (target) {
    const visible = await target.isVisible().catch(() => false);
    return { diagnostics: { matchCount, visible, candidates: [] }, target };
  }

  const wanted = locators
    .flatMap((l) => [l.value, l.name ?? ''])
    .filter(Boolean)
    .map((v) => v.replace(/[-_]/g, ' '));
  if (!wanted.length) return { diagnostics: { matchCount: 0, candidates: [] } };
  const inputsOnly = INPUT_STEPS.has(stepName);
  const infos = (await scope
    .locator(
      'button, a, input, select, textarea, label, summary, [role], [data-testid], [data-test], [data-cy], [data-qa], h1, h2, h3',
    )
    .evaluateAll((els: unknown[]) =>
      els.slice(0, 1500).map((raw) => {
        // Runs in the page.
        const el = raw as {
          tagName: string;
          id: string;
          textContent: string | null;
          getAttribute(n: string): string | null;
          getClientRects(): { length: number };
          ownerDocument: { querySelector(s: string): { textContent: string | null } | null };
        };
        const id = el.id;
        const label = id ? el.ownerDocument.querySelector(`label[for="${id.replace(/"/g, '')}"]`) : null;
        return {
          testId:
            el.getAttribute('data-testid') ??
            el.getAttribute('data-test') ??
            el.getAttribute('data-cy') ??
            el.getAttribute('data-qa'),
          tag: el.tagName.toLowerCase(),
          role: el.getAttribute('role'),
          text: (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 80),
          ariaLabel: el.getAttribute('aria-label'),
          placeholder: el.getAttribute('placeholder'),
          labelText: label?.textContent?.replace(/\s+/g, ' ').trim() ?? null,
          type: el.getAttribute('type'),
          visible: el.getClientRects().length > 0,
        };
      }),
    )
    .catch(() => [])) as ElementInfo[];

  const scored = infos
    .filter((e) => e.visible)
    .filter((e) => !inputsOnly || ['input', 'select', 'textarea'].includes(e.tag))
    .filter(
      (e) =>
        inputsOnly ||
        CLICKABLE.has(e.tag) ||
        e.role ||
        e.testId ||
        e.tag === 'label' ||
        /^h[1-3]$/.test(e.tag),
    )
    .map((e) => {
      const own = [e.testId?.replace(/[-_]/g, ' '), e.text, e.ariaLabel, e.placeholder, e.labelText].filter(
        Boolean,
      ) as string[];
      const score = Math.max(0, ...own.flatMap((o) => wanted.map((w) => similarity(w, o))));
      return { e, score };
    })
    .filter((x) => x.score >= 0.45)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);

  const candidates: Candidate[] = [];
  const seen = new Set<string>();
  for (const { e, score } of scored) {
    const loc = locatorFor(e);
    if (!loc) continue;
    const key = JSON.stringify(loc);
    if (seen.has(key)) continue;
    seen.add(key);
    const count = await buildLocator(scope, loc)
      .count()
      .catch(() => 0);
    if (count !== 1) continue;
    candidates.push({ locator: loc, text: e.text || undefined, score: Math.round(score * 100) / 100, count });
    if (candidates.length === 3) break;
  }
  return { diagnostics: { matchCount: 0, candidates } };
}

/** Outlines the element in red for the failure screenshot; returns a function that removes the outline. */
export async function highlight(target: Locator): Promise<() => Promise<void>> {
  await target.scrollIntoViewIfNeeded({ timeout: 1000 }).catch(() => undefined);
  await target.evaluate(
    (el: unknown) => {
      const s = (el as { style: Record<string, string> }).style;
      s.__sfOutline = s.outline ?? '';
      s.outline = '3px solid #EF4444';
      s.outlineOffset = '2px';
    },
    undefined,
    { timeout: 1000 },
  );
  return async () => {
    await target
      .evaluate((el: unknown) => {
        const s = (el as { style: Record<string, string> }).style;
        s.outline = s.__sfOutline ?? '';
        s.outlineOffset = '';
      })
      .catch(() => undefined);
  };
}
