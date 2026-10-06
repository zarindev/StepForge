import { CheckCircle2, XCircle } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import type { LoadReport, LoadTick } from '@/lib/types';
import { LineChart } from './line-chart';

/** Live chart while a test runs (per-second requests and p95 latency). */
export function LoadTimeline({ points }: { points: Pick<LoadTick, 'requests' | 'p95'>[] }) {
  return (
    <LineChart
      label="Load test timeline"
      series={[
        {
          label: 'Requests per second',
          color: '#F97316',
          unit: 'req/s',
          values: points.map((p) => p.requests),
        },
        { label: 'p95 latency', color: '#6366F1', unit: 'ms', values: points.map((p) => p.p95) },
      ]}
    />
  );
}

/** A finished load test: verdict, key numbers, thresholds, timeline and status codes. */
export function LoadReportView({ report }: { report: LoadReport }) {
  const stats: [string, string][] = [
    ['Requests', String(report.requests)],
    ['Throughput', `${report.rps} req/s`],
    ['p50', `${report.latency.p50} ms`],
    ['p95', `${report.latency.p95} ms`],
    ['p99', `${report.latency.p99} ms`],
    ['Errors', `${report.errorRatePct}%`],
  ];
  return (
    <div className="space-y-4" data-testid="load-report">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        {report.cancelled ? (
          <Badge tone="skip">Cancelled</Badge>
        ) : report.thresholds.length === 0 ? (
          <Badge>No thresholds</Badge>
        ) : report.passed ? (
          <Badge tone="pass">Thresholds passed</Badge>
        ) : (
          <Badge tone="fail">Thresholds failed</Badge>
        )}
        <span className="text-muted">
          {report.target} · {report.profile} · {report.vus} VUs · {report.durationS} s ·{' '}
          {report.engine === 'k6' ? 'k6' : 'built-in engine'}
        </span>
      </div>
      <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
        {stats.map(([k, v]) => (
          <div key={k} className="rounded-lg border border-border px-3 py-2">
            <div className="text-[11px] text-muted">{k}</div>
            <div className="font-mono text-sm font-semibold tabular-nums">{v}</div>
          </div>
        ))}
      </div>
      {report.thresholds.length > 0 && (
        <ul className="space-y-1 text-sm" aria-label="Thresholds">
          {report.thresholds.map((t) => (
            <li key={t.metric} className={`flex items-center gap-2 ${t.passed ? 'text-pass' : 'text-fail'}`}>
              {t.passed ? <CheckCircle2 className="h-4 w-4" /> : <XCircle className="h-4 w-4" />}
              {t.message}
            </li>
          ))}
        </ul>
      )}
      {report.timeline.length > 0 && <LoadTimeline points={report.timeline} />}
      {Object.keys(report.statusCodes).length > 0 && (
        <p className="text-xs text-muted">
          Responses:{' '}
          {Object.entries(report.statusCodes)
            .map(([code, n]) => `${code === 'error' ? 'connection errors' : code} × ${n}`)
            .join(' · ')}
          {' · '}min {report.latency.min} ms · avg {report.latency.avg} ms · max {report.latency.max} ms
        </p>
      )}
    </div>
  );
}
