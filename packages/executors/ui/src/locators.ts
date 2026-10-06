import { StepError, type Locator as StepLocator } from '@stepforge/core';
import type { FrameLocator, Locator, Page } from 'playwright';

export type Scope = Page | FrameLocator;
const q = (v: string) => JSON.stringify(v);

/** Turns one stored locator strategy into a Playwright locator. */
export function buildLocator(scope: Scope, l: StepLocator): Locator {
  switch (l.strategy) {
    case 'testId':
      return scope.locator(
        `[data-testid=${q(l.value)}], [data-test=${q(l.value)}], [data-cy=${q(l.value)}], [data-qa=${q(l.value)}]`,
      );
    case 'role':
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return scope.getByRole(l.value as any, l.name ? { name: l.name, exact: true } : undefined);
    case 'label':
      return scope.getByLabel(l.value, { exact: true });
    case 'placeholder':
      return scope.getByPlaceholder(l.value, { exact: true });
    case 'text':
      return scope.getByText(l.value, { exact: true });
    case 'css':
      return scope.locator(l.value);
    case 'xpath':
      return scope.locator(`xpath=${l.value}`);
  }
}

export const describeLocator = (l: StepLocator) => `${l.strategy}=${l.value}${l.name ? ` "${l.name}"` : ''}`;

export type Resolved = { locator: Locator; used: StepLocator; index: number; matches: number };

/**
 * Finds the element using the ranked strategies. Waits once (natively, so traces stay clean) for any
 * candidate to attach, then picks the best-ranked one that matches. A lower-ranked match is "healed".
 */
export async function resolveLocator(
  scope: Scope,
  candidates: StepLocator[],
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<Resolved> {
  if (!candidates.length) throw new StepError('invalid_params', 'This step needs at least one locator');
  if (signal?.aborted) throw new StepError('aborted', 'Run was cancelled');
  // Drop strategies whose selector is syntactically invalid so one bad CSS/XPath cannot break the rest.
  const valid: { loc: Locator; index: number }[] = [];
  for (const [index, c] of candidates.entries()) {
    const loc = buildLocator(scope, c);
    try {
      await loc.count();
      valid.push({ loc, index });
    } catch {
      // invalid selector for this strategy
    }
  }
  const notFound = () =>
    new StepError(
      'element_not_found',
      `No element found within ${timeoutMs} ms. Tried: ${candidates.map(describeLocator).join(' | ')}`,
      {
        tried: candidates,
      },
    );
  if (!valid.length) throw notFound();
  const anyOf = valid.map((v) => v.loc).reduce((a, b) => a.or(b));
  try {
    await anyOf.first().waitFor({ state: 'attached', timeout: timeoutMs });
  } catch (err) {
    if ((err as Error).name === 'TimeoutError') throw notFound();
    throw err;
  }
  for (const { loc, index } of valid) {
    const n = await loc.count();
    if (n > 0) return { locator: n > 1 ? loc.first() : loc, used: candidates[index]!, index, matches: n };
  }
  throw notFound(); // detached between the wait and the check
}
