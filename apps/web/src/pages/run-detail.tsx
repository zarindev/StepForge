import { useMutation } from '@tanstack/react-query';
import { ResultsGrid } from '@/components/database/results-grid';
import { EmailPreview } from '@/components/email/email-preview';
import { PerfPanel, type StepPerf } from '@/components/perf/perf-panel';
import { Link, useParams } from '@tanstack/react-router';
import { ArrowLeft, Ban, Bandage, ChevronRight, FolderTree, Play, RotateCw, Terminal } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import { EvidencePanel, Lightbox } from '@/components/runs/evidence';
import { openRunDialog } from '@/components/runs/run-dialog';
import { formatDuration, StatusIcon, StatusPill, timeAgo, TotalsBar } from '@/components/runs/status';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { toastError } from '@/components/ui/toast';
import { api, artifactUrl } from '@/lib/api';
import { setCurrentAppId } from '@/lib/current-app';
import { useLiveEvent, type LiveEvent } from '@/lib/live';
import { useRun, useRunItem } from '@/lib/queries';
import { groupOf, LAYER } from '@/lib/steps';
import type { RunItem, StepResultRow } from '@/lib/types';
import { cn } from '@/lib/utils';

type LiveStep = {
  position: number;
  path?: string;
  depth?: number;
  type: string;
  label: string;
  status: string;
  durationMs?: number;
  message?: string;
  screenshotPath?: string;
};
type LogLine = { itemId?: string; level: string; message: string; at: number };
const FILTERS = ['all', 'failed', 'passed', 'flaky', 'skipped'] as const;

function itemTitle(i: RunItem) {
  const l = i.labelJson;
  return l ? `${l.scenario}${l.testCaseCode ? ` · ${l.testCaseCode}` : ''}` : 'Deleted scenario';
}

export function RunDetailPage() {
  const { runId } = useParams({ from: '/runs/$runId' });
  const run = useRun(runId);
  const [selected, setSelected] = useState<string | null>(null);
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>('all');
  const [live, setLive] = useState<Record<string, { steps: LiveStep[]; current?: LiveStep }>>({});
  const [logs, setLogs] = useState<LogLine[]>([]);

  const onEvent = useCallback(
    (e: LiveEvent) => {
      if (e.runId !== runId) return;
      const itemId = e.itemId as string | undefined;
      if (e.type === 'step.started' && itemId) {
        setLive((l) => ({
          ...l,
          [itemId]: {
            steps: (e.position as number) === 0 ? [] : (l[itemId]?.steps ?? []),
            current: {
              position: e.position as number,
              type: e.stepType as string,
              label: e.label as string,
              status: 'running',
            },
          },
        }));
      } else if (e.type === 'step.finished' && itemId) {
        const r = e.result as LiveStep;
        setLive((l) => ({
          ...l,
          [itemId]: {
            steps: [...(l[itemId]?.steps ?? []).filter((s) => s.position !== r.position), r],
            current: undefined,
          },
        }));
      } else if (e.type === 'run.log') {
        setLogs((x) => [
          ...x.slice(-300),
          { itemId, level: e.level as string, message: e.message as string, at: Date.now() },
        ]);
      }
    },
    [runId],
  );
  useLiveEvent(onEvent);

  const cancel = useMutation({
    mutationFn: () => api(`/api/runs/${runId}/cancel`, { method: 'POST' }),
    onError: toastError,
  });
  const resume = useMutation({
    mutationFn: () => api(`/api/runs/${runId}/resume`, { method: 'POST' }),
    onError: toastError,
  });

  const items = useMemo(() => run.data?.items ?? [], [run.data]);
  const visible = useMemo(
    () =>
      items.filter((i) =>
        filter === 'all'
          ? true
          : filter === 'failed'
            ? i.status === 'failed' || i.status === 'broken'
            : i.status === filter,
      ),
    [items, filter],
  );
  const firstFailed = items.find((i) => i.status === 'failed' || i.status === 'broken');
  const runningItem = items.find((i) => i.status === 'running');
  const selectedId = selected ?? runningItem?.id ?? firstFailed?.id ?? items[0]?.id ?? null;

  if (run.isError) return <ErrorState error={run.error} onRetry={() => run.refetch()} />;
  if (run.isPending) return <Skeleton className="h-96" />;
  const r = run.data;
  const isLive = r.status === 'running' || r.status === 'queued';
  const finished =
    r.totalsJson.passed +
    r.totalsJson.failed +
    r.totalsJson.broken +
    r.totalsJson.skipped +
    r.totalsJson.flaky;

  return (
    <>
      <Link to="/runs" className="mb-4 inline-flex items-center gap-1 text-sm text-muted hover:text-fg">
        <ArrowLeft className="h-3.5 w-3.5" /> Runs
      </Link>
      <Card className="mb-5 p-5">
        <div className="flex flex-wrap items-start gap-4">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-3">
              <StatusPill status={r.status} />
              <h1 className="text-lg font-semibold">
                <span
                  className="mr-2 inline-block h-2.5 w-2.5 rounded-full"
                  style={{ background: r.application.color }}
                />
                {r.application.name}
              </h1>
              <span className="font-mono text-xs text-muted">#{r.id.slice(-8)}</span>
            </div>
            <p className="mt-1 text-sm text-muted">
              {r.environment ? `${r.environment.name} · ${r.environment.baseUrl}` : 'Environment deleted'} ·{' '}
              {r.browser} · {r.viewport} · {r.workers} worker{r.workers > 1 ? 's' : ''} · started{' '}
              {timeAgo(r.startedAt ?? r.createdAt)} · {formatDuration(r.durationMs)}
            </p>
          </div>
          <div className="flex gap-2">
            {isLive && (
              <Button variant="danger" onClick={() => cancel.mutate()} disabled={cancel.isPending}>
                <Ban className="h-4 w-4" /> Cancel
              </Button>
            )}
            {r.status === 'interrupted' && (
              <Button onClick={() => resume.mutate()}>
                <RotateCw className="h-4 w-4" /> Resume
              </Button>
            )}
            {!isLive && r.environmentId && (
              <Button
                variant="outline"
                onClick={() =>
                  openRunDialog({
                    applicationId: r.applicationId,
                    scope: r.scopeJson,
                    label: 'Run the same selection again',
                  })
                }
              >
                <Play className="h-4 w-4" /> Run again
              </Button>
            )}
          </div>
        </div>
        <div className="mt-4 flex items-center gap-4">
          <TotalsBar totals={r.totalsJson} className="h-2 flex-1" />
          <span className="text-sm tabular-nums">
            {finished}/{r.totalsJson.total}
          </span>
        </div>
        <div className="mt-2 flex flex-wrap gap-4 text-xs text-muted tabular-nums">
          <span className="text-pass">{r.totalsJson.passed} passed</span>
          <span className="text-fail">{r.totalsJson.failed} failed</span>
          <span className="text-orange-400">{r.totalsJson.broken} broken</span>
          <span className="text-warn">{r.totalsJson.flaky} flaky</span>
          <span>{r.totalsJson.skipped} skipped</span>
        </div>
      </Card>

      <div className="grid gap-5 lg:grid-cols-[340px_1fr]">
        <Card className="h-fit overflow-hidden">
          <div className="flex gap-1 border-b border-border p-2" role="tablist" aria-label="Filter tests">
            {FILTERS.map((f) => (
              <button
                key={f}
                role="tab"
                aria-selected={filter === f}
                onClick={() => setFilter(f)}
                className={cn(
                  'rounded-md px-2.5 py-1 text-xs capitalize',
                  filter === f ? 'bg-brand/12 text-brand' : 'text-muted hover:text-fg',
                )}
              >
                {f}
              </button>
            ))}
          </div>
          <ul className="max-h-[60vh] overflow-y-auto p-1.5" aria-label="Tests in this run">
            {visible.map((i) => (
              <li key={i.id}>
                <button
                  onClick={() => setSelected(i.id)}
                  className={cn(
                    'flex w-full items-start gap-2 rounded-lg px-2.5 py-2 text-left text-sm hover:bg-fg/[0.04]',
                    selectedId === i.id && 'bg-brand/10',
                  )}
                >
                  <StatusIcon status={i.status} className="mt-0.5" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{itemTitle(i)}</span>
                    <span className="block truncate text-xs text-muted">
                      {i.status === 'running' && live[i.id]?.current
                        ? `Step ${live[i.id]!.current!.position + 1}: ${live[i.id]!.current!.label || live[i.id]!.current!.type}`
                        : i.labelJson?.modulePath.join(' / ')}
                    </span>
                  </span>
                  <span className="font-mono text-[11px] text-muted">{formatDuration(i.durationMs)}</span>
                </button>
              </li>
            ))}
            {visible.length === 0 && <li className="p-4 text-center text-sm text-muted">No tests match.</li>}
          </ul>
        </Card>

        <div className="min-w-0 space-y-5">
          {selectedId ? (
            <ItemPanel
              key={selectedId}
              appId={r.applicationId}
              itemId={selectedId}
              item={items.find((i) => i.id === selectedId)}
              live={live[selectedId]}
            />
          ) : null}
          <Card>
            <div className="flex items-center gap-2 border-b border-border px-4 py-2.5 text-sm font-medium">
              <Terminal className="h-4 w-4 text-muted" /> Live log
            </div>
            <div className="max-h-56 overflow-y-auto p-3 font-mono text-xs" aria-live="polite">
              {logs.length === 0 && (
                <p className="text-muted">
                  {isLive ? 'Waiting for output…' : 'Logs are streamed while a run is in progress.'}
                </p>
              )}
              {logs.map((l, i) => (
                <div
                  key={i}
                  className={cn(l.level === 'error' && 'text-fail', l.level === 'warn' && 'text-warn')}
                >
                  <span className="text-muted">{new Date(l.at).toLocaleTimeString()} </span>
                  {l.message}
                </div>
              ))}
            </div>
          </Card>
        </div>
      </div>
    </>
  );
}

function ItemPanel({
  appId,
  itemId,
  item,
  live,
}: {
  appId: string;
  itemId: string;
  item?: RunItem;
  live?: { steps: LiveStep[]; current?: LiveStep };
}) {
  const detail = useRunItem(itemId);
  const [shot, setShot] = useState<string | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const running = item?.status === 'running' || item?.status === 'queued';

  if (detail.isPending) return <Skeleton className="h-64" />;
  if (detail.isError) return <ErrorState error={detail.error} onRetry={() => detail.refetch()} />;
  const d = detail.data;
  const steps: (StepResultRow | LiveStep)[] = running
    ? [...(live?.steps ?? [])].sort((a, b) => a.position - b.position)
    : d.steps;
  const latestShot = running
    ? [...(live?.steps ?? [])].reverse().find((s) => s.screenshotPath)?.screenshotPath
    : undefined;

  return (
    <>
      <Card className="p-5">
        <div className="mb-3 flex flex-wrap items-start gap-3">
          <StatusIcon status={d.status} className="mt-1 h-5 w-5" />
          <div className="min-w-0 flex-1">
            <h2 className="font-semibold">{d.labelJson?.scenario ?? 'Deleted scenario'}</h2>
            <p className="text-xs text-muted">
              {d.labelJson?.modulePath.join(' / ')}
              {d.labelJson?.testCaseCode && ` · ${d.labelJson.testCaseCode} ${d.labelJson.testCaseTitle}`} · v
              {d.scenarioVersion}
              {d.attempt > 1 && ` · attempt ${d.attempt}`}
            </p>
          </div>
          {d.scenarioId && (
            <Link
              to="/explorer"
              search={{ scenario: d.scenarioId }}
              onClick={() => setCurrentAppId(appId)}
              className="text-xs text-muted hover:text-fg"
            >
              <FolderTree className="mr-1 inline h-3.5 w-3.5" />
              Open scenario
            </Link>
          )}
        </div>
        {d.errorMessage && (d.status === 'failed' || d.status === 'broken') && (
          <div
            role="alert"
            className="mb-4 rounded-lg border border-fail/30 bg-fail/5 px-4 py-3 font-mono text-xs leading-5 text-fail"
          >
            {d.errorMessage}
          </div>
        )}
        {running && latestShot && (
          <div className="mb-4">
            <p className="mb-1.5 text-xs text-muted">Live view</p>
            <img
              src={artifactUrl(latestShot)}
              alt="Latest screenshot"
              className="max-h-72 rounded-lg border border-border"
            />
          </div>
        )}
        <ol className="space-y-1" aria-label="Step timeline">
          {steps.map((s) => {
            const L = LAYER[groupOf(s.type)];
            const row = s as StepResultRow;
            const extra = row.responseJson;
            const http = (s as StepResultRow).requestJson as
              | { method?: string; url?: string; headers?: Record<string, string>; body?: unknown }
              | null
              | undefined;
            const httpRes = (extra as { body?: { status?: number; body?: unknown; timeMs?: number } } | null)
              ?.body;
            const dbq = (row.queryJson ?? (s as { query?: unknown }).query) as DbStepQuery | null | undefined;
            const email = extra?.email ?? (s as { email?: StepEmail }).email;
            const perf = (extra?.perf ?? (s as { perf?: unknown }).perf) as StepPerf | undefined;
            const expandable = !!(
              extra?.assertions?.length ||
              extra?.healedLocator ||
              s.screenshotPath ||
              http ||
              dbq ||
              email ||
              perf
            );
            const live = s as LiveStep;
            const depth = live.depth ?? extra?.depth ?? 0;
            const num = live.path ?? extra?.path ?? String(s.position + 1);
            return (
              <li
                key={s.position}
                className={cn(
                  'rounded-lg border border-transparent',
                  s.status === 'failed' && 'border-fail/30 bg-fail/5',
                  s.status === 'broken' && 'border-warn/30 bg-warn/5',
                )}
              >
                <button
                  className="flex w-full items-center gap-2.5 px-2.5 py-1.5 text-left text-sm"
                  style={{ paddingLeft: 10 + depth * 22 }}
                  onClick={() => expandable && setOpen(open === s.position ? null : s.position)}
                  aria-expanded={open === s.position}
                >
                  <StatusIcon status={s.status} />
                  <span className="min-w-5 text-right font-mono text-xs text-muted">{num}</span>
                  <L.icon className="h-3.5 w-3.5 shrink-0" style={{ color: L.color }} />
                  <span className="min-w-0 flex-1 truncate">
                    {s.label || s.type}
                    {s.message && <span className="ml-2 text-xs text-muted">{s.message}</span>}
                  </span>
                  {extra?.healedLocator && (
                    <Badge tone="warn" title="Primary locator failed; a fallback matched">
                      <Bandage className="h-3 w-3" /> healed
                    </Badge>
                  )}
                  {(extra?.attempts ?? 1) > 1 && <Badge>×{extra?.attempts}</Badge>}
                  <span className="font-mono text-[11px] text-muted">
                    {formatDuration(s.durationMs ?? null)}
                  </span>
                  {s.screenshotPath && (
                    <img
                      src={artifactUrl(s.screenshotPath)}
                      alt=""
                      className="h-8 w-12 rounded border border-border object-cover object-top"
                      onClick={(e) => {
                        e.stopPropagation();
                        setShot(artifactUrl(s.screenshotPath!));
                      }}
                    />
                  )}
                  {expandable && (
                    <ChevronRight
                      className={cn(
                        'h-3.5 w-3.5 text-muted transition-transform',
                        open === s.position && 'rotate-90',
                      )}
                    />
                  )}
                </button>
                {open === s.position && (
                  <div className="space-y-2 px-10 pb-3 text-xs">
                    {extra?.healedLocator && (
                      <p className="text-warn">
                        Primary locator{' '}
                        <code>
                          {extra.healedLocator.from.strategy}={extra.healedLocator.from.value}
                        </code>{' '}
                        found nothing; used{' '}
                        <code>
                          {extra.healedLocator.to.strategy}={extra.healedLocator.to.value}
                          {extra.healedLocator.to.name ? ` "${extra.healedLocator.to.name}"` : ''}
                        </code>
                        . Consider updating the scenario.
                      </p>
                    )}
                    {http && (
                      <div className="grid gap-2 md:grid-cols-2">
                        <div>
                          <p className="mb-1 font-medium text-muted">Request</p>
                          <pre className="max-h-60 overflow-auto rounded border border-border bg-bg p-2 font-mono text-[11px]">
                            {`${http.method} ${http.url}\n${Object.entries(http.headers ?? {})
                              .map(([k, v]) => `${k}: ${v}`)
                              .join(
                                '\n',
                              )}${http.body !== undefined ? `\n\n${JSON.stringify(http.body, null, 2)}` : ''}`}
                          </pre>
                        </div>
                        <div>
                          <p className="mb-1 font-medium text-muted">
                            Response{' '}
                            {httpRes?.status !== undefined && `· ${httpRes.status} · ${httpRes.timeMs} ms`}
                          </p>
                          <pre className="max-h-60 overflow-auto rounded border border-border bg-bg p-2 font-mono text-[11px]">
                            {typeof httpRes?.body === 'string'
                              ? httpRes.body
                              : JSON.stringify(httpRes?.body, null, 2)}
                          </pre>
                        </div>
                      </div>
                    )}
                    {dbq && <DbQueryPanel q={dbq} />}
                    {email && <EmailPreview email={email} height={280} />}
                    {perf && (
                      <PerfPanel
                        perf={perf}
                        reportPath={
                          perf.kind === 'lighthouse'
                            ? d.artifacts.find((a) => a.kind === 'lighthouse')?.path
                            : undefined
                        }
                      />
                    )}
                    {extra?.assertions?.map((a, i) => (
                      <p key={i} className={a.passed ? 'text-pass' : 'text-fail'}>
                        {a.passed ? '✓' : '✗'} {a.message}
                      </p>
                    ))}
                    {s.screenshotPath && (
                      <img
                        src={artifactUrl(s.screenshotPath)}
                        alt={`Step ${s.position + 1}`}
                        className="max-h-80 cursor-zoom-in rounded border border-border"
                        onClick={() => setShot(artifactUrl(s.screenshotPath!))}
                      />
                    )}
                  </div>
                )}
              </li>
            );
          })}
          {running && live?.current && (
            <li className="flex items-center gap-2.5 rounded-lg bg-sky-400/5 px-2.5 py-1.5 text-sm">
              <StatusIcon status="running" />
              <span className="w-5 text-right font-mono text-xs text-muted">{live.current.position + 1}</span>
              <span className="text-sky-400">{live.current.label || live.current.type}</span>
            </li>
          )}
          {steps.length === 0 && !live?.current && (
            <li className="text-sm text-muted">
              {running ? 'Waiting to start…' : 'This test had no steps.'}
            </li>
          )}
        </ol>
      </Card>
      {!running && (
        <Card className="p-5">
          <h3 className="mb-3 text-sm font-semibold">Evidence</h3>
          {d.artifacts.length ? (
            <EvidencePanel artifacts={d.artifacts} />
          ) : (
            <EmptyState
              icon={Terminal}
              title="No evidence files"
              description="Nothing was kept for this test."
            />
          )}
        </Card>
      )}
      <Lightbox src={shot} onClose={() => setShot(null)} />
    </>
  );
}

type StepEmail = NonNullable<NonNullable<StepResultRow['responseJson']>['email']>;

type DbStepQuery = {
  connection?: string;
  engine?: string;
  sql?: string;
  params?: unknown[];
  columns?: string[];
  rows?: Record<string, unknown>[];
  rowCount?: number;
  affected?: number;
  truncated?: boolean;
  rollbackMode?: boolean;
  readOnly?: boolean;
  audit?: { findings: { message: string }[]; coverage: unknown[] };
};

/** The SQL a database step ran, its parameters (secrets already masked) and the rows it returned. */
function DbQueryPanel({ q }: { q: DbStepQuery }) {
  return (
    <div className="space-y-1.5">
      <p className="font-medium text-muted">
        {q.connection} · {q.engine}
        {q.readOnly && ' · read-only'}
        {q.rollbackMode && ' · rollback mode'}
      </p>
      {q.sql && (
        <pre className="max-h-40 overflow-auto rounded border border-border bg-bg p-2 font-mono text-[11px] whitespace-pre-wrap">
          {q.sql}
          {q.params?.length ? `\n-- params: ${JSON.stringify(q.params)}` : ''}
        </pre>
      )}
      {q.columns && q.columns.length > 0 && q.rows && (
        <>
          <ResultsGrid columns={q.columns} rows={q.rows} maxHeight={220} />
          {q.truncated && (
            <p className="text-muted">
              Showing the first {q.rows.length} of {q.rowCount} rows.
            </p>
          )}
        </>
      )}
      {q.audit && (
        <p className="text-muted">
          {q.audit.findings.length} issue(s) from {q.audit.coverage.length} checks
        </p>
      )}
    </div>
  );
}
