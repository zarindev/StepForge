import { Plus, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

export type KV = { key: string; value: string; enabled: boolean };

export const toKV = (o: Record<string, unknown> | undefined): KV[] =>
  Object.entries(o ?? {}).map(([key, v]) => ({ key, value: String(v), enabled: true }));
export const fromKV = (rows: KV[]): Record<string, string> =>
  Object.fromEntries(rows.filter((r) => r.enabled && r.key.trim()).map((r) => [r.key.trim(), r.value]));

/** Editable key/value rows (query params, headers). */
export function KVEditor({
  rows,
  onChange,
  keyPlaceholder = 'Key',
  label,
}: {
  rows: KV[];
  onChange: (r: KV[]) => void;
  keyPlaceholder?: string;
  label: string;
}) {
  const set = (i: number, patch: Partial<KV>) =>
    onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <div className="space-y-1.5" role="group" aria-label={label}>
      {rows.map((r, i) => (
        <div key={i} className="flex items-center gap-1.5">
          <input
            type="checkbox"
            aria-label={`Enable ${r.key || 'row'}`}
            className="accent-[#F97316]"
            checked={r.enabled}
            onChange={(e) => set(i, { enabled: e.target.checked })}
          />
          <Input
            aria-label={`${label} key ${i + 1}`}
            className="h-8 w-56 font-mono text-xs"
            placeholder={keyPlaceholder}
            value={r.key}
            onChange={(e) => set(i, { key: e.target.value })}
          />
          <Input
            aria-label={`${label} value ${i + 1}`}
            className="h-8 flex-1 font-mono text-xs"
            placeholder="Value — {{env.x}} {{secret.y}} allowed"
            value={r.value}
            onChange={(e) => set(i, { value: e.target.value })}
          />
          <button
            aria-label="Remove row"
            className="rounded p-1 text-muted hover:text-fail"
            onClick={() => onChange(rows.filter((_, j) => j !== i))}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
      <Button
        variant="ghost"
        size="sm"
        onClick={() => onChange([...rows, { key: '', value: '', enabled: true }])}
      >
        <Plus className="h-3.5 w-3.5" /> Add
      </Button>
    </div>
  );
}
