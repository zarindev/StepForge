import { useMutation, useQueryClient } from '@tanstack/react-query';
import { History, RotateCcw } from 'lucide-react';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { toast, toastError } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { diffLines } from '@/lib/diff';
import { qk, useVersions } from '@/lib/queries';
import type { ScenarioDetail, ScenarioSnapshot } from '@/lib/types';
import { cn } from '@/lib/utils';

const pretty = (s: ScenarioSnapshot | undefined) => {
  if (!s) return '';
  const { restoredFrom: _r, note: _n, ...content } = s;
  return JSON.stringify(content, null, 2);
};

export function HistoryTab({ scenario }: { scenario: ScenarioDetail }) {
  const versions = useVersions(scenario.id);
  const [selected, setSelected] = useState<number | null>(null);
  const [restoring, setRestoring] = useState(false);
  const qc = useQueryClient();
  const restore = useMutation({
    mutationFn: (v: number) =>
      api<ScenarioDetail>(`/api/scenarios/${scenario.id}/versions/${v}/restore`, { method: 'POST' }),
    onSuccess: (s) => {
      qc.setQueryData(qk.scenario(s.id), s);
      qc.invalidateQueries({ queryKey: qk.versions(s.id) });
      qc.invalidateQueries({ queryKey: qk.tree(s.applicationId) });
      setRestoring(false);
      setSelected(null);
      toast(`Restored as v${s.version}`);
    },
    onError: toastError,
  });

  if (versions.isPending) return <Skeleton className="h-40" />;
  if (versions.isError) return <ErrorState error={versions.error} onRetry={() => versions.refetch()} />;
  if (!versions.data.length)
    return <EmptyState icon={History} title="No history" description="Versions appear as you edit." />;

  const list = versions.data;
  const current = selected ?? list[0]!.version;
  const idx = list.findIndex((v) => v.version === current);
  const after = list[idx];
  const before = list[idx + 1];
  const lines = diffLines(pretty(before?.snapshotJson), pretty(after?.snapshotJson));

  return (
    <div className="grid gap-4 lg:grid-cols-[240px_1fr]">
      <ul className="space-y-1" aria-label="Versions">
        {list.map((v) => (
          <li key={v.id}>
            <button
              onClick={() => setSelected(v.version)}
              className={cn(
                'w-full rounded-lg border px-3 py-2 text-left text-sm',
                v.version === current ? 'border-brand/50 bg-brand/5' : 'border-border hover:bg-fg/[0.03]',
              )}
            >
              <div className="flex items-center gap-2">
                <span className="font-mono font-semibold">v{v.version}</span>
                {v.version === scenario.version && <Badge tone="pass">current</Badge>}
                {v.snapshotJson.restoredFrom && (
                  <Badge tone="indigo">from v{v.snapshotJson.restoredFrom}</Badge>
                )}
              </div>
              <div className="text-xs text-muted">{v.snapshotJson.note ?? 'Changed'}</div>
              <div className="text-[11px] text-muted">{new Date(v.createdAt).toLocaleString()}</div>
            </button>
          </li>
        ))}
      </ul>
      <div className="min-w-0 space-y-3">
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted">
            {before ? (
              <>
                Changes from <span className="font-mono">v{before.version}</span> to{' '}
                <span className="font-mono">v{after?.version}</span>
              </>
            ) : (
              'Initial version'
            )}
          </p>
          <Button
            variant="outline"
            size="sm"
            disabled={current === scenario.version}
            onClick={() => setRestoring(true)}
          >
            <RotateCcw className="h-3.5 w-3.5" /> Restore v{current}
          </Button>
        </div>
        <pre className="max-h-[480px] overflow-auto rounded-lg border border-border bg-bg p-3 font-mono text-xs leading-5">
          {lines.map((l, i) => (
            <div
              key={i}
              className={cn(
                l.kind === 'add' && 'bg-pass/10 text-pass',
                l.kind === 'del' && 'bg-fail/10 text-fail line-through decoration-fail/40',
              )}
            >
              <span className="mr-2 inline-block w-3 select-none opacity-60">
                {l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ' '}
              </span>
              {l.text}
            </div>
          ))}
        </pre>
      </div>
      <ConfirmDialog
        open={restoring}
        onClose={() => setRestoring(false)}
        title={`Restore v${current}?`}
        description="The scenario's details and steps are replaced with this version's content. Nothing is lost: the restore becomes a new version."
        confirmLabel="Restore"
        busy={restore.isPending}
        onConfirm={() => restore.mutate(current)}
      />
    </div>
  );
}
