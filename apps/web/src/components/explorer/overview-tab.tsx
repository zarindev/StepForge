import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Save } from 'lucide-react';
import { useState } from 'react';
import { TagChip } from '@/components/applications/tags-tab';
import { Button } from '@/components/ui/button';
import { Field, Input, Select, Textarea } from '@/components/ui/input';
import { toast, toastError } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { qk, useTags } from '@/lib/queries';
import type { ScenarioDetail } from '@/lib/types';
import { cn } from '@/lib/utils';

type Form = Pick<ScenarioDetail, 'name' | 'description' | 'priority' | 'status' | 'owner' | 'preconditions'>;

export function OverviewTab({ scenario }: { scenario: ScenarioDetail }) {
  const initial: Form = {
    name: scenario.name,
    description: scenario.description,
    priority: scenario.priority,
    status: scenario.status,
    owner: scenario.owner,
    preconditions: scenario.preconditions,
  };
  const [f, setF] = useState<Form>(initial);
  const tags = useTags(scenario.applicationId);
  const qc = useQueryClient();
  const dirty = JSON.stringify(f) !== JSON.stringify(initial);
  const set = (p: Partial<Form>) => setF((c) => ({ ...c, ...p }));
  const after = (s: ScenarioDetail) => {
    qc.setQueryData(qk.scenario(s.id), s);
    qc.invalidateQueries({ queryKey: qk.tree(s.applicationId) });
    qc.invalidateQueries({ queryKey: qk.versions(s.id) });
  };

  const save = useMutation({
    mutationFn: () => api<ScenarioDetail>(`/api/scenarios/${scenario.id}`, { method: 'PATCH', json: f }),
    onSuccess: (s) => {
      after(s);
      toast(`Saved · v${s.version}`);
    },
    onError: toastError,
  });
  const setTags = useMutation({
    mutationFn: (tagIds: string[]) =>
      api<ScenarioDetail>(`/api/scenarios/${scenario.id}/tags`, { method: 'PUT', json: { tagIds } }),
    onSuccess: after,
    onError: toastError,
  });
  const toggleTag = (id: string) =>
    setTags.mutate(
      scenario.tagIds.includes(id) ? scenario.tagIds.filter((t) => t !== id) : [...scenario.tagIds, id],
    );

  return (
    <div className="max-w-3xl space-y-4">
      <Field label="Name">
        <Input value={f.name} onChange={(e) => set({ name: e.target.value })} />
      </Field>
      <Field label="Description">
        <Textarea rows={3} value={f.description} onChange={(e) => set({ description: e.target.value })} />
      </Field>
      <div className="grid grid-cols-3 gap-3">
        <Field label="Priority">
          <Select value={f.priority} onChange={(e) => set({ priority: e.target.value as Form['priority'] })}>
            <option value="P1">P1 · Critical</option>
            <option value="P2">P2 · High</option>
            <option value="P3">P3 · Medium</option>
            <option value="P4">P4 · Low</option>
          </Select>
        </Field>
        <Field label="Status">
          <Select value={f.status} onChange={(e) => set({ status: e.target.value as Form['status'] })}>
            <option value="draft">Draft</option>
            <option value="ready">Ready</option>
            <option value="deprecated">Deprecated</option>
          </Select>
        </Field>
        <Field label="Owner">
          <Input value={f.owner} placeholder="e.g. ana" onChange={(e) => set({ owner: e.target.value })} />
        </Field>
      </div>
      <Field label="Preconditions" hint="Shown in bug reports, e.g. 'Logged in as Receptionist'">
        <Textarea rows={2} value={f.preconditions} onChange={(e) => set({ preconditions: e.target.value })} />
      </Field>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" disabled={!dirty} onClick={() => setF(initial)}>
          Discard
        </Button>
        <Button disabled={!dirty || !f.name.trim() || save.isPending} onClick={() => save.mutate()}>
          <Save className="h-4 w-4" /> Save details
        </Button>
      </div>
      <div className="space-y-2 border-t border-border pt-4">
        <p className="text-xs font-medium text-muted">Tags (click to toggle, saved immediately)</p>
        {tags.data?.length ? (
          <div className="flex flex-wrap gap-2">
            {tags.data.map((t) => (
              <button
                key={t.id}
                onClick={() => toggleTag(t.id)}
                aria-pressed={scenario.tagIds.includes(t.id)}
              >
                <TagChip
                  name={t.name}
                  color={t.color}
                  className={cn(!scenario.tagIds.includes(t.id) && 'opacity-35 grayscale')}
                />
              </button>
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted">
            No tags in this application yet. Add them on the application's Tags tab.
          </p>
        )}
      </div>
    </div>
  );
}
