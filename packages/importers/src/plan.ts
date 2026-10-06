import type { Priority, StepInput } from '@stepforge/core';

/** Placeholder for a block created by the same import, e.g. `{ blockId: '@block:auth' }`. */
export const blockRef = (key: string) => `@block:${key}`;

export type PlannedStep = StepInput & { label?: string };
export type PlannedScenario = {
  name: string;
  description?: string;
  priority?: Priority;
  tags?: string[];
  steps: PlannedStep[];
  testCases?: { title: string; data: Record<string, unknown>; expectedResult?: string; technique?: string }[];
};
export type PlannedModule = {
  name: string;
  description?: string;
  scenarios: PlannedScenario[];
  children?: PlannedModule[];
};

/** Source-independent result of an import, materialised by the server into modules/scenarios/blocks. */
export type ImportPlan = {
  root: PlannedModule;
  blocks: { key: string; name: string; description?: string; steps: PlannedStep[] }[];
  /** Secrets the generated steps reference (the user sets them per environment). */
  secretsNeeded: string[];
  /** Environment variables referenced as {{env.x}}, with a suggested value when known. */
  variables: Record<string, string>;
  warnings: string[];
  stats: Record<string, number>;
};

export function countScenarios(m: PlannedModule): number {
  return m.scenarios.length + (m.children ?? []).reduce((n, c) => n + countScenarios(c), 0);
}
