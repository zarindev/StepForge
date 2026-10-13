import type { StepRecord } from '@/lib/types';

/** Editor drafts carry a client-only `_k` key (recursively) so list rows keep identity while editing. */
export type DraftStep = StepRecord & { _k: string };
let seq = 0;
export const newKey = () => `k${++seq}`;

const NESTED = ['steps', 'else'] as const;

/** Nested steps are stored as written (e.g. created through the API), so missing fields get their defaults. */
export function toDrafts(steps: StepRecord[]): DraftStep[] {
  return steps.map((s) => {
    const params = { ...s.params };
    for (const key of NESTED)
      if (Array.isArray(params[key])) params[key] = toDrafts(params[key] as StepRecord[]);
    return {
      ...s,
      locators: s.locators ?? [],
      assertions: s.assertions ?? [],
      enabled: s.enabled ?? true,
      continueOnFail: s.continueOnFail ?? false,
      retries: s.retries ?? 0,
      params,
      _k: s.id ?? newKey(),
    };
  });
}

export function fromDrafts(steps: DraftStep[]): StepRecord[] {
  return steps.map(({ _k: _key, ...s }) => {
    const params = { ...s.params };
    for (const key of NESTED)
      if (Array.isArray(params[key])) params[key] = fromDrafts(params[key] as DraftStep[]);
    return { ...s, params };
  });
}

export function blankStep(type: string, params: Record<string, unknown>): DraftStep {
  return {
    type,
    params,
    locators: [],
    assertions: [],
    enabled: true,
    continueOnFail: false,
    retries: 0,
    _k: newKey(),
  };
}
