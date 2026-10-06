import type { StepForgeDb } from '@stepforge/db';
import * as repo from '@stepforge/db/repos';
import type { ImportPlan, PlannedModule, PlannedStep } from '@stepforge/importers';

export type MaterializeResult = {
  rootModuleId: string;
  modules: number;
  scenarios: number;
  blocks: number;
  secretsNeeded: string[];
  warnings: string[];
};

/** Creates modules, blocks and scenarios for an import plan inside one transaction. */
export function materializePlan(
  db: StepForgeDb,
  applicationId: string,
  plan: ImportPlan,
  opts: { parentModuleId?: string | null } = {},
): MaterializeResult {
  let modules = 0;
  let scenarios = 0;
  let rootModuleId = '';
  db.transaction(() => {
    const blockIds = new Map<string, string>();
    for (const b of plan.blocks) {
      const created = repo.createBlock(db, applicationId, {
        name: b.name,
        description: b.description ?? '',
        steps: b.steps,
      });
      blockIds.set(b.key, created.id);
    }
    const fixRefs = (steps: PlannedStep[]): PlannedStep[] =>
      steps.map((s) => {
        const p = s.params as Record<string, unknown> | undefined;
        if (typeof p?.blockId === 'string' && p.blockId.startsWith('@block:')) {
          return { ...s, params: { ...p, blockId: blockIds.get(p.blockId.slice(7)) ?? p.blockId } };
        }
        return s;
      });
    const create = (m: PlannedModule, parentId: string | null): string => {
      const mod = repo.createModule(db, applicationId, {
        name: m.name,
        description: m.description ?? '',
        parentId,
      });
      modules++;
      for (const s of m.scenarios) {
        const sc = repo.createScenario(db, mod.id, {
          name: s.name,
          description: s.description ?? '',
          priority: s.priority ?? 'P2',
          steps: fixRefs(s.steps),
        });
        scenarios++;
        for (const tc of s.testCases ?? []) {
          repo.createTestCase(db, sc.id, {
            title: tc.title,
            data: tc.data,
            expectedResult: tc.expectedResult ?? '',
            technique: (tc.technique as never) ?? 'positive',
          });
        }
        if (s.tags?.length) {
          const existing = repo.listTags(db, applicationId);
          const ids = s.tags.map(
            (name) =>
              existing.find((t) => t.name === name)?.id ??
              repo.createTag(db, applicationId, { name, color: '#6366F1' }).id,
          );
          repo.setScenarioTags(db, applicationId, sc.id, ids);
        }
      }
      for (const c of m.children ?? []) create(c, mod.id);
      return mod.id;
    };
    rootModuleId = create(plan.root, opts.parentModuleId ?? null);
  });
  return {
    rootModuleId,
    modules,
    scenarios,
    blocks: plan.blocks.length,
    secretsNeeded: plan.secretsNeeded,
    warnings: plan.warnings,
  };
}
