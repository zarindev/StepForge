import { z } from 'zod';

/**
 * The step catalogue (Section 5). Every step type is `<group>.<name>`.
 * Executors register themselves by group prefix, so adding a step type never changes the engine.
 */
export const STEP_CATALOGUE = {
  ui: [
    'navigate',
    'click',
    'dblclick',
    'rightclick',
    'hover',
    'type',
    'fill',
    'clear',
    'press',
    'select',
    'check',
    'uncheck',
    'upload',
    'dragDrop',
    'scroll',
    'switchTab',
    'closeTab',
    'handleDialog',
    'switchFrame',
    'waitFor',
    'screenshot',
    'extract',
    'assert',
    'visualCheckpoint',
  ],
  api: ['request', 'graphql', 'extract'],
  db: ['query', 'mongoFind', 'runScript', 'callProcedure', 'extract', 'dataQualityCheck'],
  email: ['waitForEmail', 'assertEmail', 'extractFromEmail', 'openEmailLink'],
  perf: ['pageMetrics', 'lighthouse', 'loadTest', 'queryPlan'],
  util: ['setVariable', 'generateData', 'wait', 'if', 'loop', 'callScenario', 'useBlock', 'runScript', 'log'],
} as const;

export type StepGroup = keyof typeof STEP_CATALOGUE;
export const STEP_GROUPS = Object.keys(STEP_CATALOGUE) as StepGroup[];

export const ALL_STEP_TYPES: string[] = STEP_GROUPS.flatMap((g) =>
  STEP_CATALOGUE[g].map((name) => `${g}.${name}`),
);

export const StepType = z.string().refine((t) => ALL_STEP_TYPES.includes(t), {
  message: 'unknown step type',
});

export function stepGroupOf(type: string): StepGroup {
  const group = type.split('.')[0] as StepGroup;
  if (!STEP_GROUPS.includes(group)) throw new Error(`Unknown step group in type "${type}"`);
  return group;
}

/** One locator strategy for a UI element. Recorder stores several, ranked (Section 7.2). */
export const LocatorStrategy = z.enum(['testId', 'role', 'label', 'placeholder', 'text', 'css', 'xpath']);
export const Locator = z.object({
  strategy: LocatorStrategy,
  value: z.string().min(1),
  /** For role locators: the accessible name. */
  name: z.string().optional(),
  score: z.number().min(0).max(100).optional(),
});
export type Locator = z.infer<typeof Locator>;

export const AssertionOperator = z.enum([
  'equals',
  'notEquals',
  'contains',
  'notContains',
  'matches',
  'lt',
  'lte',
  'gt',
  'gte',
  'exists',
  'notExists',
  'isEmpty',
  'isNotEmpty',
  'lengthEquals',
  'matchesSchema',
  // Column checks (work on a single value or a list, e.g. a DB column): no nulls, all distinct, all in range.
  'noNulls',
  'unique',
  'inRange',
]);

/** A single check attached to a step. `target` is interpreted by the executor (e.g. `status`, `$.data.id`). */
export const Assertion = z.object({
  target: z.string().min(1),
  operator: AssertionOperator,
  expected: z.unknown().optional(),
  message: z.string().optional(),
});
export type Assertion = z.infer<typeof Assertion>;

/** The unified step model shared by every layer. */
export const Step = z.object({
  type: StepType,
  label: z.string().max(300).optional(),
  params: z.record(z.string(), z.unknown()).default({}),
  locators: z.array(Locator).default([]),
  assertions: z.array(Assertion).default([]),
  enabled: z.boolean().default(true),
  continueOnFail: z.boolean().default(false),
  timeoutMs: z
    .number()
    .int()
    .positive()
    .max(30 * 60_000)
    .optional(),
  retries: z.number().int().min(0).max(10).default(0),
  /** Store the step's primary output in `{{vars.<captureAs>}}`. */
  captureAs: z
    .string()
    .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
    .optional(),
});
export type Step = z.infer<typeof Step>;
export type StepInput = z.input<typeof Step>;

export const ScenarioKind = z.enum(['ui', 'api', 'db', 'email', 'perf', 'hybrid']);
export type ScenarioKind = z.infer<typeof ScenarioKind>;

/** Derives a scenario's kind from its steps: a single non-util layer, or `hybrid`. */
export function deriveScenarioKind(stepTypes: string[]): ScenarioKind {
  const layers = new Set(stepTypes.map(stepGroupOf).filter((g) => g !== 'util'));
  if (layers.size === 1) return [...layers][0] as ScenarioKind;
  if (layers.size === 0) return 'ui';
  return 'hybrid';
}
