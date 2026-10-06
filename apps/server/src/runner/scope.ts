import type { RunScope } from '@stepforge/core';
import { schema, type StepForgeDb } from '@stepforge/db';
import * as repo from '@stepforge/db/repos';
import { and, eq, inArray } from 'drizzle-orm';

export type PlannedItem = {
  scenarioId: string;
  testCaseId: string | null;
  label: {
    scenario: string;
    modulePath: string[];
    testCaseCode: string | null;
    testCaseTitle: string | null;
  };
};

/**
 * Expands a run scope into the list of (scenario, test case) pairs to execute, in tree order.
 * Deprecated scenarios and skipped test cases are left out; a scenario without test cases runs once with no data.
 */
export function expandScope(db: StepForgeDb, applicationId: string, scope: RunScope): PlannedItem[] {
  const tree = repo.getTree(db, applicationId);
  const byModule = new Map<string | null, typeof tree.modules>();
  for (const m of tree.modules) byModule.set(m.parentId, [...(byModule.get(m.parentId) ?? []), m]);
  const order: string[] = [];
  const walk = (parent: string | null) => {
    for (const m of (byModule.get(parent) ?? []).sort(
      (a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name),
    )) {
      order.push(m.id);
      walk(m.id);
    }
  };
  walk(null);
  const pathOf = (moduleId: string): string[] => {
    const out: string[] = [];
    let cur = tree.modules.find((m) => m.id === moduleId);
    while (cur) {
      out.unshift(cur.name);
      cur = cur.parentId ? tree.modules.find((m) => m.id === cur!.parentId) : undefined;
    }
    return out;
  };

  let scenarioIds: Set<string>;
  let onlyTestCases: Set<string> | null = null;
  switch (scope.type) {
    case 'application':
      scenarioIds = new Set(tree.scenarios.map((s) => s.id));
      break;
    case 'module': {
      const mods = new Set([scope.id, ...repo.descendantIds(db, scope.id)]);
      scenarioIds = new Set(tree.scenarios.filter((s) => mods.has(s.moduleId)).map((s) => s.id));
      break;
    }
    case 'scenarios':
      scenarioIds = new Set(scope.ids);
      break;
    case 'tag':
      scenarioIds = new Set(tree.scenarios.filter((s) => s.tagIds.includes(scope.id)).map((s) => s.id));
      break;
    case 'testCases': {
      onlyTestCases = new Set(scope.ids);
      scenarioIds = new Set(tree.testCases.filter((t) => onlyTestCases!.has(t.id)).map((t) => t.scenarioId));
      break;
    }
  }

  const explicit = scope.type === 'scenarios' || scope.type === 'testCases';
  const scenarios = tree.scenarios
    .filter((s) => scenarioIds.has(s.id) && (explicit || s.status !== 'deprecated'))
    .sort((a, b) => order.indexOf(a.moduleId) - order.indexOf(b.moduleId) || a.name.localeCompare(b.name));

  const items: PlannedItem[] = [];
  for (const s of scenarios) {
    const cases = tree.testCases.filter(
      (t) => t.scenarioId === s.id && (onlyTestCases ? onlyTestCases.has(t.id) : t.status === 'active'),
    );
    const base = { scenario: s.name, modulePath: pathOf(s.moduleId) };
    if (cases.length === 0 && !onlyTestCases) {
      items.push({
        scenarioId: s.id,
        testCaseId: null,
        label: { ...base, testCaseCode: null, testCaseTitle: null },
      });
    }
    for (const tc of cases) {
      items.push({
        scenarioId: s.id,
        testCaseId: tc.id,
        label: { ...base, testCaseCode: tc.code, testCaseTitle: tc.title },
      });
    }
  }
  return items;
}

/** Data row of a test case (or empty). */
export function testCaseData(db: StepForgeDb, testCaseId: string | null): Record<string, unknown> {
  if (!testCaseId) return {};
  return db.select().from(schema.testCases).where(eq(schema.testCases.id, testCaseId)).get()?.dataJson ?? {};
}

export function unfinishedItems(db: StepForgeDb, runId: string) {
  return db
    .select()
    .from(schema.runItems)
    .where(and(eq(schema.runItems.runId, runId), inArray(schema.runItems.status, ['queued', 'running'])))
    .orderBy(schema.runItems.position)
    .all();
}
