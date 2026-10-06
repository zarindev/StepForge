import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import {
  Activity,
  AppWindow,
  Bug,
  CalendarClock,
  FileCheck2,
  Gauge,
  Layers,
  PlayCircle,
  Repeat,
  Sparkles,
  Timer,
} from 'lucide-react';
import { motion } from 'motion/react';
import { useCallback } from 'react';
import { GateChip, StackedTrend } from '@/components/analytics/charts';
import { StatusIcon } from '@/components/runs/status';
import { PageHeader } from '@/components/shell/layout';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { api, type SystemInfo } from '@/lib/api';
import { setCurrentAppId } from '@/lib/current-app';
import { useLiveEvent, type LiveEvent } from '@/lib/live';
import type { HomeSummary, UpcomingSchedule } from '@/lib/types';

const fmtDuration = (ms: number | null) =>
  ms === null
    ? '—'
    : ms < 1000
      ? `${ms} ms`
      : ms < 60_000
        ? `${(ms / 1000).toFixed(1)} s`
        : `${(ms / 60_000).toFixed(1)} min`;

export function HomePage() {
  const system = useQuery({ queryKey: ['system'], queryFn: () => api<SystemInfo>('/api/system') });
  const home = useQuery({
    queryKey: ['analytics-home'],
    queryFn: () => api<HomeSummary>('/api/analytics/home'),
  });
  // Refresh when a run finishes anywhere.
  const onEvent = useCallback(
    (e: LiveEvent) => {
      if (e.type === 'analytics.updated') void home.refetch();
    },
    [home],
  );
  useLiveEvent(onEvent);

  const k = home.data?.kpis;
  const kpis = [
    { label: 'Applications', value: k?.applications, icon: AppWindow, tint: 'text-brand bg-brand/10' },
    { label: 'Scenarios', value: k?.scenarios, icon: Layers, tint: 'text-indigo bg-indigo/10' },
    { label: 'Test cases', value: k?.testCases, icon: FileCheck2, tint: 'text-pass bg-pass/10' },
    { label: 'Runs this week', value: k?.runsThisWeek, icon: PlayCircle, tint: 'text-sky-400 bg-sky-400/10' },
    {
      label: 'Pass rate (7 days)',
      value: k?.passRate === null ? '—' : `${k?.passRate}%`,
      icon: Activity,
      tint: 'text-pass bg-pass/10',
    },
    {
      label: 'Flaky rate (7 days)',
      value: k?.flakyRate === null ? '—' : `${k?.flakyRate}%`,
      icon: Repeat,
      tint: 'text-warn bg-warn/10',
    },
    { label: 'Open bugs', value: k?.openBugs, icon: Bug, tint: 'text-fail bg-fail/10' },
    {
      label: 'Avg run duration',
      value: k ? fmtDuration(k.avgDurationMs) : undefined,
      icon: Timer,
      tint: 'text-muted bg-fg/[0.06]',
    },
  ];
  const hasResults = !!home.data && home.data.recentRuns.length > 0;

  return (
    <>
      <PageHeader title="Home" description="Quality across every application, layer and environment." />
      {(system.isError || home.isError) && (
        <ErrorState
          error={(system.error ?? home.error)!}
          onRetry={() => void Promise.all([system.refetch(), home.refetch()])}
        />
      )}

      <div className="grid grid-cols-2 gap-4 md:grid-cols-4" data-testid="kpis">
        {kpis.map((x, i) => (
          <motion.div
            key={x.label}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: i * 0.03 }}
          >
            <Card className="p-4">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-muted">{x.label}</span>
                <span className={`grid h-7 w-7 place-items-center rounded-lg ${x.tint}`}>
                  <x.icon className="h-3.5 w-3.5" />
                </span>
              </div>
              {home.isPending ? (
                <Skeleton className="mt-3 h-7 w-12" />
              ) : (
                <div className="mt-2 font-mono text-2xl font-semibold tabular-nums">{x.value ?? '—'}</div>
              )}
            </Card>
          </motion.div>
        ))}
      </div>

      {home.isPending ? (
        <Skeleton className="mt-6 h-64" />
      ) : !hasResults ? (
        <div className="mt-6">
          <EmptyState
            icon={Sparkles}
            title="Welcome to StepForge"
            description="Your local QA studio is running. Add an application to start organising, recording and running tests. Trends, quality gates and recent runs appear here as soon as you have results."
            action={
              <Link to={k?.applications ? '/explorer' : '/applications'}>
                <Button>
                  {k?.applications ? 'Open the Test Explorer' : 'Create your first application'}
                </Button>
              </Link>
            }
          />
        </div>
      ) : (
        home.data && (
          <div className="mt-6 grid gap-4 lg:grid-cols-3">
            <Card className="lg:col-span-2">
              <CardHeader>
                <CardTitle>Pass/fail trend (30 days)</CardTitle>
              </CardHeader>
              <CardBody>
                <StackedTrend points={home.data.trend} />
              </CardBody>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>Quality gates</CardTitle>
              </CardHeader>
              <CardBody className="space-y-3" data-testid="home-gates">
                {home.data.gates.map((g) => (
                  <div key={g.applicationId} className="space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="h-2.5 w-2.5 rounded-full" style={{ background: g.color }} />
                      <Link
                        to="/applications/$appId/analytics"
                        params={{ appId: g.applicationId }}
                        onClick={() => setCurrentAppId(g.applicationId)}
                        className="truncate text-sm font-medium hover:underline"
                      >
                        {g.application}
                      </Link>
                      <GateChip status={g.status} className="ml-auto" />
                    </div>
                    {g.gates.length === 0 ? (
                      <p className="text-xs text-muted">No quality gate yet</p>
                    ) : (
                      g.gates
                        .flatMap((gate) => gate.rules.filter((r) => r.passed !== true))
                        .slice(0, 3)
                        .map((r) => (
                          <p
                            key={r.label}
                            className={`text-xs ${r.passed === false ? 'text-fail' : 'text-muted'}`}
                          >
                            {r.passed === false ? '✗' : '?'} {r.label} — {r.message}
                          </p>
                        ))
                    )}
                  </div>
                ))}
              </CardBody>
            </Card>
            <Card className="lg:col-span-2">
              <CardHeader>
                <CardTitle>Recent runs</CardTitle>
              </CardHeader>
              <CardBody className="p-0">
                <ul className="divide-y divide-border" aria-label="Recent runs">
                  {home.data.recentRuns.map((r) => (
                    <li key={r.id}>
                      <Link
                        to="/runs/$runId"
                        params={{ runId: r.id }}
                        className="flex items-center gap-3 px-4 py-2.5 text-sm hover:bg-fg/[0.03]"
                      >
                        <StatusIcon status={r.status} />
                        <span className="h-2 w-2 rounded-full" style={{ background: r.color }} />
                        <span className="min-w-0 flex-1 truncate">{r.application}</span>
                        <span className="font-mono text-xs text-muted tabular-nums">
                          {r.totals.passed ?? 0}/{r.totals.total ?? 0} passed · {fmtDuration(r.durationMs)}
                        </span>
                        <span className="w-32 text-right text-xs text-muted">
                          {new Date(r.createdAt).toLocaleString()}
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </CardBody>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>Upcoming schedules</CardTitle>
              </CardHeader>
              <CardBody>
                <UpcomingSchedules />
              </CardBody>
            </Card>
          </div>
        )
      )}

      <Card className="mt-4">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Gauge className="h-4 w-4" /> Local workspace
          </CardTitle>
        </CardHeader>
        <CardBody className="grid gap-x-8 gap-y-2 text-sm sm:grid-cols-2 lg:grid-cols-3">
          {system.isPending ? (
            <Skeleton className="h-4 w-3/4" />
          ) : system.data ? (
            <>
              <Row label="Version" value={system.data.version} />
              <Row label="Node.js" value={system.data.node} />
              <Row label="Platform" value={system.data.platform} />
              <Row label="Data folder" value={system.data.dataDir} />
              <Row
                label="Step types"
                value={String(Object.values(system.data.stepCatalogue).reduce((n, s) => n + s.length, 0))}
              />
            </>
          ) : null}
        </CardBody>
      </Card>
    </>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4">
      <span className="shrink-0 text-muted">{label}</span>
      <span className="truncate font-mono text-xs leading-5" title={value}>
        {value}
      </span>
    </div>
  );
}

function UpcomingSchedules() {
  const upcoming = useQuery({
    queryKey: ['schedules', 'upcoming'],
    queryFn: () => api<UpcomingSchedule[]>('/api/schedules/upcoming'),
    refetchInterval: 60_000,
  });
  if (upcoming.isPending) return <Skeleton className="h-16 w-full" />;
  if (!upcoming.data?.length)
    return (
      <EmptyState
        icon={CalendarClock}
        title="No schedules"
        description="Run tests every night or every hour and get the results by Telegram or email."
        action={
          <Link to="/schedules">
            <Button size="sm" variant="outline">
              Create a schedule
            </Button>
          </Link>
        }
      />
    );
  return (
    <ul className="divide-y divide-border/60 text-sm" data-testid="upcoming-schedules">
      {upcoming.data.map((s) => (
        <li key={s.id} className="flex items-center gap-3 py-2">
          <CalendarClock className="h-4 w-4 text-muted" />
          <Link to="/schedules" className="min-w-0 flex-1 truncate hover:text-brand">
            {s.name}
            <span className="ml-2 text-xs text-muted">{s.application}</span>
          </Link>
          <span className="text-xs text-muted">{new Date(s.nextRunAt).toLocaleString()}</span>
        </li>
      ))}
    </ul>
  );
}
