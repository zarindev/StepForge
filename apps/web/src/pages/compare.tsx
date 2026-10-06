import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { ArrowRight, GitCompare } from 'lucide-react';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, Select } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { api } from '@/lib/api';
import { useCurrentApp, useRuns } from '@/lib/queries';
import type { CompareRow, RunComparison } from '@/lib/types';
import { cn } from '@/lib/utils';

const label = (r: { createdAt: string; status: string }) =>
  `${new Date(r.createdAt).toLocaleString()} · ${r.status}`;

function Rows({
  title,
  rows,
  runId,
  tone,
}: {
  title: string;
  rows: CompareRow[];
  runId: string;
  tone: string;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className={tone}>
          {title} <span className="font-mono text-sm">({rows.length})</span>
        </CardTitle>
      </CardHeader>
      <CardBody className="space-y-1.5 text-sm" aria-label={title}>
        {rows.length === 0 ? (
          <p className="text-muted">None</p>
        ) : (
          rows.map((r) => (
            <div key={r.key}>
              <Link
                to="/runs/$runId"
                params={{ runId }}
                search={{ item: r.itemId }}
                className="hover:underline"
              >
                {r.name}
              </Link>
              <span className="ml-2 text-xs text-muted">
                {r.before ?? 'new'} → {r.after ?? 'removed'}
              </span>
              {r.error && r.after !== 'passed' && <p className="truncate text-xs text-muted">{r.error}</p>}
            </div>
          ))
        )}
      </CardBody>
    </Card>
  );
}

export function ComparePage() {
  const { app } = useCurrentApp();
  const runs = useRuns(app?.id);
  const search = useSearch({ from: '/runs/compare' });
  const navigate = useNavigate();
  const done = (runs.data ?? []).filter((r) => r.status === 'passed' || r.status === 'failed');
  const head = search.head ?? done[0]?.id;
  const base = search.base ?? done[1]?.id;
  const cmp = useQuery({
    queryKey: ['compare', base, head],
    queryFn: () => api<RunComparison>(`/api/runs/compare?base=${base}&head=${head}`),
    enabled: !!base && !!head,
  });
  const choose = (k: 'base' | 'head', v: string) =>
    navigate({ to: '/runs/compare', search: { base, head, [k]: v } });

  if (runs.isPending) return <Skeleton className="h-64" />;
  if (done.length < 2)
    return (
      <EmptyState
        icon={GitCompare}
        title="Two finished runs are needed"
        description="Run your tests twice to compare the results."
      />
    );

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold tracking-tight">Compare runs</h1>
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Before">
          <Select
            aria-label="Before"
            className="w-72"
            value={base}
            onChange={(e) => choose('base', e.target.value)}
          >
            {done.map((r) => (
              <option key={r.id} value={r.id}>
                {label(r)}
              </option>
            ))}
          </Select>
        </Field>
        <ArrowRight className="mb-2.5 h-4 w-4 text-muted" />
        <Field label="After">
          <Select
            aria-label="After"
            className="w-72"
            value={head}
            onChange={(e) => choose('head', e.target.value)}
          >
            {done.map((r) => (
              <option key={r.id} value={r.id}>
                {label(r)}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      {cmp.isPending ? (
        <Skeleton className="h-64" />
      ) : cmp.isError ? (
        <ErrorState error={cmp.error} onRetry={() => cmp.refetch()} />
      ) : (
        <>
          <Card className="flex flex-wrap gap-6 p-4 text-sm" data-testid="compare-summary">
            <span>
              Pass rate <strong className="font-mono">{cmp.data.base.passRate ?? '—'}%</strong> →{' '}
              <strong
                className={cn(
                  'font-mono',
                  (cmp.data.head.passRate ?? 0) >= (cmp.data.base.passRate ?? 0) ? 'text-pass' : 'text-fail',
                )}
              >
                {cmp.data.head.passRate ?? '—'}%
              </strong>
            </span>
            <span>{cmp.data.stillPassing} still passing</span>
            {cmp.data.added > 0 && <span>{cmp.data.added} added</span>}
            {cmp.data.removed > 0 && <span>{cmp.data.removed} not run any more</span>}
          </Card>
          <div className="grid gap-4 lg:grid-cols-3">
            <Rows title="Fixed" rows={cmp.data.fixed} runId={cmp.data.head.id} tone="text-pass" />
            <Rows
              title="New failures"
              rows={cmp.data.newFailures}
              runId={cmp.data.head.id}
              tone="text-fail"
            />
            <Rows
              title="Still failing"
              rows={cmp.data.stillFailing}
              runId={cmp.data.head.id}
              tone="text-warn"
            />
          </div>
          <Card>
            <CardHeader>
              <CardTitle>Performance changes</CardTitle>
            </CardHeader>
            <CardBody>
              {cmp.data.perfDeltas.length === 0 ? (
                <p className="text-sm text-muted">No comparable performance metrics changed.</p>
              ) : (
                <table className="w-full text-sm" aria-label="Performance changes">
                  <thead className="text-left text-xs text-muted">
                    <tr>
                      <th>Test</th>
                      <th>Metric</th>
                      <th className="text-right">Before</th>
                      <th className="text-right">After</th>
                      <th className="text-right">Change</th>
                    </tr>
                  </thead>
                  <tbody>
                    {cmp.data.perfDeltas.map((d) => (
                      <tr key={`${d.test}${d.metric}`} className="border-t border-border">
                        <td className="py-1">{d.test}</td>
                        <td className="font-mono text-xs">{d.metric}</td>
                        <td className="text-right font-mono">
                          {d.before} {d.unit}
                        </td>
                        <td className="text-right font-mono">
                          {d.after} {d.unit}
                        </td>
                        {/* Lower is better for times; this table shows the raw change. */}
                        <td
                          className={cn(
                            'text-right font-mono',
                            (d.deltaPct ?? 0) > 0 ? 'text-fail' : 'text-pass',
                          )}
                        >
                          {d.deltaPct === null ? '—' : `${d.deltaPct > 0 ? '+' : ''}${d.deltaPct}%`}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </CardBody>
          </Card>
        </>
      )}
    </div>
  );
}
