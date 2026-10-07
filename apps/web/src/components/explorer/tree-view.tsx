import {
  ChevronRight,
  Copy,
  Disc3,
  FilePlus2,
  Folder,
  FolderInput,
  FolderOpen,
  FolderPlus,
  Layers,
  MoreHorizontal,
  Pencil,
  Play,
  Trash2,
} from 'lucide-react';
import { StatusIcon } from '@/components/runs/status';
import { useState, type DragEvent } from 'react';
import { Badge, PRIORITY_TONE } from '@/components/ui/badge';
import { Menu } from '@/components/ui/menu';
import { KIND_LAYER, LAYER } from '@/lib/steps';
import type { ModuleTreeNode } from '@/lib/tree';
import type { ScenarioSummary, TestCaseSummary } from '@/lib/types';
import { cn } from '@/lib/utils';

const DND_MIME = 'application/x-stepforge';
type DragPayload = { type: 'module' | 'scenario'; id: string };

export type TreeActions = {
  onSelectScenario: (id: string, tab?: 'testCases') => void;
  onNewModule: (parentId: string | null) => void;
  onNewScenario: (moduleId: string) => void;
  /** Opens the Recorder; the recording is saved as a new scenario in this module. */
  onRecordScenario: (moduleId: string) => void;
  onRenameModule: (m: ModuleTreeNode) => void;
  onDeleteModule: (m: ModuleTreeNode) => void;
  onDuplicateScenario: (id: string) => void;
  onDeleteScenario: (s: ScenarioSummary) => void;
  onMoveModule: (id: string, parentId: string | null) => void;
  onMoveScenarios: (ids: string[], moduleId: string) => void;
  onRunModule: (m: ModuleTreeNode) => void;
  onMoveModuleTo: (m: ModuleTreeNode) => void;
};

export function KindIcon({ kind, className }: { kind: string; className?: string }) {
  const layer = KIND_LAYER[kind];
  if (!layer || layer === 'hybrid')
    return <Layers className={cn('h-3.5 w-3.5 text-brand', className)} aria-label="Hybrid" />;
  const L = LAYER[layer];
  return <L.icon className={cn('h-3.5 w-3.5', className)} style={{ color: L.color }} aria-label={L.label} />;
}

function readPayload(e: DragEvent): DragPayload | null {
  try {
    return JSON.parse(e.dataTransfer.getData(DND_MIME)) as DragPayload;
  } catch {
    return null;
  }
}

export function TreeView({
  nodes,
  selectedId,
  checked,
  onToggleCheck,
  forceExpand,
  actions,
  lastResults,
}: {
  nodes: ModuleTreeNode[];
  selectedId: string | null;
  lastResults: Record<string, string>;
  checked: Set<string>;
  onToggleCheck: (id: string) => void;
  forceExpand: boolean;
  actions: TreeActions;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [openScenarios, setOpenScenarios] = useState<Set<string>>(new Set());
  const [rootOver, setRootOver] = useState(false);
  const toggle = (set: Set<string>, id: string) => {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  };

  const ctx = {
    selectedId,
    lastResults,
    checked,
    onToggleCheck,
    actions,
    isCollapsed: (id: string) => !forceExpand && collapsed.has(id),
    toggleCollapsed: (id: string) => setCollapsed((c) => toggle(c, id)),
    isScenarioOpen: (id: string) => openScenarios.has(id),
    toggleScenario: (id: string) => setOpenScenarios((c) => toggle(c, id)),
  };

  return (
    <div role="tree" aria-label="Test tree" className="text-sm">
      {nodes.map((n) => (
        <ModuleRow key={n.id} node={n} depth={0} ctx={ctx} />
      ))}
      <div
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes(DND_MIME)) {
            e.preventDefault();
            setRootOver(true);
          }
        }}
        onDragLeave={() => setRootOver(false)}
        onDrop={(e) => {
          setRootOver(false);
          const p = readPayload(e);
          if (p?.type === 'module') actions.onMoveModule(p.id, null);
        }}
        className={cn(
          'mt-2 rounded-md border border-dashed border-transparent px-2 py-2 text-xs text-muted',
          rootOver && 'border-brand/50 bg-brand/5',
        )}
      >
        <button
          onClick={() => actions.onNewModule(null)}
          className="inline-flex items-center gap-1.5 hover:text-fg"
        >
          <FolderPlus className="h-3.5 w-3.5" /> New top-level module
        </button>
      </div>
    </div>
  );
}

type Ctx = {
  selectedId: string | null;
  lastResults: Record<string, string>;
  checked: Set<string>;
  onToggleCheck: (id: string) => void;
  actions: TreeActions;
  isCollapsed: (id: string) => boolean;
  toggleCollapsed: (id: string) => void;
  isScenarioOpen: (id: string) => boolean;
  toggleScenario: (id: string) => void;
};

function ModuleRow({ node, depth, ctx }: { node: ModuleTreeNode; depth: number; ctx: Ctx }) {
  const [over, setOver] = useState(false);
  const collapsed = ctx.isCollapsed(node.id);
  const pad = 8 + depth * 14;
  return (
    <div role="treeitem" aria-expanded={!collapsed} aria-label={node.name}>
      <div
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData(
            DND_MIME,
            JSON.stringify({ type: 'module', id: node.id } satisfies DragPayload),
          );
          e.dataTransfer.effectAllowed = 'move';
        }}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes(DND_MIME)) {
            e.preventDefault();
            setOver(true);
          }
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.stopPropagation();
          setOver(false);
          const p = readPayload(e);
          if (!p) return;
          if (p.type === 'module' && p.id !== node.id) ctx.actions.onMoveModule(p.id, node.id);
          if (p.type === 'scenario') {
            // Dragging a checked scenario moves the whole selection.
            const ids = ctx.checked.has(p.id) ? [...ctx.checked] : [p.id];
            ctx.actions.onMoveScenarios(ids, node.id);
          }
        }}
        className={cn(
          'group flex h-8 cursor-pointer items-center gap-1.5 rounded-md pr-1 hover:bg-fg/[0.04]',
          over && 'bg-brand/10 ring-1 ring-brand/40',
        )}
        style={{ paddingLeft: pad }}
        onClick={() => ctx.toggleCollapsed(node.id)}
      >
        <ChevronRight
          className={cn('h-3.5 w-3.5 shrink-0 text-muted transition-transform', !collapsed && 'rotate-90')}
        />
        {collapsed ? (
          <Folder className="h-4 w-4 shrink-0 text-muted" />
        ) : (
          <FolderOpen className="h-4 w-4 shrink-0 text-brand/80" />
        )}
        <span className="truncate font-medium">{node.name}</span>
        <span className="ml-1 text-[11px] text-muted tabular-nums">{node.total}</span>
        <div
          className="ml-auto opacity-0 group-hover:opacity-100 focus-within:opacity-100"
          onClick={(e) => e.stopPropagation()}
        >
          <Menu
            trigger={(t) => (
              <button
                aria-label={`Actions for ${node.name}`}
                onClick={t}
                className="rounded p-1 text-muted hover:bg-fg/10 hover:text-fg"
              >
                <MoreHorizontal className="h-3.5 w-3.5" />
              </button>
            )}
            items={[
              {
                label: 'Run module',
                icon: Play,
                onSelect: () => ctx.actions.onRunModule(node),
                disabled: node.total === 0,
              },
              { label: 'New scenario', icon: FilePlus2, onSelect: () => ctx.actions.onNewScenario(node.id) },
              {
                label: 'Record a scenario',
                icon: Disc3,
                onSelect: () => ctx.actions.onRecordScenario(node.id),
              },
              { label: 'New sub-module', icon: FolderPlus, onSelect: () => ctx.actions.onNewModule(node.id) },
              { label: 'Rename', icon: Pencil, onSelect: () => ctx.actions.onRenameModule(node) },
              { label: 'Move to…', icon: FolderInput, onSelect: () => ctx.actions.onMoveModuleTo(node) },
              {
                label: 'Delete module',
                icon: Trash2,
                danger: true,
                onSelect: () => ctx.actions.onDeleteModule(node),
              },
            ]}
          />
        </div>
      </div>
      {!collapsed && (
        <div role="group">
          {node.children.map((c) => (
            <ModuleRow key={c.id} node={c} depth={depth + 1} ctx={ctx} />
          ))}
          {node.scenarios.map((s) => (
            <ScenarioRow key={s.id} s={s} depth={depth + 1} ctx={ctx} />
          ))}
          {node.children.length === 0 && node.scenarios.length === 0 && (
            <div className="flex h-7 items-center gap-3 text-xs text-muted" style={{ paddingLeft: pad + 34 }}>
              <button
                onClick={() => ctx.actions.onNewScenario(node.id)}
                className="flex items-center gap-1.5 hover:text-fg"
              >
                <FilePlus2 className="h-3.5 w-3.5" /> Add a scenario
              </button>
              <button
                onClick={() => ctx.actions.onRecordScenario(node.id)}
                className="flex items-center gap-1.5 hover:text-fg"
              >
                <Disc3 className="h-3.5 w-3.5" /> Record one
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ScenarioRow({
  s,
  depth,
  ctx,
}: {
  s: ScenarioSummary & { testCases: TestCaseSummary[] };
  depth: number;
  ctx: Ctx;
}) {
  const selected = ctx.selectedId === s.id;
  const open = ctx.isScenarioOpen(s.id);
  const pad = 8 + depth * 14;
  return (
    <div role="treeitem" aria-label={s.name} aria-selected={selected}>
      <div
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData(
            DND_MIME,
            JSON.stringify({ type: 'scenario', id: s.id } satisfies DragPayload),
          );
          e.dataTransfer.effectAllowed = 'move';
        }}
        onClick={() => ctx.actions.onSelectScenario(s.id)}
        className={cn(
          'group flex h-8 cursor-pointer items-center gap-1.5 rounded-md pr-1 hover:bg-fg/[0.04]',
          selected && 'bg-brand/10 hover:bg-brand/12',
          s.status === 'deprecated' && 'opacity-55',
        )}
        style={{ paddingLeft: pad }}
      >
        <button
          aria-label={open ? 'Hide test cases' : 'Show test cases'}
          onClick={(e) => {
            e.stopPropagation();
            ctx.toggleScenario(s.id);
          }}
          className={cn('rounded p-0.5 text-muted hover:text-fg', s.testCases.length === 0 && 'invisible')}
        >
          <ChevronRight className={cn('h-3 w-3 transition-transform', open && 'rotate-90')} />
        </button>
        <input
          type="checkbox"
          aria-label={`Select ${s.name}`}
          checked={ctx.checked.has(s.id)}
          onClick={(e) => e.stopPropagation()}
          onChange={() => ctx.onToggleCheck(s.id)}
          className="h-3.5 w-3.5 accent-[#F97316]"
        />
        <KindIcon kind={s.kind} />
        <span className={cn('truncate', selected && 'font-medium')}>{s.name}</span>
        {ctx.lastResults[s.id] && <StatusIcon status={ctx.lastResults[s.id]!} className="h-3.5 w-3.5" />}
        <Badge tone={PRIORITY_TONE[s.priority]} className="ml-auto shrink-0">
          {s.priority}
        </Badge>
        <div
          className="opacity-0 group-hover:opacity-100 focus-within:opacity-100"
          onClick={(e) => e.stopPropagation()}
        >
          <Menu
            trigger={(t) => (
              <button
                aria-label={`Actions for ${s.name}`}
                onClick={t}
                className="rounded p-1 text-muted hover:bg-fg/10 hover:text-fg"
              >
                <MoreHorizontal className="h-3.5 w-3.5" />
              </button>
            )}
            items={[
              { label: 'Duplicate', icon: Copy, onSelect: () => ctx.actions.onDuplicateScenario(s.id) },
              {
                label: 'Delete scenario',
                icon: Trash2,
                danger: true,
                onSelect: () => ctx.actions.onDeleteScenario(s),
              },
            ]}
          />
        </div>
      </div>
      {open &&
        s.testCases.map((tc) => (
          <button
            key={tc.id}
            onClick={() => ctx.actions.onSelectScenario(s.id, 'testCases')}
            className={cn(
              'flex h-7 w-full items-center gap-2 rounded-md text-left text-xs hover:bg-fg/[0.04]',
              tc.status === 'skipped' && 'opacity-50',
            )}
            style={{ paddingLeft: pad + 44 }}
          >
            <span className="font-mono text-muted">{tc.code}</span>
            <span className="truncate">{tc.title}</span>
          </button>
        ))}
    </div>
  );
}
