import { Copy, Play, Trash2 } from 'lucide-react';
import { Badge, PRIORITY_TONE, STATUS_TONE } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorState } from '@/components/ui/states';
import { Tabs } from '@/components/ui/tabs';
import { useScenario } from '@/lib/queries';
import { modulePath } from '@/lib/tree';
import type { Tree } from '@/lib/types';
import { HistoryTab } from './history-tab';
import { OverviewTab } from './overview-tab';
import { StepsEditor } from './steps-editor';
import { TestCasesTab } from './test-cases-tab';
import { KindIcon } from './tree-view';

export type PanelTab = 'steps' | 'testCases' | 'overview' | 'history';

export function ScenarioPanel({
  id,
  tree,
  tab,
  onTab,
  onDuplicate,
  onDelete,
}: {
  id: string;
  tree: Tree;
  tab: PanelTab;
  onTab: (t: PanelTab) => void;
  onDuplicate: () => void;
  onDelete: () => void;
}) {
  const scenario = useScenario(id);
  if (scenario.isError) return <ErrorState error={scenario.error} onRetry={() => scenario.refetch()} />;
  if (scenario.isPending) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-8 w-1/2" />
        <Skeleton className="h-4 w-1/3" />
        <Skeleton className="h-48" />
      </div>
    );
  }
  const s = scenario.data;
  // Remount editors when the version changes so drafts reset to what was saved.
  const k = `${s.id}:${s.version}`;
  return (
    <div>
      <p className="mb-1 text-xs text-muted">{modulePath(tree, s.moduleId).join(' / ')}</p>
      <div className="mb-4 flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="flex items-center gap-2 text-lg font-semibold">
            <KindIcon kind={s.kind} className="h-4 w-4" /> {s.name}
          </h2>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <Badge tone={PRIORITY_TONE[s.priority]}>{s.priority}</Badge>
            <Badge tone={STATUS_TONE[s.status]}>{s.status}</Badge>
            <Badge>{s.kind}</Badge>
            <Badge className="font-mono">v{s.version}</Badge>
            {s.owner && <span className="text-xs text-muted">· owner {s.owner}</span>}
          </div>
        </div>
        <div className="flex gap-2">
          <Button
            variant="ghost"
            size="icon"
            aria-label="Duplicate scenario"
            title="Duplicate"
            onClick={onDuplicate}
          >
            <Copy className="h-4 w-4" />
          </Button>
          <Button variant="ghost" size="icon" aria-label="Delete scenario" title="Delete" onClick={onDelete}>
            <Trash2 className="h-4 w-4" />
          </Button>
          <Button size="sm" disabled title="The runner arrives in Phase 3">
            <Play className="h-3.5 w-3.5 fill-current" /> Run
          </Button>
        </div>
      </div>
      <Tabs
        className="mb-4"
        value={tab}
        onChange={onTab}
        tabs={[
          { value: 'steps', label: 'Steps', count: s.steps.length },
          { value: 'testCases', label: 'Test cases', count: s.testCases.length },
          { value: 'overview', label: 'Details' },
          { value: 'history', label: 'History' },
        ]}
      />
      {tab === 'steps' && <StepsEditor key={k} scenario={s} />}
      {tab === 'testCases' && <TestCasesTab scenario={s} />}
      {tab === 'overview' && <OverviewTab key={k} scenario={s} />}
      {tab === 'history' && <HistoryTab key={k} scenario={s} />}
    </div>
  );
}
