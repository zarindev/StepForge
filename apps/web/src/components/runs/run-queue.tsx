import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ArrowUpToLine, ListOrdered } from 'lucide-react';
import { useCallback } from 'react';
import { timeAgo } from '@/components/runs/status';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Select } from '@/components/ui/input';
import { toastError } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { useLiveEvent } from '@/lib/live';
import type { Run } from '@/lib/types';

type QueuedRun = Run & { applicationName: string };
type Queue = { active: QueuedRun | null; waiting: QueuedRun[] };

const level = (p = 0): 'next' | 'high' | 'normal' | 'low' =>
  p > 1 ? 'next' : p === 1 ? 'high' : p < 0 ? 'low' : 'normal';

/** The run queue: the run in progress and the waiting ones in start order, with "Run next" and priorities. */
export function RunQueue() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['run-queue'], queryFn: () => api<Queue>('/api/runs/queue') });
  const refresh = useCallback(
    (e: { type: string }) => {
      if (e.type === 'run.updated') void qc.invalidateQueries({ queryKey: ['run-queue'] });
    },
    [qc],
  );
  useLiveEvent(refresh);
  const act = useMutation({
    mutationFn: ({ id, priority }: { id: string; priority?: string }) =>
      priority
        ? api(`/api/runs/${id}/priority`, { method: 'POST', json: { priority } })
        : api(`/api/runs/${id}/cancel`, { method: 'POST' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['run-queue'] });
      void qc.invalidateQueries({ queryKey: ['runs'] });
    },
    onError: toastError,
  });
  if (!q.data || (!q.data.active && !q.data.waiting.length)) return null;
  const { active, waiting } = q.data;
  return (
    <Card className="mb-5 p-4" aria-label="Run queue">
      <div className="mb-2 flex items-center gap-2 text-sm font-semibold">
        <ListOrdered className="h-4 w-4 text-muted" /> Queue
        <span className="text-xs font-normal text-muted">
          One run at a time; waiting runs start by priority, then oldest first.
        </span>
      </div>
      <ol className="space-y-1.5 text-sm">
        {active && (
          <li className="flex items-center gap-3 rounded-lg bg-sky-400/5 px-3 py-1.5">
            <span className="w-14 text-xs text-sky-400">Running</span>
            <Link
              to="/runs/$runId"
              params={{ runId: active.id }}
              className="min-w-0 flex-1 truncate hover:underline"
            >
              {active.applicationName} · #{active.id.slice(-8)}
            </Link>
            <span className="text-xs text-muted">
              started {timeAgo(active.startedAt ?? active.createdAt)}
            </span>
          </li>
        )}
        {waiting.map((r, i) => {
          const p = level(r.priority);
          return (
            <li
              key={r.id}
              className="flex flex-wrap items-center gap-3 rounded-lg border border-border px-3 py-1.5"
            >
              <span className="w-14 font-mono text-xs text-muted">#{i + 1}</span>
              <Link
                to="/runs/$runId"
                params={{ runId: r.id }}
                className="min-w-0 flex-1 truncate hover:underline"
              >
                {r.applicationName} · #{r.id.slice(-8)}
              </Link>
              <span className="text-xs text-muted">queued {timeAgo(r.createdAt)}</span>
              {p === 'next' && <Badge tone="indigo">next</Badge>}
              <Select
                aria-label={`Priority of run ${r.id.slice(-8)}`}
                className="h-8 w-28 text-xs"
                value={p}
                onChange={(e) => act.mutate({ id: r.id, priority: e.target.value })}
              >
                {/* Shown only while the run is "next", so choosing High from it is a real change. */}
                {p === 'next' && (
                  <option value="next" disabled>
                    Next
                  </option>
                )}
                <option value="high">High</option>
                <option value="normal">Normal</option>
                <option value="low">Low</option>
              </Select>
              {i > 0 && (
                <Button
                  size="sm"
                  variant="outline"
                  aria-label={`Run ${r.id.slice(-8)} next`}
                  onClick={() => act.mutate({ id: r.id, priority: 'next' })}
                >
                  <ArrowUpToLine className="h-3.5 w-3.5" /> Run next
                </Button>
              )}
              <Button size="sm" variant="ghost" onClick={() => act.mutate({ id: r.id })}>
                Cancel
              </Button>
            </li>
          );
        })}
      </ol>
    </Card>
  );
}
