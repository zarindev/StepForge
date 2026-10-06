import { describe, expect, it } from 'vitest';
import { ALL_STEP_TYPES, deriveScenarioKind, Step, stepGroupOf } from '../src/index.ts';

describe('step model', () => {
  it('applies defaults', () => {
    const s = Step.parse({ type: 'ui.click' });
    expect(s).toMatchObject({ enabled: true, continueOnFail: false, retries: 0, params: {}, assertions: [] });
  });

  it('rejects unknown types and bad captureAs', () => {
    expect(Step.safeParse({ type: 'ui.teleport' }).success).toBe(false);
    expect(Step.safeParse({ type: 'ui.click', captureAs: '1bad' }).success).toBe(false);
  });

  it('catalogue covers every group', () => {
    expect(ALL_STEP_TYPES).toContain('api.request');
    expect(ALL_STEP_TYPES).toContain('email.waitForEmail');
    expect(stepGroupOf('perf.loadTest')).toBe('perf');
  });

  it('derives scenario kind', () => {
    expect(deriveScenarioKind(['ui.navigate', 'util.log', 'ui.click'])).toBe('ui');
    expect(deriveScenarioKind(['api.request'])).toBe('api');
    expect(deriveScenarioKind(['ui.navigate', 'db.query'])).toBe('hybrid');
  });
});
