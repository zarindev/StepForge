import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Blocks, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { EditorProvider } from '@/components/editor/context';
import { PromptDialog } from '@/components/explorer/prompt-dialog';
import { StepsWorkbench } from '@/components/explorer/steps-editor';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/ui/states';
import { toast, toastError } from '@/components/ui/toast';
import { api } from '@/lib/api';
import type { Application, StepRecord } from '@/lib/types';
import { cn } from '@/lib/utils';

type BlockSummary = { id: string; name: string; description: string; stepCount: number };
type BlockDetail = BlockSummary & { applicationId: string; steps: StepRecord[]; updatedAt: string };

/** Reusable step groups ("Login as Admin") used in scenarios via util.useBlock. */
export function BlocksTab({ app }: { app: Application }) {
  const qc = useQueryClient();
  const list = useQuery({
    queryKey: ['blocks', app.id],
    queryFn: () => api<BlockSummary[]>(`/api/applications/${app.id}/blocks`),
  });
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const current = selected ?? list.data?.[0]?.id ?? null;
  const detail = useQuery({
    queryKey: ['block', current],
    queryFn: () => api<BlockDetail>(`/api/blocks/${current}`),
    enabled: !!current,
  });

  const create = useMutation({
    mutationFn: (name: string) =>
      api<BlockDetail>(`/api/applications/${app.id}/blocks`, { method: 'POST', json: { name } }),
    onSuccess: (b) => {
      qc.invalidateQueries({ queryKey: ['blocks', app.id] });
      setSelected(b.id);
      setCreating(false);
    },
    onError: toastError,
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/api/blocks/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['blocks', app.id] });
      setSelected(null);
    },
    onError: toastError,
  });

  if (list.isPending) return <Skeleton className="h-40" />;
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted">
          Reusable step groups. Add them to any scenario with a “util.useBlock” step.
        </p>
        <Button size="sm" onClick={() => setCreating(true)}>
          <Plus className="h-3.5 w-3.5" /> New block
        </Button>
      </div>
      {list.data?.length === 0 ? (
        <EmptyState
          icon={Blocks}
          title="No blocks yet"
          description="Create a block such as “Login as Admin” once and reuse it across scenarios."
        />
      ) : (
        <div className="grid gap-4 lg:grid-cols-[240px_1fr]">
          <Card className="h-fit p-1.5">
            {list.data?.map((b) => (
              <button
                key={b.id}
                onClick={() => setSelected(b.id)}
                className={cn(
                  'flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-sm hover:bg-fg/[0.04]',
                  current === b.id && 'bg-brand/10',
                )}
              >
                <span className="truncate">{b.name}</span>
                <span className="text-xs text-muted">{b.stepCount}</span>
              </button>
            ))}
          </Card>
          <Card className="p-4">
            {detail.data && (
              <>
                <div className="mb-3 flex items-center justify-between">
                  <h3 className="font-semibold">{detail.data.name}</h3>
                  <Button variant="ghost" size="sm" onClick={() => remove.mutate(detail.data.id)}>
                    <Trash2 className="h-3.5 w-3.5" /> Delete block
                  </Button>
                </div>
                <EditorProvider applicationId={app.id}>
                  <StepsWorkbench
                    key={`${detail.data.id}:${detail.data.updatedAt}`}
                    initial={detail.data.steps}
                    title={detail.data.name}
                    saveLabel="Save block"
                    save={(steps) =>
                      api(`/api/blocks/${detail.data.id}/steps`, { method: 'PUT', json: { steps } })
                    }
                    onSaved={(client) => {
                      client.invalidateQueries({ queryKey: ['block', detail.data.id] });
                      client.invalidateQueries({ queryKey: ['blocks', app.id] });
                      toast('Block saved');
                    }}
                  />
                </EditorProvider>
              </>
            )}
          </Card>
        </div>
      )}
      {creating && (
        <PromptDialog
          title="New block"
          label="Name"
          placeholder="Login as Admin"
          busy={create.isPending}
          onClose={() => setCreating(false)}
          onSubmit={(n) => create.mutate(n)}
        />
      )}
    </div>
  );
}
