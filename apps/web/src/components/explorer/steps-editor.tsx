import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ListPlus, Save, Undo2 } from 'lucide-react';
import { lazy, Suspense, useMemo, useState } from 'react';
import { EditorProvider } from '@/components/editor/context';
import { fromDrafts, toDrafts, type DraftStep } from '@/components/editor/drafts';
import { PlainView } from '@/components/editor/plain-view';
import { StepList } from '@/components/editor/step-list';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/ui/states';
import { toast, toastError } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { qk } from '@/lib/queries';
import type { ScenarioDetail, StepRecord } from '@/lib/types';
import { cn } from '@/lib/utils';

type View = 'list' | 'flow' | 'plain';
const FlowView = lazy(() => import('@/components/editor/flow-view').then((m) => ({ default: m.FlowView })));

/** Editable step list with save/discard and list / flow / plain-English views. */
export function StepsEditor({ scenario }: { scenario: ScenarioDetail }) {
  return (
    <EditorProvider applicationId={scenario.applicationId} selfId={scenario.id}>
      <StepsWorkbench
        initial={scenario.steps}
        title={scenario.name}
        saveLabel="Save steps"
        save={(steps) =>
          api<ScenarioDetail>(`/api/scenarios/${scenario.id}/steps`, { method: 'PUT', json: { steps } })
        }
        onSaved={(qc, s) => {
          const detail = s as ScenarioDetail;
          qc.setQueryData(qk.scenario(detail.id), detail);
          qc.invalidateQueries({ queryKey: qk.tree(detail.applicationId) });
          qc.invalidateQueries({ queryKey: qk.versions(detail.id) });
          toast(`Saved steps · v${detail.version}`);
        }}
      />
    </EditorProvider>
  );
}

export function StepsWorkbench({
  initial,
  title,
  save,
  onSaved,
  saveLabel,
}: {
  initial: StepRecord[];
  title?: string;
  save: (steps: StepRecord[]) => Promise<unknown>;
  onSaved: (qc: ReturnType<typeof useQueryClient>, result: unknown) => void;
  saveLabel: string;
}) {
  const original = useMemo(() => toDrafts(initial), [initial]);
  const [steps, setSteps] = useState<DraftStep[]>(original);
  const [view, setView] = useState<View>('list');
  const [open, setOpen] = useState<string | null>(null);
  const qc = useQueryClient();
  const dirty = JSON.stringify(fromDrafts(steps)) !== JSON.stringify(fromDrafts(original));
  const mutation = useMutation({
    mutationFn: () => save(fromDrafts(steps)),
    onSuccess: (r) => onSaved(qc, r),
    onError: toastError,
  });

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div
          className="inline-flex rounded-lg border border-border bg-bg p-0.5"
          role="tablist"
          aria-label="Step views"
        >
          {(['list', 'flow', 'plain'] as const).map((v) => (
            <button
              key={v}
              role="tab"
              aria-selected={view === v}
              onClick={() => setView(v)}
              className={cn(
                'rounded-md px-3 py-1 text-xs',
                view === v ? 'bg-surface text-fg shadow-sm' : 'text-muted hover:text-fg',
              )}
            >
              {v === 'list' ? 'List' : v === 'flow' ? 'Flow' : 'Plain English'}
            </button>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-2">
          {dirty && <span className="text-xs text-warn">Unsaved changes</span>}
          <Button variant="ghost" size="sm" disabled={!dirty} onClick={() => setSteps(original)}>
            <Undo2 className="h-3.5 w-3.5" /> Discard
          </Button>
          <Button size="sm" disabled={!dirty || mutation.isPending} onClick={() => mutation.mutate()}>
            <Save className="h-3.5 w-3.5" /> {saveLabel}
          </Button>
        </div>
      </div>
      {view === 'list' &&
        (steps.length === 0 ? (
          <>
            <EmptyState
              icon={ListPlus}
              title="No steps yet"
              description="Record them with the Recorder, or add UI, API, database, email, performance and utility steps by hand."
            />
            <StepList steps={steps} onChange={setSteps} openKey={open} onOpen={setOpen} />
          </>
        ) : (
          <StepList steps={steps} onChange={setSteps} openKey={open} onOpen={setOpen} />
        ))}
      {view === 'flow' && (
        <Suspense fallback={<Skeleton className="h-[560px]" />}>
          <FlowView
            steps={steps}
            onSelect={(k) => {
              setOpen(k);
              setView('list');
            }}
          />
        </Suspense>
      )}
      {view === 'plain' && <PlainView steps={fromDrafts(steps)} title={title} />}
    </div>
  );
}
