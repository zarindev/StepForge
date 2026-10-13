import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Blocks, Plus, Save, Trash2, X } from 'lucide-react';
import { useState } from 'react';
import { EditorProvider } from '@/components/editor/context';
import { PromptDialog } from '@/components/explorer/prompt-dialog';
import { StepsWorkbench } from '@/components/explorer/steps-editor';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm';
import { Field, Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/ui/states';
import { toast, toastError } from '@/components/ui/toast';
import { api } from '@/lib/api';
import type { Application, StepRecord } from '@/lib/types';
import { cn } from '@/lib/utils';

type InputDef = { name: string; default?: string; description?: string };
type BlockSummary = {
  id: string;
  name: string;
  description: string;
  stepCount: number;
  usedBy: number;
  inputsJson: InputDef[];
};
type BlockDetail = Omit<BlockSummary, 'stepCount' | 'usedBy'> & {
  applicationId: string;
  steps: StepRecord[];
  updatedAt: string;
};
type BlockUsage = {
  scenarios: { id: string; name: string; uses: number; setup: boolean; teardown: boolean }[];
  blocks: { id: string; name: string; uses: number }[];
  affectedScenarios: number;
};

/**
 * Reusable step groups ("Sign in") used in scenarios via util.useBlock. A block runs fresh in every test that uses
 * it, so fixing it here fixes all of them; the usage list shows what a change affects.
 */
export function BlocksTab({ app, initialBlock }: { app: Application; initialBlock?: string }) {
  const qc = useQueryClient();
  const list = useQuery({
    queryKey: ['blocks', app.id],
    queryFn: () => api<BlockSummary[]>(`/api/applications/${app.id}/blocks`),
  });
  const [selected, setSelected] = useState<string | null>(initialBlock ?? null);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const current = selected ?? list.data?.[0]?.id ?? null;
  const detail = useQuery({
    queryKey: ['block', current],
    queryFn: () => api<BlockDetail>(`/api/blocks/${current}`),
    enabled: !!current,
  });
  const usage = useQuery({
    queryKey: ['block', current, 'usage'],
    queryFn: () => api<BlockUsage>(`/api/blocks/${current}/usage`),
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
      setDeleting(false);
    },
    onError: toastError,
  });

  if (list.isPending) return <Skeleton className="h-40" />;
  const u = usage.data;
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted">
          Reusable step groups. A block runs fresh in every test that uses it: fix it once and they are all
          fixed. Turn existing steps into a block from the scenario editor (select steps → Make a block).
        </p>
        <Button size="sm" onClick={() => setCreating(true)}>
          <Plus className="h-3.5 w-3.5" /> New block
        </Button>
      </div>
      {list.data?.length === 0 ? (
        <EmptyState
          icon={Blocks}
          title="No blocks yet"
          description="Create a block such as “Sign in” once and reuse it across scenarios, or select steps in a scenario and choose “Make a block”."
        />
      ) : (
        <div className="grid gap-4 lg:grid-cols-[260px_1fr]">
          <Card className="h-fit p-1.5" aria-label="Blocks">
            {list.data?.map((b) => (
              <button
                key={b.id}
                onClick={() => setSelected(b.id)}
                className={cn(
                  'flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-fg/[0.04]',
                  current === b.id && 'bg-brand/10',
                )}
              >
                <span className="flex-1 truncate">{b.name}</span>
                <span className="text-xs text-muted" title={`${b.stepCount} steps`}>
                  {b.stepCount}
                </span>
                <Badge tone={b.usedBy ? 'indigo' : 'skip'} className="shrink-0">
                  used by {b.usedBy}
                </Badge>
              </button>
            ))}
          </Card>
          <Card className="space-y-4 p-4">
            {detail.data && (
              <>
                <div className="flex items-center justify-between">
                  <h3 className="font-semibold">{detail.data.name}</h3>
                  <Button variant="ghost" size="sm" onClick={() => setDeleting(true)}>
                    <Trash2 className="h-3.5 w-3.5" /> Delete block
                  </Button>
                </div>
                {u && (
                  <section
                    aria-label="Where this block is used"
                    className="rounded-lg border border-border p-3"
                  >
                    <p className="text-sm font-medium" data-testid="block-affected">
                      {u.affectedScenarios
                        ? `A change here affects ${u.affectedScenarios} scenario${u.affectedScenarios === 1 ? '' : 's'}`
                        : 'Not used yet'}
                    </p>
                    {(u.scenarios.length > 0 || u.blocks.length > 0) && (
                      <ul className="mt-2 flex flex-wrap gap-1.5 text-xs">
                        {u.scenarios.map((s) => (
                          <li key={s.id}>
                            <Link
                              to="/explorer"
                              search={{ scenario: s.id }}
                              className="inline-flex rounded-md bg-fg/5 px-2 py-1 hover:bg-fg/10"
                            >
                              {s.name}
                              {s.uses > 1 && ` ×${s.uses}`}
                            </Link>
                          </li>
                        ))}
                        {u.blocks.map((b) => (
                          <li key={b.id}>
                            <button
                              onClick={() => setSelected(b.id)}
                              className="inline-flex rounded-md bg-indigo/10 px-2 py-1 hover:bg-indigo/20"
                            >
                              block: {b.name}
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </section>
                )}
                <InputsEditor
                  key={`inputs:${detail.data.id}:${detail.data.updatedAt}`}
                  block={detail.data}
                  onSaved={() => {
                    qc.invalidateQueries({ queryKey: ['block', detail.data.id] });
                    qc.invalidateQueries({ queryKey: ['blocks', app.id] });
                  }}
                />
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
                      toast(
                        u?.affectedScenarios
                          ? `Block saved — ${u.affectedScenarios} scenario${u.affectedScenarios === 1 ? '' : 's'} use the change`
                          : 'Block saved',
                      );
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
          placeholder="Sign in"
          busy={create.isPending}
          onClose={() => setCreating(false)}
          onSubmit={(n) => create.mutate(n)}
        />
      )}
      <ConfirmDialog
        open={deleting && !!detail.data}
        onClose={() => setDeleting(false)}
        title={`Delete block "${detail.data?.name ?? ''}"?`}
        description={
          u?.affectedScenarios
            ? `${u.affectedScenarios} scenario(s) use it (${[...(u.scenarios ?? []).map((s) => s.name), ...(u.blocks ?? []).map((b) => `block ${b.name}`)].join(', ')}). Their "use block" steps will fail until you choose another block.`
            : 'No scenario uses this block.'
        }
        busy={remove.isPending}
        onConfirm={() => detail.data && remove.mutate(detail.data.id)}
      />
    </div>
  );
}

/** The block's inputs: each use passes a value (or the default); inside the block they are {{vars.<name>}}. */
function InputsEditor({ block, onSaved }: { block: BlockDetail; onSaved: () => void }) {
  const [rows, setRows] = useState<InputDef[]>(block.inputsJson ?? []);
  const dirty = JSON.stringify(rows) !== JSON.stringify(block.inputsJson ?? []);
  const save = useMutation({
    mutationFn: () =>
      api(`/api/blocks/${block.id}`, {
        method: 'PATCH',
        json: {
          inputs: rows
            .filter((r) => r.name.trim())
            .map((r) => ({
              name: r.name.trim(),
              ...(r.default !== undefined && r.default !== '' && { default: r.default }),
              ...(r.description && { description: r.description }),
            })),
        },
      }),
    onSuccess: () => {
      toast('Inputs saved');
      onSaved();
    },
    onError: toastError,
  });
  const update = (i: number, patch: Partial<InputDef>) =>
    setRows((r) => r.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  return (
    <section aria-label="Block inputs" className="space-y-2 rounded-lg border border-border p-3">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-medium">Inputs</p>
          <p className="text-xs text-muted">
            Values each use passes in (e.g. a different user per test). Inside the block write{' '}
            <code>{'{{vars.<name>}}'}</code>. Leave the default empty to make an input required.
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setRows((r) => [...r, { name: '' }])}
            aria-label="Add input"
          >
            <Plus className="h-3.5 w-3.5" /> Input
          </Button>
          <Button size="sm" disabled={!dirty || save.isPending} onClick={() => save.mutate()}>
            <Save className="h-3.5 w-3.5" /> Save inputs
          </Button>
        </div>
      </div>
      {rows.length > 0 && (
        <ul className="space-y-2">
          {rows.map((r, i) => (
            <li key={i} className="grid items-end gap-2 md:grid-cols-[1fr_1fr_2fr_auto]">
              <Field label="Name">
                <Input
                  aria-label={`Input ${i + 1} name`}
                  value={r.name}
                  placeholder="email"
                  className="font-mono"
                  onChange={(e) => update(i, { name: e.target.value })}
                />
              </Field>
              <Field label="Default">
                <Input
                  aria-label={`Input ${i + 1} default`}
                  value={r.default ?? ''}
                  placeholder="(required)"
                  onChange={(e) => update(i, { default: e.target.value || undefined })}
                />
              </Field>
              <Field label="Description">
                <Input
                  aria-label={`Input ${i + 1} description`}
                  value={r.description ?? ''}
                  onChange={(e) => update(i, { description: e.target.value || undefined })}
                />
              </Field>
              <Button
                variant="ghost"
                size="icon"
                aria-label={`Remove input ${r.name || i + 1}`}
                onClick={() => setRows((x) => x.filter((_, j) => j !== i))}
              >
                <X className="h-4 w-4" />
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
