import { Copy, Play, Trash2, X } from 'lucide-react';
import { motion } from 'motion/react';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/input';
import type { Tag } from '@/lib/types';

export type BulkAction =
  | { action: 'delete' }
  | { action: 'duplicate' }
  | { action: 'move'; moduleId: string }
  | { action: 'addTag'; tagId: string }
  | { action: 'setStatus'; status: string };

export function BulkBar({
  count,
  tags,
  modules,
  onAction,
  onClear,
}: {
  count: number;
  tags: Tag[];
  modules: { id: string; label: string }[];
  onAction: (a: BulkAction) => void;
  onClear: () => void;
}) {
  return (
    <motion.div
      initial={{ y: 12, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      className="glass flex flex-wrap items-center gap-2 rounded-lg border border-brand/30 px-3 py-2 text-sm"
      role="toolbar"
      aria-label="Bulk actions"
    >
      <span className="font-medium">{count} selected</span>
      <Select
        aria-label="Add tag to selected"
        className="h-8 w-36 text-xs"
        value=""
        onChange={(e) => e.target.value && onAction({ action: 'addTag', tagId: e.target.value })}
      >
        <option value="">+ Tag…</option>
        {tags.map((t) => (
          <option key={t.id} value={t.id}>
            #{t.name}
          </option>
        ))}
      </Select>
      <Select
        aria-label="Move selected to module"
        className="h-8 w-40 text-xs"
        value=""
        onChange={(e) => e.target.value && onAction({ action: 'move', moduleId: e.target.value })}
      >
        <option value="">Move to…</option>
        {modules.map((m) => (
          <option key={m.id} value={m.id}>
            {m.label}
          </option>
        ))}
      </Select>
      <Select
        aria-label="Set status of selected"
        className="h-8 w-32 text-xs"
        value=""
        onChange={(e) => e.target.value && onAction({ action: 'setStatus', status: e.target.value })}
      >
        <option value="">Status…</option>
        <option value="draft">Draft</option>
        <option value="ready">Ready</option>
        <option value="deprecated">Deprecated</option>
      </Select>
      <Button variant="ghost" size="sm" onClick={() => onAction({ action: 'duplicate' })}>
        <Copy className="h-3.5 w-3.5" /> Duplicate
      </Button>
      <Button variant="ghost" size="sm" className="text-fail" onClick={() => onAction({ action: 'delete' })}>
        <Trash2 className="h-3.5 w-3.5" /> Delete
      </Button>
      <Button size="sm" disabled title="The runner arrives in Phase 3">
        <Play className="h-3.5 w-3.5" /> Run
      </Button>
      <button
        aria-label="Clear selection"
        onClick={onClear}
        className="ml-auto rounded p-1 text-muted hover:text-fg"
      >
        <X className="h-4 w-4" />
      </button>
    </motion.div>
  );
}
