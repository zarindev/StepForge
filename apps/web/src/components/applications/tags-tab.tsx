import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Tag as TagIcon, X } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/ui/states';
import { toastError } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { qk, useTags } from '@/lib/queries';
import type { Application } from '@/lib/types';
import { cn } from '@/lib/utils';
import { APP_COLORS } from './app-form';

export function TagChip({
  name,
  color,
  onRemove,
  className,
}: {
  name: string;
  color: string;
  onRemove?: () => void;
  className?: string;
}) {
  return (
    <span
      className={cn('inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs', className)}
      style={{ borderColor: `${color}55`, background: `${color}18`, color }}
    >
      #{name}
      {onRemove && (
        <button aria-label={`Remove ${name}`} onClick={onRemove} className="opacity-70 hover:opacity-100">
          <X className="h-3 w-3" />
        </button>
      )}
    </span>
  );
}

export function TagsTab({ app }: { app: Application }) {
  const tags = useTags(app.id);
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [color, setColor] = useState(APP_COLORS[1]!);
  const refresh = () => qc.invalidateQueries({ queryKey: qk.tags(app.id) });
  const create = useMutation({
    mutationFn: () =>
      api(`/api/applications/${app.id}/tags`, { method: 'POST', json: { name: name.trim(), color } }),
    onSuccess: () => {
      setName('');
      refresh();
    },
    onError: toastError,
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/api/tags/${id}`, { method: 'DELETE' }),
    onSuccess: refresh,
    onError: toastError,
  });

  return (
    <div className="space-y-4">
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) create.mutate();
        }}
      >
        <Input
          className="w-56"
          placeholder="smoke, regression, checkout…"
          value={name}
          onChange={(e) => setName(e.target.value)}
          aria-label="Tag name"
        />
        <div className="flex gap-1">
          {APP_COLORS.map((c) => (
            <button
              type="button"
              key={c}
              aria-label={`Tag colour ${c}`}
              onClick={() => setColor(c)}
              className={cn(
                'h-5 w-5 rounded-full ring-offset-2 ring-offset-bg',
                color === c && 'ring-2 ring-fg/60',
              )}
              style={{ background: c }}
            />
          ))}
        </div>
        <Button size="sm" type="submit" disabled={!name.trim() || create.isPending}>
          <Plus className="h-3.5 w-3.5" /> Add tag
        </Button>
      </form>
      {tags.isPending ? (
        <Skeleton className="h-10" />
      ) : tags.data?.length === 0 ? (
        <EmptyState
          icon={TagIcon}
          title="No tags yet"
          description="Tags group scenarios across modules, e.g. run every #smoke test before a release."
        />
      ) : (
        <div className="flex flex-wrap gap-2">
          {tags.data?.map((t) => (
            <TagChip key={t.id} name={t.name} color={t.color} onRemove={() => remove.mutate(t.id)} />
          ))}
        </div>
      )}
    </div>
  );
}
