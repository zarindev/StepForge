import type { Locator } from '@stepforge/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Crosshair, Plus, Save, Trash2 } from 'lucide-react';
import { useState } from 'react';
import type { ElementOption } from '@/components/editor/context';
import { LocatorEditor } from '@/components/editor/locator-editor';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/ui/states';
import { toast, toastError } from '@/components/ui/toast';
import { api } from '@/lib/api';
import type { Application } from '@/lib/types';
import { cn } from '@/lib/utils';

type ElementUsage = {
  scenarios: { id: string; name: string; steps: number }[];
  blocks: { id: string; name: string; steps: number }[];
  steps: number;
};

/**
 * The element repository: named UI elements ("Save patient button") that steps point at. A step that uses an
 * element runs with the element's current locators, so fixing the element fixes every step that uses it.
 */
export function ElementsTab({ app, initialElement }: { app: Application; initialElement?: string }) {
  const qc = useQueryClient();
  const list = useQuery({
    queryKey: ['elements', app.id],
    queryFn: () => api<ElementOption[]>(`/api/applications/${app.id}/elements`),
  });
  const [selected, setSelected] = useState<string | null>(initialElement ?? null);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const current = list.data?.find((e) => e.id === selected) ?? list.data?.[0] ?? null;
  const usage = useQuery({
    queryKey: ['element', current?.id, 'usage'],
    queryFn: () => api<ElementUsage>(`/api/elements/${current!.id}/usage`),
    enabled: !!current,
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ['elements', app.id] });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/api/elements/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      void refresh();
      setSelected(null);
      setDeleting(false);
    },
    onError: toastError,
  });

  if (list.isPending) return <Skeleton className="h-40" />;
  const pages = [...new Set((list.data ?? []).map((e) => e.page || 'Other'))];
  const u = usage.data;
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <p className="text-sm text-muted">
          Named elements shared by your steps. A step that uses an element runs with its current locators: fix
          an element once and every step follows. In a step, choose it under “Saved element”, or save a step’s
          locators as a new element. Recordings reuse an element when its best locator matches.
        </p>
        <Button size="sm" onClick={() => setCreating(true)}>
          <Plus className="h-3.5 w-3.5" /> New element
        </Button>
      </div>
      {list.data?.length === 0 ? (
        <EmptyState
          icon={Crosshair}
          title="No saved elements yet"
          description="Create one here, or open a step and choose “Save as element” to share its locators."
        />
      ) : (
        <div className="grid gap-4 lg:grid-cols-[280px_1fr]">
          <Card className="h-fit p-1.5" aria-label="Elements">
            {pages.map((p) => (
              <div key={p} className="mb-1">
                <p className="px-3 pt-2 pb-1 text-[11px] font-medium tracking-wide text-muted uppercase">
                  {p}
                </p>
                {list
                  .data!.filter((e) => (e.page || 'Other') === p)
                  .map((e) => (
                    <button
                      key={e.id}
                      onClick={() => setSelected(e.id)}
                      className={cn(
                        'flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-fg/[0.04]',
                        current?.id === e.id && 'bg-brand/10',
                      )}
                    >
                      <span className="flex-1 truncate">{e.name}</span>
                      <Badge tone={e.usedBySteps ? 'indigo' : 'skip'} className="shrink-0">
                        {e.usedBySteps} step{e.usedBySteps === 1 ? '' : 's'}
                      </Badge>
                    </button>
                  ))}
              </div>
            ))}
          </Card>
          {current && (
            <Card className="space-y-4 p-4">
              <ElementEditor
                key={`${current.id}:${current.locatorsJson.length}:${current.name}`}
                element={current}
                onSaved={refresh}
                onDelete={() => setDeleting(true)}
              />
              {u && (
                <section
                  aria-label="Where this element is used"
                  className="rounded-lg border border-border p-3"
                >
                  <p className="text-sm font-medium" data-testid="element-affected">
                    {u.steps
                      ? `Used by ${u.steps} step${u.steps === 1 ? '' : 's'} — a change here applies to all of them`
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
                            {s.steps > 1 && ` ×${s.steps}`}
                          </Link>
                        </li>
                      ))}
                      {u.blocks.map((b) => (
                        <li key={b.id}>
                          <Link
                            to="/applications/$appId"
                            params={{ appId: app.id }}
                            search={{ tab: 'blocks', block: b.id }}
                            className="inline-flex rounded-md bg-indigo/10 px-2 py-1 hover:bg-indigo/20"
                          >
                            block: {b.name}
                          </Link>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              )}
            </Card>
          )}
        </div>
      )}
      {creating && (
        <NewElementDialog
          applicationId={app.id}
          onClose={() => setCreating(false)}
          onCreated={(e) => {
            void refresh();
            setSelected(e.id);
            setCreating(false);
          }}
        />
      )}
      <ConfirmDialog
        open={deleting && !!current}
        onClose={() => setDeleting(false)}
        title={`Delete element "${current?.name ?? ''}"?`}
        description={
          u?.steps
            ? `${u.steps} step(s) use it (${[...u.scenarios.map((s) => s.name), ...u.blocks.map((b) => `block ${b.name}`)].join(', ')}). They will stop with "element deleted" until you choose another element or detach them first.`
            : 'No step uses this element.'
        }
        busy={remove.isPending}
        onConfirm={() => current && remove.mutate(current.id)}
      />
    </div>
  );
}

function ElementEditor({
  element,
  onSaved,
  onDelete,
}: {
  element: ElementOption;
  onSaved: () => void;
  onDelete: () => void;
}) {
  const [name, setName] = useState(element.name);
  const [page, setPage] = useState(element.page);
  const [description, setDescription] = useState(element.description);
  const [locators, setLocators] = useState<Locator[]>(element.locatorsJson);
  const dirty =
    name !== element.name ||
    page !== element.page ||
    description !== element.description ||
    JSON.stringify(locators) !== JSON.stringify(element.locatorsJson);
  const save = useMutation({
    mutationFn: () =>
      api(`/api/elements/${element.id}`, { method: 'PATCH', json: { name, page, description, locators } }),
    onSuccess: () => {
      toast(
        element.usedBySteps
          ? `Element saved — ${element.usedBySteps} step${element.usedBySteps === 1 ? '' : 's'} use the change`
          : 'Element saved',
      );
      onSaved();
    },
    onError: toastError,
  });
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 font-semibold">
          <Crosshair className="h-4 w-4 text-brand" /> {element.name}
        </h3>
        <div className="flex gap-2">
          <Button variant="ghost" size="sm" onClick={onDelete}>
            <Trash2 className="h-3.5 w-3.5" /> Delete element
          </Button>
          <Button
            size="sm"
            disabled={!dirty || !name.trim() || !locators.length || save.isPending}
            onClick={() => save.mutate()}
          >
            <Save className="h-3.5 w-3.5" /> Save element
          </Button>
        </div>
      </div>
      <div className="grid gap-3 md:grid-cols-3">
        <Field label="Name">
          <Input aria-label="Element name" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Page">
          <Input aria-label="Element page" value={page} onChange={(e) => setPage(e.target.value)} />
        </Field>
        <Field label="Description">
          <Input
            aria-label="Element description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </Field>
      </div>
      <div className="space-y-1.5">
        <span className="text-xs font-medium text-muted">
          Ranked locators — the first is used, the others heal it when the page changes
        </span>
        <LocatorEditor value={locators} onChange={setLocators} />
      </div>
    </div>
  );
}

function NewElementDialog({
  applicationId,
  onClose,
  onCreated,
}: {
  applicationId: string;
  onClose: () => void;
  onCreated: (e: ElementOption) => void;
}) {
  const [name, setName] = useState('');
  const [page, setPage] = useState('');
  const [locators, setLocators] = useState<Locator[]>([{ strategy: 'testId', value: '' }]);
  const valid = name.trim() && locators.length > 0 && locators.every((l) => l.value.trim());
  const create = useMutation({
    mutationFn: () =>
      api<ElementOption>(`/api/applications/${applicationId}/elements`, {
        method: 'POST',
        json: { name, page, locators },
      }),
    onSuccess: onCreated,
    onError: toastError,
  });
  return (
    <Dialog
      open
      onClose={onClose}
      title="New element"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!valid || create.isPending} onClick={() => create.mutate()}>
            Create element
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="grid gap-3 md:grid-cols-2">
          <Field label="Name">
            <Input
              autoFocus
              aria-label="Element name"
              value={name}
              placeholder="Save patient button"
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          <Field label="Page (optional)">
            <Input
              aria-label="Element page"
              value={page}
              placeholder="New patient"
              onChange={(e) => setPage(e.target.value)}
            />
          </Field>
        </div>
        <LocatorEditor value={locators} onChange={setLocators} />
      </div>
    </Dialog>
  );
}
