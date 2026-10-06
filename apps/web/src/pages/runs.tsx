import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { GitCompare, Play, PlayCircle, RotateCw, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { formatDuration, StatusPill, timeAgo, TotalsBar } from '@/components/runs/status';
import { openRunDialog } from '@/components/runs/run-dialog';
import { PageHeader } from '@/components/shell/layout';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Switch } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { toast, toastError } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { useCurrentApp, useRuns } from '@/lib/queries';

export function RunsPage() {
  const { app } = useCurrentApp();
  const [onlyCurrent, setOnlyCurrent] = useState(true);
  const runs = useRuns(onlyCurrent ? app?.id : undefined);
  const qc = useQueryClient();
  const act = useMutation({
    mutationFn: ({ id, action }: { id: string; action: 'resume' | 'delete' }) =>
      action === 'delete'
        ? api(`/api/runs/${id}`, { method: 'DELETE' })
        : api(`/api/runs/${id}/resume`, { method: 'POST' }),
    onSuccess: (_d, v) => {
      qc.invalidateQueries({ queryKey: ['runs'] });
      toast(v.action === 'delete' ? 'Run deleted' : 'Run resumed');
    },
    onError: toastError,
  });

  return (
    <>
      <PageHeader
        title="Runs"
        description="Live and past test runs with screenshots, video and traces."
        actions={
          <>
            <label className="flex items-center gap-2 text-sm text-muted">
              <Switch checked={onlyCurrent} onChange={setOnlyCurrent} label="Only current application" />{' '}
              {app ? `Only ${app.name}` : 'Current app'}
            </label>
            <Link to="/runs/compare" search={{}}>
              <Button variant="outline" disabled={!app}>
                <GitCompare className="h-4 w-4" /> Compare
              </Button>
            </Link>
            <Button
              disabled={!app}
              onClick={() =>
                app && openRunDialog({ applicationId: app.id, label: `Run tests in ${app.name}` })
              }
            >
              <Play className="h-4 w-4 fill-current" /> New run
            </Button>
          </>
        }
      />
      {runs.isError && <ErrorState error={runs.error} onRetry={() => runs.refetch()} />}
      {runs.isPending && <Skeleton className="h-64" />}
      {runs.data?.length === 0 && (
        <EmptyState
          icon={PlayCircle}
          title="No runs yet"
          description="Run a scenario from the Test Explorer, or start a run for a whole application, module or tag."
          action={
            app && (
              <Button
                onClick={() => openRunDialog({ applicationId: app.id, label: `Run tests in ${app.name}` })}
              >
                <Play className="h-4 w-4 fill-current" /> Start a run
              </Button>
            )
          }
        />
      )}
      {!!runs.data?.length && (
        <Card className="overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-fg/[0.03] text-left text-xs text-muted">
              <tr>
                <th className="px-4 py-2.5 font-medium">Status</th>
                <th className="px-4 py-2.5 font-medium">Application</th>
                <th className="px-4 py-2.5 font-medium">Scope</th>
                <th className="px-4 py-2.5 font-medium">Results</th>
                <th className="px-4 py-2.5 font-medium">Duration</th>
                <th className="px-4 py-2.5 font-medium">Started</th>
                <th />
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {runs.data.map((r) => (
                <tr key={r.id} className="hover:bg-fg/[0.02]">
                  <td className="px-4 py-3">
                    <Link to="/runs/$runId" params={{ runId: r.id }} aria-label={`Open run ${r.id}`}>
                      <StatusPill status={r.status} />
                    </Link>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <span className="h-2 w-2 rounded-full" style={{ background: r.applicationColor }} />
                      <Link
                        to="/runs/$runId"
                        params={{ runId: r.id }}
                        className="font-medium hover:underline"
                      >
                        {r.applicationName}
                      </Link>
                    </div>
                    <div className="text-xs text-muted">
                      {r.environmentName ?? 'deleted env'} · {r.browser} · {r.viewport} · {r.trigger}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-xs text-muted">{r.scopeJson.type}</td>
                  <td className="w-56 px-4 py-3">
                    <TotalsBar totals={r.totalsJson} />
                    <div className="mt-1 text-xs text-muted tabular-nums">
                      {r.totalsJson.passed + r.totalsJson.flaky}/{r.totalsJson.total} passed
                      {r.totalsJson.failed + r.totalsJson.broken > 0 && (
                        <span className="text-fail">
                          {' '}
                          · {r.totalsJson.failed + r.totalsJson.broken} failed
                        </span>
                      )}
                      {r.totalsJson.flaky > 0 && (
                        <span className="text-warn"> · {r.totalsJson.flaky} flaky</span>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3 font-mono text-xs">{formatDuration(r.durationMs)}</td>
                  <td className="px-4 py-3 text-xs text-muted">{timeAgo(r.startedAt ?? r.createdAt)}</td>
                  <td className="px-3 py-3 text-right whitespace-nowrap">
                    {r.status === 'interrupted' && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => act.mutate({ id: r.id, action: 'resume' })}
                      >
                        <RotateCw className="h-3.5 w-3.5" /> Resume
                      </Button>
                    )}
                    {!['running', 'queued'].includes(r.status) && (
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label="Delete run"
                        onClick={() => act.mutate({ id: r.id, action: 'delete' })}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </>
  );
}
