import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { AppWindow, FolderPlus, FolderTree, ListFilter, MousePointerClick, Search, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { BulkBar, type BulkAction } from '@/components/explorer/bulk-bar';
import { openRunDialog } from '@/components/runs/run-dialog';
import { PromptDialog } from '@/components/explorer/prompt-dialog';
import { ScenarioPanel, type PanelTab } from '@/components/explorer/scenario-panel';
import { TreeView, type TreeActions } from '@/components/explorer/tree-view';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm';
import { Input, Select } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { toast, toastError } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { qk, useCurrentApp, useLastResults, useTags, useTree } from '@/lib/queries';
import {
  buildTree,
  EMPTY_FILTERS,
  flattenModules,
  hasFilters,
  type Filters,
  type ModuleTreeNode,
} from '@/lib/tree';
import type { ScenarioDetail, ScenarioSummary } from '@/lib/types';

type Prompt =
  | { kind: 'module'; parentId: string | null }
  | { kind: 'rename'; module: ModuleTreeNode }
  | { kind: 'scenario'; moduleId: string };
type Confirm =
  { kind: 'module'; module: ModuleTreeNode } | { kind: 'scenarios'; ids: string[]; label: string };

export function ExplorerPage() {
  const { app, apps } = useCurrentApp();
  const search = useSearch({ from: '/explorer' });
  const navigate = useNavigate({ from: '/explorer' });
  const tree = useTree(app?.id);
  const tags = useTags(app?.id);
  const lastResults = useLastResults(app?.id);
  const qc = useQueryClient();
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [showFilters, setShowFilters] = useState(false);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [prompt, setPrompt] = useState<Prompt | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);

  const nodes = useMemo(() => (tree.data ? buildTree(tree.data, filters) : []), [tree.data, filters]);
  const moduleOptions = useMemo(() => (tree.data ? flattenModules(tree.data) : []), [tree.data]);
  const selectedId =
    search.scenario && tree.data?.scenarios.some((s) => s.id === search.scenario) ? search.scenario : null;
  const select = (id: string | null, tab?: PanelTab) =>
    navigate({
      search: (prev) => ({
        ...prev,
        scenario: id ?? undefined,
        tab: tab ?? (id === prev.scenario ? prev.tab : undefined),
      }),
    });
  const refresh = () => {
    if (!app) return;
    qc.invalidateQueries({ queryKey: qk.tree(app.id) });
    qc.invalidateQueries({ queryKey: qk.applications });
  };

  const run = useMutation({
    mutationFn: (fn: () => Promise<unknown>) => fn(),
    onSuccess: refresh,
    onError: toastError,
  });
  const exec = (fn: () => Promise<unknown>, done?: (r: unknown) => void, message?: string) =>
    run.mutate(fn, {
      onSuccess: (r) => {
        done?.(r);
        if (message) toast(message);
      },
    });

  const bulk = (body: Record<string, unknown>, message: string) =>
    exec(
      () => api(`/api/applications/${app!.id}/scenarios/bulk`, { method: 'POST', json: body }),
      undefined,
      message,
    );

  const actions: TreeActions = {
    onSelectScenario: (id, tab) => select(id, tab),
    onNewModule: (parentId) => setPrompt({ kind: 'module', parentId }),
    onNewScenario: (moduleId) => setPrompt({ kind: 'scenario', moduleId }),
    onRenameModule: (module) => setPrompt({ kind: 'rename', module }),
    onDeleteModule: (module) => setConfirm({ kind: 'module', module }),
    onDuplicateScenario: (id) =>
      exec(
        () => api<ScenarioDetail>(`/api/scenarios/${id}/duplicate`, { method: 'POST' }),
        (r) => select((r as ScenarioDetail).id),
        'Scenario duplicated',
      ),
    onDeleteScenario: (s: ScenarioSummary) => setConfirm({ kind: 'scenarios', ids: [s.id], label: s.name }),
    onMoveModule: (id, parentId) =>
      exec(
        () => api(`/api/modules/${id}`, { method: 'PATCH', json: { parentId } }),
        undefined,
        'Module moved',
      ),
    onRunModule: (m) =>
      openRunDialog({
        applicationId: app!.id,
        scope: { type: 'module', id: m.id },
        label: `Run module "${m.name}" and its sub-modules`,
      }),
    onMoveScenarios: (ids, moduleId) =>
      bulk(
        { action: 'move', ids, moduleId },
        ids.length > 1 ? `Moved ${ids.length} scenarios` : 'Scenario moved',
      ),
  };

  const onBulk = (a: BulkAction) => {
    const ids = [...checked];
    if (a.action === 'delete')
      return setConfirm({ kind: 'scenarios', ids, label: `${ids.length} scenarios` });
    if (a.action === 'run') {
      return openRunDialog({
        applicationId: app!.id,
        scope: { type: 'scenarios', ids },
        label: `Run ${ids.length} selected scenario(s)`,
      });
    }
    const labels = {
      duplicate: 'Duplicated',
      move: 'Moved',
      addTag: 'Tagged',
      setStatus: 'Updated',
    } as const;
    bulk({ ...a, ids }, `${labels[a.action]} ${ids.length} scenario(s)`);
    if (a.action !== 'addTag') setChecked(new Set());
  };

  const submitPrompt = (value: string) => {
    if (!prompt || !app) return;
    if (prompt.kind === 'module') {
      exec(
        () =>
          api(`/api/applications/${app.id}/modules`, {
            method: 'POST',
            json: { name: value, parentId: prompt.parentId },
          }),
        () => setPrompt(null),
      );
    } else if (prompt.kind === 'rename') {
      exec(
        () => api(`/api/modules/${prompt.module.id}`, { method: 'PATCH', json: { name: value } }),
        () => setPrompt(null),
      );
    } else {
      exec(
        () =>
          api<ScenarioDetail>(`/api/modules/${prompt.moduleId}/scenarios`, {
            method: 'POST',
            json: { name: value },
          }),
        (r) => {
          setPrompt(null);
          select((r as ScenarioDetail).id, 'steps');
        },
        'Scenario created',
      );
    }
  };

  const confirmDelete = () => {
    if (!confirm) return;
    if (confirm.kind === 'module') {
      exec(
        () => api(`/api/modules/${confirm.module.id}`, { method: 'DELETE' }),
        () => setConfirm(null),
        'Module deleted',
      );
    } else {
      const ids = confirm.ids;
      exec(
        () =>
          api(`/api/applications/${app!.id}/scenarios/bulk`, {
            method: 'POST',
            json: { action: 'delete', ids },
          }),
        () => {
          setConfirm(null);
          setChecked((c) => new Set([...c].filter((x) => !ids.includes(x))));
          if (selectedId && ids.includes(selectedId)) select(null);
        },
        'Deleted',
      );
    }
  };

  if (apps.isPending) return <Skeleton className="h-96" />;
  if (apps.isError) return <ErrorState error={apps.error} onRetry={() => apps.refetch()} />;
  if (!app) {
    return (
      <EmptyState
        icon={AppWindow}
        title="No application selected"
        description="Create an application first; its modules, scenarios and test cases live here."
        action={
          <Link to="/applications">
            <Button>Go to Applications</Button>
          </Link>
        }
      />
    );
  }

  const filtering = hasFilters(filters);
  return (
    <div className="flex h-[calc(100vh-7.5rem)] gap-5">
      <Card className="flex w-[360px] shrink-0 flex-col overflow-hidden">
        <div className="space-y-2 border-b border-border p-3">
          <div className="flex items-center justify-between">
            <h1 className="flex items-center gap-2 text-sm font-semibold">
              <FolderTree className="h-4 w-4 text-brand" /> {app.name}
            </h1>
            <Button variant="ghost" size="sm" onClick={() => setPrompt({ kind: 'module', parentId: null })}>
              <FolderPlus className="h-3.5 w-3.5" /> Module
            </Button>
          </div>
          <div className="flex gap-1.5">
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute top-2.5 left-2.5 h-3.5 w-3.5 text-muted" />
              <Input
                aria-label="Search the test tree"
                className="h-8 pl-8 text-xs"
                placeholder="Search modules, scenarios, TC codes…"
                value={filters.q}
                onChange={(e) => setFilters({ ...filters, q: e.target.value })}
              />
            </div>
            <Button
              variant={showFilters || filtering ? 'secondary' : 'ghost'}
              size="sm"
              aria-label="Filters"
              aria-expanded={showFilters}
              onClick={() => setShowFilters((v) => !v)}
            >
              <ListFilter className="h-3.5 w-3.5" />
            </Button>
          </div>
          {showFilters && (
            <div className="grid grid-cols-2 gap-1.5">
              <Select
                aria-label="Filter by priority"
                className="h-8 text-xs"
                value={filters.priority}
                onChange={(e) => setFilters({ ...filters, priority: e.target.value })}
              >
                <option value="">Any priority</option>
                {['P1', 'P2', 'P3', 'P4'].map((p) => (
                  <option key={p}>{p}</option>
                ))}
              </Select>
              <Select
                aria-label="Filter by layer"
                className="h-8 text-xs"
                value={filters.kind}
                onChange={(e) => setFilters({ ...filters, kind: e.target.value })}
              >
                <option value="">Any layer</option>
                {['ui', 'api', 'db', 'email', 'perf', 'hybrid'].map((k) => (
                  <option key={k}>{k}</option>
                ))}
              </Select>
              <Select
                aria-label="Filter by status"
                className="h-8 text-xs"
                value={filters.status}
                onChange={(e) => setFilters({ ...filters, status: e.target.value })}
              >
                <option value="">Any status</option>
                {['draft', 'ready', 'deprecated'].map((k) => (
                  <option key={k}>{k}</option>
                ))}
              </Select>
              <Select
                aria-label="Filter by tag"
                className="h-8 text-xs"
                value={filters.tagId}
                onChange={(e) => setFilters({ ...filters, tagId: e.target.value })}
              >
                <option value="">Any tag</option>
                {tags.data?.map((t) => (
                  <option key={t.id} value={t.id}>
                    #{t.name}
                  </option>
                ))}
              </Select>
              {filtering && (
                <button
                  className="col-span-2 flex items-center justify-center gap-1 text-xs text-muted hover:text-fg"
                  onClick={() => setFilters(EMPTY_FILTERS)}
                >
                  <X className="h-3 w-3" /> Clear filters
                </button>
              )}
            </div>
          )}
        </div>
        <div className="flex-1 overflow-y-auto p-2">
          {tree.isPending && (
            <div className="space-y-2 p-2">
              {[0, 1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-6" />
              ))}
            </div>
          )}
          {tree.isError && <ErrorState error={tree.error} onRetry={() => tree.refetch()} />}
          {tree.data && tree.data.modules.length === 0 && (
            <div className="p-4 text-center text-sm text-muted">
              <p>No modules yet.</p>
              <Button
                className="mt-3"
                size="sm"
                onClick={() => setPrompt({ kind: 'module', parentId: null })}
              >
                <FolderPlus className="h-3.5 w-3.5" /> Create the first module
              </Button>
            </div>
          )}
          {tree.data && tree.data.modules.length > 0 && filtering && nodes.length === 0 && (
            <p className="p-4 text-center text-sm text-muted">Nothing matches these filters.</p>
          )}
          {tree.data && tree.data.modules.length > 0 && (
            <TreeView
              nodes={nodes}
              selectedId={selectedId}
              checked={checked}
              lastResults={lastResults.data ?? {}}
              forceExpand={filtering}
              onToggleCheck={(id) =>
                setChecked((c) => {
                  const n = new Set(c);
                  if (n.has(id)) n.delete(id);
                  else n.add(id);
                  return n;
                })
              }
              actions={actions}
            />
          )}
        </div>
        {checked.size > 0 && (
          <div className="border-t border-border p-2">
            <BulkBar
              count={checked.size}
              tags={tags.data ?? []}
              modules={moduleOptions}
              onAction={onBulk}
              onClear={() => setChecked(new Set())}
            />
          </div>
        )}
      </Card>

      <div className="min-w-0 flex-1 overflow-y-auto pr-1">
        {selectedId && tree.data ? (
          <ScenarioPanel
            id={selectedId}
            tree={tree.data}
            tab={search.tab ?? 'steps'}
            onTab={(t) => select(selectedId, t)}
            onDuplicate={() => actions.onDuplicateScenario(selectedId)}
            onDelete={() => {
              const s = tree.data!.scenarios.find((x) => x.id === selectedId);
              if (s) actions.onDeleteScenario(s);
            }}
          />
        ) : (
          <EmptyState
            icon={MousePointerClick}
            title="Select a scenario"
            description="Pick a scenario in the tree to edit its steps, test cases, details and history. Drag scenarios onto modules to move them; drag modules to nest them."
          />
        )}
      </div>

      {prompt && (
        <PromptDialog
          title={
            prompt.kind === 'scenario'
              ? 'New scenario'
              : prompt.kind === 'rename'
                ? 'Rename module'
                : prompt.parentId
                  ? 'New sub-module'
                  : 'New module'
          }
          label="Name"
          initial={prompt.kind === 'rename' ? prompt.module.name : ''}
          placeholder={prompt.kind === 'scenario' ? 'e.g. Register a new patient' : 'e.g. Patients'}
          confirmLabel={prompt.kind === 'rename' ? 'Rename' : 'Create'}
          busy={run.isPending}
          onClose={() => setPrompt(null)}
          onSubmit={submitPrompt}
        />
      )}
      <ConfirmDialog
        open={!!confirm}
        onClose={() => setConfirm(null)}
        title={
          confirm?.kind === 'module'
            ? `Delete module "${confirm.module.name}"?`
            : `Delete ${confirm?.kind === 'scenarios' ? confirm.label : ''}?`
        }
        description={
          confirm?.kind === 'module'
            ? `This also deletes its sub-modules and ${confirm.module.total} scenario(s) with their steps and test cases.`
            : 'Steps, test cases and version history are deleted. Past run results are kept.'
        }
        busy={run.isPending}
        onConfirm={confirmDelete}
      />
    </div>
  );
}
