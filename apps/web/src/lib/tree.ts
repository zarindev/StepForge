import type { ModuleNode, ScenarioSummary, TestCaseSummary, Tree } from './types';

export type Filters = { q: string; priority: string; kind: string; status: string; tagId: string };
export const EMPTY_FILTERS: Filters = { q: '', priority: '', kind: '', status: '', tagId: '' };
export const hasFilters = (f: Filters) => Object.values(f).some(Boolean);

export type ModuleTreeNode = ModuleNode & {
  children: ModuleTreeNode[];
  scenarios: (ScenarioSummary & { testCases: TestCaseSummary[] })[];
  /** Scenario count including sub-modules (after filtering). */
  total: number;
};

/** Builds the nested module tree, applying filters. Modules without matches are hidden while filtering. */
export function buildTree(tree: Tree, f: Filters): ModuleTreeNode[] {
  const q = f.q.trim().toLowerCase();
  const filtering = hasFilters(f);
  const tcByScenario = new Map<string, TestCaseSummary[]>();
  for (const tc of tree.testCases)
    tcByScenario.set(tc.scenarioId, [...(tcByScenario.get(tc.scenarioId) ?? []), tc]);

  const scenarioMatches = (s: ScenarioSummary, moduleMatches: boolean) => {
    if (f.priority && s.priority !== f.priority) return false;
    if (f.kind && s.kind !== f.kind) return false;
    if (f.status && s.status !== f.status) return false;
    if (f.tagId && !s.tagIds.includes(f.tagId)) return false;
    if (!q || moduleMatches) return true;
    return (
      s.name.toLowerCase().includes(q) ||
      (tcByScenario.get(s.id) ?? []).some((tc) => `${tc.code} ${tc.title}`.toLowerCase().includes(q))
    );
  };

  const build = (parentId: string | null, ancestorMatches: boolean): ModuleTreeNode[] =>
    tree.modules
      .filter((m) => m.parentId === parentId)
      .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name))
      .map((m) => {
        const selfMatches = ancestorMatches || (!!q && m.name.toLowerCase().includes(q));
        const children = build(m.id, selfMatches);
        const scenarios = tree.scenarios
          .filter((s) => s.moduleId === m.id && scenarioMatches(s, selfMatches))
          .map((s) => ({ ...s, testCases: tcByScenario.get(s.id) ?? [] }));
        const total = scenarios.length + children.reduce((n, c) => n + c.total, 0);
        return { ...m, children, scenarios, total, _keep: !filtering || total > 0 || (selfMatches && !!q) };
      })
      .filter((m) => m._keep)
      .map(({ _keep: _k, ...m }) => m);

  return build(null, false);
}

/** Module options for "move to" pickers, indented by depth. */
export function flattenModules(tree: Tree): { id: string; label: string; depth: number }[] {
  const out: { id: string; label: string; depth: number }[] = [];
  const walk = (parentId: string | null, depth: number) => {
    for (const m of tree.modules
      .filter((x) => x.parentId === parentId)
      .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name))) {
      out.push({ id: m.id, label: `${'  '.repeat(depth)}${m.name}`, depth });
      walk(m.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

export function modulePath(tree: Tree, moduleId: string): string[] {
  const path: string[] = [];
  let cur = tree.modules.find((m) => m.id === moduleId);
  while (cur) {
    path.unshift(cur.name);
    cur = cur.parentId ? tree.modules.find((m) => m.id === cur!.parentId) : undefined;
  }
  return path;
}
