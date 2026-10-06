import { cn } from '@/lib/utils';

const COLORS = { passed: '#22C55E', failed: '#EF4444', flaky: '#EAB308', other: '#64748B' } as const;
type TrendPoint = { date: string; passed: number; failed: number; flaky: number; other: number };

/** Daily results as stacked columns (passed / flaky / failed / other), one per day. */
export function StackedTrend({ points, height = 180 }: { points: TrendPoint[]; height?: number }) {
  const width = 640;
  const pad = { l: 32, r: 8, t: 8, b: 20 };
  const keys = ['passed', 'flaky', 'failed', 'other'] as const;
  const max = Math.max(1, ...points.map((p) => keys.reduce((s, k) => s + p[k], 0)));
  const slot = (width - pad.l - pad.r) / Math.max(1, points.length);
  const bar = Math.max(2, slot * 0.7);
  const h = (v: number) => (v / max) * (height - pad.t - pad.b);
  const base = height - pad.b;
  return (
    <figure className="space-y-1">
      <svg viewBox={`0 0 ${width} ${height}`} className="w-full" role="img" aria-label="Pass and fail trend">
        {[0, 0.5, 1].map((f) => (
          <g key={f}>
            <line
              x1={pad.l}
              x2={width - pad.r}
              y1={base - h(max * f)}
              y2={base - h(max * f)}
              stroke="currentColor"
              className="text-border"
              strokeDasharray="3 3"
            />
            <text
              x={pad.l - 4}
              y={base - h(max * f) + 3}
              textAnchor="end"
              className="fill-current text-[9px] text-muted"
            >
              {Math.round(max * f)}
            </text>
          </g>
        ))}
        {points.map((p, i) => {
          let y = base;
          return (
            <g key={p.date}>
              <title>{`${p.date}: ${p.passed} passed, ${p.flaky} flaky, ${p.failed} failed`}</title>
              {keys.map((k) => {
                if (!p[k]) return null;
                y -= h(p[k]);
                return (
                  <rect
                    key={k}
                    x={pad.l + i * slot + (slot - bar) / 2}
                    y={y}
                    width={bar}
                    height={h(p[k])}
                    fill={COLORS[k]}
                    rx={1}
                  />
                );
              })}
            </g>
          );
        })}
        {points.length > 0 && (
          <>
            <text x={pad.l} y={height - 4} className="fill-current text-[9px] text-muted">
              {points[0]!.date.slice(5)}
            </text>
            <text
              x={width - pad.r}
              y={height - 4}
              textAnchor="end"
              className="fill-current text-[9px] text-muted"
            >
              {points.at(-1)!.date.slice(5)}
            </text>
          </>
        )}
      </svg>
      <figcaption className="flex gap-4 text-xs text-muted">
        {(['passed', 'flaky', 'failed'] as const).map((k) => (
          <span key={k} className="flex items-center gap-1.5">
            <span className="inline-block h-2 w-2 rounded-sm" style={{ background: COLORS[k] }} />
            {k}
          </span>
        ))}
      </figcaption>
    </figure>
  );
}

export type GroupRow = {
  key: string;
  label: string;
  total: number;
  passed: number;
  failed: number;
  flaky: number;
  skipped: number;
  passRate: number | null;
};

/** Horizontal stacked bars, one per group (module, layer, tag, environment). */
export function GroupBars({ rows, empty = 'No results' }: { rows: GroupRow[]; empty?: string }) {
  if (!rows.length) return <p className="text-sm text-muted">{empty}</p>;
  const max = Math.max(...rows.map((r) => r.total));
  return (
    <ul className="space-y-2 text-sm">
      {rows.map((r) => (
        <li key={r.key}>
          <div className="flex justify-between gap-2 text-xs">
            <span className="truncate">{r.label}</span>
            <span className="shrink-0 font-mono text-muted tabular-nums">
              {r.passRate === null ? '—' : `${r.passRate}%`} · {r.total}
            </span>
          </div>
          <div
            className="mt-1 flex h-2 overflow-hidden rounded-full bg-fg/[0.06]"
            style={{ width: `${Math.max(8, (r.total / max) * 100)}%` }}
          >
            {(['passed', 'flaky', 'failed'] as const).map((k) =>
              r[k] ? (
                <span
                  key={k}
                  style={{ width: `${(r[k] / r.total) * 100}%`, background: COLORS[k] }}
                  title={`${r[k]} ${k}`}
                />
              ) : null,
            )}
            {r.skipped ? (
              <span
                style={{ width: `${(r.skipped / r.total) * 100}%`, background: COLORS.other }}
                title={`${r.skipped} skipped`}
              />
            ) : null}
          </div>
        </li>
      ))}
    </ul>
  );
}

/** A year of days, coloured by pass rate (grey: no runs). */
export function CalendarHeatmap({
  days,
}: {
  days: { date: string; runs: number; tests: number; passRate: number | null }[];
}) {
  const byDate = new Map(days.map((d) => [d.date, d]));
  const end = new Date();
  end.setUTCHours(0, 0, 0, 0);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - 364 - start.getUTCDay());
  const cells: { date: string; d?: (typeof days)[number] }[] = [];
  for (const t = new Date(start); t <= end; t.setUTCDate(t.getUTCDate() + 1)) {
    const date = t.toISOString().slice(0, 10);
    cells.push({ date, d: byDate.get(date) });
  }
  const colour = (rate: number | null | undefined) =>
    rate === null || rate === undefined
      ? 'var(--color-border)'
      : rate >= 95
        ? '#22C55E'
        : rate >= 80
          ? '#84CC16'
          : rate >= 60
            ? '#EAB308'
            : '#EF4444';
  const size = 11;
  const weeks = Math.ceil(cells.length / 7);
  return (
    <svg
      viewBox={`0 0 ${weeks * (size + 2)} ${7 * (size + 2)}`}
      className="w-full"
      role="img"
      aria-label="Calendar of daily pass rates"
    >
      {cells.map((c, i) => (
        <rect
          key={c.date}
          x={Math.floor(i / 7) * (size + 2)}
          y={(i % 7) * (size + 2)}
          width={size}
          height={size}
          rx={2}
          fill={colour(c.d?.passRate)}
          fillOpacity={c.d ? 0.9 : 0.4}
        >
          <title>
            {c.d
              ? `${c.date}: ${c.d.runs} run(s), ${c.d.tests} tests, ${c.d.passRate ?? '—'}% passed`
              : `${c.date}: no runs`}
          </title>
        </rect>
      ))}
    </svg>
  );
}

/** Recent results of one test, oldest first. */
export function HistoryDots({ history }: { history: string[] }) {
  return (
    <span className="inline-flex gap-0.5" aria-label={`Recent results: ${history.join(', ')}`}>
      {history.map((s, i) => (
        <span
          key={i}
          title={s}
          className="inline-block h-2.5 w-2.5 rounded-full"
          style={{
            background:
              s === 'passed'
                ? COLORS.passed
                : s === 'flaky'
                  ? COLORS.flaky
                  : s === 'skipped'
                    ? COLORS.other
                    : COLORS.failed,
          }}
        />
      ))}
    </span>
  );
}

export const GATE_STYLE: Record<string, { label: string; className: string }> = {
  green: { label: 'Passing', className: 'bg-pass/15 text-pass' },
  amber: { label: 'Warning', className: 'bg-warn/15 text-yellow-600 dark:text-warn' },
  red: { label: 'Failing', className: 'bg-fail/15 text-fail' },
  unknown: { label: 'No data', className: 'bg-fg/[0.06] text-muted' },
};

export function GateChip({ status, className }: { status: string; className?: string }) {
  const s = GATE_STYLE[status] ?? GATE_STYLE.unknown!;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium',
        s.className,
        className,
      )}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
      {s.label}
    </span>
  );
}
