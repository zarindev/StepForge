import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { ArrowLeft, BarChart3, Pencil, Plus, ShieldCheck, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { CalendarHeatmap, GateChip, GroupBars, HistoryDots } from '@/components/analytics/charts';
import { LineChart } from '@/components/perf/line-chart';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Select } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { toast, toastError } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { useApplication, useEnvironments } from '@/lib/queries';
import type { AppAnalytics, AppGates, GateRule } from '@/lib/types';

const KINDS: { kind: GateRule['kind']; label: string }[] = [
  { kind: 'passRate', label: 'Pass rate at least (%)' },
  { kind: 'openBugs', label: 'Open bugs at most' },
  { kind: 'flakyRate', label: 'Flaky rate at most (%)' },
  { kind: 'apiP95', label: 'API p95 below (ms)' },
  { kind: 'loadP95', label: 'Load test p95 below (ms)' },
  { kind: 'pageLcp', label: 'Page LCP below (ms)' },
  { kind: 'maxDuration', label: 'Run duration at most (min)' },
];
const limitKey = (r: GateRule) =>
  r.kind === 'passRate'
    ? 'min'
    : r.kind === 'openBugs' || r.kind === 'flakyRate'
      ? 'max'
      : r.kind === 'maxDuration'
        ? 'maxMinutes'
        : 'maxMs';
const blank = (kind: GateRule['kind']): GateRule =>
  kind === 'passRate'
    ? { kind, min: 95 }
    : kind === 'openBugs'
      ? { kind, severity: 'critical', max: 0 }
      : kind === 'flakyRate'
        ? { kind, max: 5 }
        : kind === 'maxDuration'
          ? { kind, maxMinutes: 30 }
          : { kind, maxMs: 800 };

function GateDialog({
  appId,
  initial,
  onClose,
}: {
  appId: string;
  initial?: { id: string; name: string; rules: GateRule[] };
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [name, setName] = useState(initial?.name ?? 'Release readiness');
  const [rules, setRules] = useState<GateRule[]>(initial?.rules ?? [blank('passRate')]);
  const set = (i: number, r: GateRule) => setRules((x) => x.map((y, j) => (i === j ? r : y)));
  const save = useMutation({
    mutationFn: () =>
      initial
        ? api(`/api/quality-gates/${initial.id}`, { method: 'PUT', json: { name, rules } })
        : api(`/api/applications/${appId}/quality-gates`, { method: 'POST', json: { name, rules } }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['gates', appId] });
      void qc.invalidateQueries({ queryKey: ['analytics', appId] });
      toast('Quality gate saved');
      onClose();
    },
    onError: toastError,
  });
  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title={initial ? `Edit ${initial.name}` : 'New quality gate'}
      description="Evaluated on the application's latest completed run (pass rates, performance, duration), its open bugs and the last 7 days (flakiness). Blocking rules turn the gate red; warnings amber."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!name.trim() || !rules.length || save.isPending} onClick={() => save.mutate()}>
            Save gate
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="Name">
          <Input aria-label="Gate name" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        {rules.map((r, i) => (
          <div key={i} className="flex flex-wrap items-end gap-2 rounded-lg border border-border p-2">
            <Field label="Rule" className="w-52">
              <Select
                aria-label={`Rule ${i + 1}`}
                value={r.kind}
                onChange={(e) => set(i, blank(e.target.value as GateRule['kind']))}
              >
                {KINDS.map((k) => (
                  <option key={k.kind} value={k.kind}>
                    {k.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Limit" className="w-24">
              <Input
                aria-label={`Rule ${i + 1} limit`}
                inputMode="decimal"
                value={String((r as Record<string, unknown>)[limitKey(r)] ?? '')}
                onChange={(e) => set(i, { ...r, [limitKey(r)]: Number(e.target.value) } as GateRule)}
              />
            </Field>
            {r.kind === 'passRate' && (
              <>
                <Field label="Priority" className="w-24">
                  <Select
                    value={r.priority ?? ''}
                    onChange={(e) => set(i, { ...r, priority: (e.target.value || undefined) as never })}
                  >
                    <option value="">All</option>
                    {['P1', 'P2', 'P3', 'P4'].map((p) => (
                      <option key={p}>{p}</option>
                    ))}
                  </Select>
                </Field>
                <Field label="Tag" className="w-28">
                  <Input
                    value={r.tag ?? ''}
                    onChange={(e) => set(i, { ...r, tag: e.target.value || undefined })}
                  />
                </Field>
              </>
            )}
            {r.kind === 'openBugs' && (
              <Field label="Severity" className="w-32">
                <Select
                  value={r.severity}
                  onChange={(e) => set(i, { ...r, severity: e.target.value as never })}
                >
                  {['critical', 'major', 'minor', 'trivial'].map((s) => (
                    <option key={s} value={s}>
                      {s === 'critical' ? 'critical' : `${s} or worse`}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
            <Field label="When it fails" className="w-28">
              <Select
                value={r.level ?? 'block'}
                onChange={(e) => set(i, { ...r, level: e.target.value as 'block' | 'warn' })}
              >
                <option value="block">block (red)</option>
                <option value="warn">warn (amber)</option>
              </Select>
            </Field>
            <Button
              variant="ghost"
              size="icon"
              aria-label={`Remove rule ${i + 1}`}
              onClick={() => setRules((x) => x.filter((_, j) => j !== i))}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        ))}
        <Button variant="outline" size="sm" onClick={() => setRules((x) => [...x, blank('passRate')])}>
          <Plus className="h-3.5 w-3.5" /> Add rule
        </Button>
      </div>
    </Dialog>
  );
}

function GatesCard({ appId }: { appId: string }) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState<{ id: string; name: string; rules: GateRule[] } | 'new' | null>(
    null,
  );
  const gates = useQuery({
    queryKey: ['gates', appId],
    queryFn: () => api<AppGates>(`/api/applications/${appId}/quality-gates`),
  });
  const preset = useMutation({
    mutationFn: () =>
      api(`/api/applications/${appId}/quality-gates`, { method: 'POST', json: { preset: 'default' } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['gates', appId] }),
    onError: toastError,
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/api/quality-gates/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['gates', appId] }),
    onError: toastError,
  });
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="flex items-center gap-2">
          <ShieldCheck className="h-4 w-4" /> Quality gates{' '}
          {gates.data && <GateChip status={gates.data.status} />}
        </CardTitle>
        <Button size="sm" variant="outline" onClick={() => setEditing('new')}>
          <Plus className="h-3.5 w-3.5" /> New gate
        </Button>
      </CardHeader>
      <CardBody className="space-y-3" data-testid="gates">
        {gates.isPending ? (
          <Skeleton className="h-20" />
        ) : !gates.data?.gates.length ? (
          <div className="text-sm text-muted">
            No quality gate yet.{' '}
            <button type="button" className="text-brand hover:underline" onClick={() => preset.mutate()}>
              Add the recommended “Release readiness” gate
            </button>{' '}
            (P1 tests 100%, all tests ≥ 95%, no open critical bugs, API p95 &lt; 800 ms).
          </div>
        ) : (
          gates.data.gates.map((g) => {
            const def = gates.data.definitions?.find((d) => d.id === g.gateId);
            return (
              <div key={g.gateId} className="rounded-lg border border-border p-3">
                <div className="mb-2 flex items-center gap-2">
                  <span className="font-medium">{g.name}</span>
                  <GateChip status={g.status} />
                  {g.runId && (
                    <Link
                      to="/runs/$runId"
                      params={{ runId: g.runId }}
                      className="text-xs text-muted hover:text-fg"
                    >
                      latest run
                    </Link>
                  )}
                  <span className="ml-auto flex">
                    {def && (
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`Edit ${g.name}`}
                        onClick={() => setEditing(def)}
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Delete ${g.name}`}
                      onClick={() => remove.mutate(g.gateId)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </span>
                </div>
                <ul className="space-y-1 text-sm">
                  {g.rules.map((r) => (
                    <li key={r.label} className="flex items-baseline gap-2">
                      <span
                        className={
                          r.passed === true ? 'text-pass' : r.passed === false ? 'text-fail' : 'text-muted'
                        }
                      >
                        {r.passed === true ? '✓' : r.passed === false ? '✗' : '?'}
                      </span>
                      <span className="flex-1">
                        {r.label}
                        {r.rule.level === 'warn' && <span className="text-xs text-muted"> (warning)</span>}
                      </span>
                      <span className="text-xs text-muted">{r.message}</span>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })
        )}
      </CardBody>
      {editing && (
        <GateDialog
          appId={appId}
          initial={editing === 'new' ? undefined : editing}
          onClose={() => setEditing(null)}
        />
      )}
    </Card>
  );
}

const pct = (v: number | null) => (v === null ? '—' : `${v}%`);
const ms = (v: number) => (v < 1000 ? `${v} ms` : `${(v / 1000).toFixed(1)} s`);

export function AnalyticsPage() {
  const { appId } = useParams({ from: '/applications/$appId/analytics' });
  const app = useApplication(appId);
  const envs = useEnvironments(appId);
  const [days, setDays] = useState(30);
  const [envId, setEnvId] = useState('');
  const a = useQuery({
    queryKey: ['analytics', appId, days, envId],
    queryFn: () =>
      api<AppAnalytics>(
        `/api/applications/${appId}/analytics?days=${days}${envId ? `&environmentId=${envId}` : ''}`,
      ),
  });

  return (
    <div className="space-y-4">
      <Link
        to="/applications/$appId"
        params={{ appId }}
        className="inline-flex items-center gap-1 text-sm text-muted hover:text-fg"
      >
        <ArrowLeft className="h-3.5 w-3.5" /> {app.data?.name ?? 'Application'}
      </Link>
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="mr-auto text-xl font-semibold tracking-tight">Analytics — {app.data?.name}</h1>
        <Select
          aria-label="Period"
          className="w-36"
          value={days}
          onChange={(e) => setDays(Number(e.target.value))}
        >
          {[7, 30, 90, 365].map((d) => (
            <option key={d} value={d}>
              Last {d} days
            </option>
          ))}
        </Select>
        <Select
          aria-label="Environment"
          className="w-44"
          value={envId}
          onChange={(e) => setEnvId(e.target.value)}
        >
          <option value="">All environments</option>
          {envs.data?.map((e) => (
            <option key={e.id} value={e.id}>
              {e.name}
            </option>
          ))}
        </Select>
      </div>
      {a.isPending ? (
        <Skeleton className="h-96" />
      ) : a.isError ? (
        <ErrorState error={a.error} onRetry={() => a.refetch()} />
      ) : a.data.totals.tests === 0 ? (
        <>
          <GatesCard appId={appId} />
          <EmptyState
            icon={BarChart3}
            title="No results in this period"
            description="Run some tests; every finished run updates these charts."
          />
        </>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-5" data-testid="analytics-totals">
            {[
              ['Runs', a.data.totals.runs],
              ['Test results', a.data.totals.tests],
              ['Pass rate', pct(a.data.totals.passRate)],
              ['Failures', a.data.totals.failed],
              ['Flaky', a.data.totals.flaky],
            ].map(([k, v]) => (
              <Card key={k} className="px-4 py-3">
                <div className="text-[11px] text-muted">{k}</div>
                <div className="font-mono text-lg font-semibold tabular-nums">{v}</div>
              </Card>
            ))}
          </div>
          <GatesCard appId={appId} />
          <div className="grid gap-4 lg:grid-cols-4">
            {(
              [
                ['By module', a.data.byModule],
                ['By layer', a.data.byLayer],
                ['By tag', a.data.byTag],
                ['By environment', a.data.byEnvironment],
              ] as const
            ).map(([title, rows]) => (
              <Card key={title}>
                <CardHeader>
                  <CardTitle>{title}</CardTitle>
                </CardHeader>
                <CardBody>
                  <GroupBars
                    rows={[...rows]}
                    empty={title === 'By tag' ? 'No tagged scenarios' : 'No results'}
                  />
                </CardBody>
              </Card>
            ))}
          </div>
          <div className="grid gap-4 lg:grid-cols-3">
            <Card className="lg:col-span-2">
              <CardHeader>
                <CardTitle>Top failing tests</CardTitle>
              </CardHeader>
              <CardBody className="p-0">
                {a.data.topFailing.length === 0 ? (
                  <p className="p-4 text-sm text-muted">No failures in this period.</p>
                ) : (
                  <table className="w-full text-sm" aria-label="Top failing tests">
                    <tbody className="divide-y divide-border">
                      {a.data.topFailing.map((t) => (
                        <tr key={t.key}>
                          <td className="px-4 py-2">
                            <Link
                              to="/runs/$runId"
                              params={{ runId: t.lastRunId }}
                              search={{ item: t.lastItemId }}
                              className="font-medium hover:underline"
                            >
                              {t.scenario}
                              {t.testCase && <span className="text-muted"> — {t.testCase}</span>}
                            </Link>
                            <p className="truncate text-xs text-muted">{t.lastError}</p>
                          </td>
                          <td className="px-2 py-2">
                            {t.category && <Badge>{t.category.replace(/_/g, ' ')}</Badge>}
                          </td>
                          <td className="px-4 py-2 text-right font-mono text-xs whitespace-nowrap text-fail">
                            {t.failures}/{t.runs} failed
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </CardBody>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>Failure categories</CardTitle>
              </CardHeader>
              <CardBody>
                {a.data.failureCategories.length === 0 ? (
                  <p className="text-sm text-muted">No failures.</p>
                ) : (
                  <ul className="space-y-1.5 text-sm">
                    {a.data.failureCategories.map((c) => (
                      <li key={c.category} className="flex justify-between">
                        <span>{c.category.replace(/_/g, ' ')}</span>
                        <span className="font-mono text-xs text-muted">{c.count}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </CardBody>
            </Card>
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>Flaky tests</CardTitle>
              </CardHeader>
              <CardBody className="space-y-2" data-testid="flaky-list">
                {a.data.flaky.length === 0 ? (
                  <p className="text-sm text-muted">No flaky tests detected.</p>
                ) : (
                  a.data.flaky.map((f) => (
                    <div key={f.key} className="flex items-center gap-3 text-sm">
                      <Link
                        to="/runs/$runId"
                        params={{ runId: f.lastRunId }}
                        search={{ item: f.lastItemId }}
                        className="min-w-0 flex-1 truncate hover:underline"
                      >
                        {f.scenario}
                        {f.testCase && <span className="text-muted"> — {f.testCase}</span>}
                      </Link>
                      <HistoryDots history={f.history} />
                      <span className="w-12 text-right font-mono text-xs text-warn">
                        {Math.round(f.score * 100)}%
                      </span>
                    </div>
                  ))
                )}
                <p className="text-xs text-muted">
                  Flaky: passed only on retry, or flips between pass and fail without the scenario changing.
                </p>
              </CardBody>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>Slowest tests</CardTitle>
              </CardHeader>
              <CardBody className="space-y-1.5 text-sm">
                {a.data.slowest.map((s) => (
                  <div key={`${s.scenarioId}${s.testCase}`} className="flex justify-between gap-3">
                    <span className="truncate">
                      {s.scenario}
                      {s.testCase && <span className="text-muted"> — {s.testCase}</span>}
                    </span>
                    <span className="font-mono text-xs whitespace-nowrap text-muted">
                      avg {ms(s.avgMs)} · max {ms(s.maxMs)}
                    </span>
                  </div>
                ))}
              </CardBody>
            </Card>
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>API response time</CardTitle>
              </CardHeader>
              <CardBody>
                {a.data.perf.apiResponseTime.length ? (
                  <LineChart
                    label="API response time per day"
                    series={[
                      {
                        label: 'p95',
                        color: '#6366F1',
                        unit: 'ms',
                        values: a.data.perf.apiResponseTime.map((p) => p.p95),
                      },
                      {
                        label: 'average',
                        color: '#F97316',
                        unit: 'ms',
                        values: a.data.perf.apiResponseTime.map((p) => p.avg),
                      },
                    ]}
                  />
                ) : (
                  <p className="text-sm text-muted">No API steps ran in this period.</p>
                )}
              </CardBody>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>Page LCP and load tests</CardTitle>
              </CardHeader>
              <CardBody className="space-y-3">
                {a.data.perf.pageLcp.length ? (
                  <LineChart
                    label="Page LCP per day"
                    series={[
                      {
                        label: 'LCP p95',
                        color: '#EC4899',
                        unit: 'ms',
                        values: a.data.perf.pageLcp.map((p) => p.p95),
                      },
                    ]}
                    height={120}
                  />
                ) : (
                  <p className="text-sm text-muted">
                    No page metrics recorded (perf.pageMetrics or the run option).
                  </p>
                )}
                {a.data.perf.load.length > 0 && (
                  <table className="w-full text-xs">
                    <thead className="text-left text-muted">
                      <tr>
                        <th>When</th>
                        <th>Test</th>
                        <th>Profile</th>
                        <th className="text-right">req/s</th>
                        <th className="text-right">p95</th>
                      </tr>
                    </thead>
                    <tbody>
                      {a.data.perf.load.slice(-8).map((l, i) => (
                        <tr key={i}>
                          <td>{new Date(l.at).toLocaleDateString()}</td>
                          <td className="truncate">{l.scenario}</td>
                          <td>
                            {l.profile} · {l.vus} VUs
                          </td>
                          <td className="text-right font-mono">{l.rps}</td>
                          <td className="text-right font-mono">{l.p95} ms</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </CardBody>
            </Card>
          </div>
          <Card>
            <CardHeader>
              <CardTitle>Daily pass rate (last 12 months)</CardTitle>
            </CardHeader>
            <CardBody>
              <CalendarHeatmap days={a.data.heatmap} />
            </CardBody>
          </Card>
        </>
      )}
    </div>
  );
}
