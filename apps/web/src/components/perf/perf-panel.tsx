import { ExternalLink } from 'lucide-react';
import { artifactUrl } from '@/lib/api';
import type { LoadReport } from '@/lib/types';
import { LoadReportView } from './load-report';

export type StepPerf =
  | ({ kind: 'load' } & LoadReport)
  | {
      kind: 'pageMetrics';
      metrics: Record<string, number | string | undefined>;
      thresholds?: Record<string, number>;
    }
  | {
      kind: 'lighthouse';
      url: string;
      scores: Record<string, number>;
      metrics: Record<string, number | undefined>;
    }
  | {
      kind: 'queryPlan';
      connection: string;
      sql: string;
      durationMs: number;
      runs: number[];
      plan: string[];
      fullScans: string[];
      note?: string;
    };

const PAGE_LABEL: [string, string, string][] = [
  ['lcp', 'LCP', 'ms'],
  ['cls', 'CLS', ''],
  ['inp', 'INP', 'ms'],
  ['fcp', 'FCP', 'ms'],
  ['ttfb', 'TTFB', 'ms'],
  ['load', 'Load', 'ms'],
  ['domContentLoaded', 'DOM ready', 'ms'],
  ['requests', 'Requests', ''],
];

/** The performance part of a step result: load report, page metrics, Lighthouse scores or a query plan. */
export function PerfPanel({ perf, reportPath }: { perf: StepPerf; reportPath?: string }) {
  if (perf.kind === 'load') return <LoadReportView report={perf} />;
  if (perf.kind === 'pageMetrics')
    return (
      <div className="flex flex-wrap gap-2" data-testid="page-metrics">
        {PAGE_LABEL.filter(([k]) => perf.metrics[k] !== undefined).map(([k, label, unit]) => (
          <div key={k} className="rounded-lg border border-border px-3 py-1.5">
            <div className="text-[10px] text-muted">{label}</div>
            <div className="font-mono text-sm tabular-nums">
              {String(perf.metrics[k])}
              {unit && ` ${unit}`}
            </div>
          </div>
        ))}
      </div>
    );
  if (perf.kind === 'lighthouse')
    return (
      <div className="space-y-2">
        <div className="flex flex-wrap gap-2">
          {Object.entries(perf.scores).map(([k, v]) => (
            <div key={k} className="rounded-lg border border-border px-3 py-1.5 text-center">
              <div
                className={`font-mono text-lg font-semibold ${v >= 90 ? 'text-pass' : v >= 50 ? 'text-warn' : 'text-fail'}`}
              >
                {v}
              </div>
              <div className="text-[10px] text-muted">{k}</div>
            </div>
          ))}
        </div>
        {reportPath && (
          <a
            href={artifactUrl(reportPath)}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-brand hover:underline"
          >
            <ExternalLink className="h-3 w-3" /> Lighthouse report
          </a>
        )}
      </div>
    );
  return (
    <div className="space-y-1.5">
      <p className="text-muted">
        {perf.connection} · median {perf.durationMs} ms of {perf.runs.length} run(s){' '}
        {perf.fullScans.length > 0 && (
          <span className="text-fail">· full scan on {perf.fullScans.join(', ')}</span>
        )}
      </p>
      <pre className="max-h-40 overflow-auto rounded border border-border bg-bg p-2 font-mono text-[11px] whitespace-pre-wrap">
        {perf.plan.length ? perf.plan.join('\n') : (perf.note ?? 'No plan available')}
      </pre>
    </div>
  );
}
