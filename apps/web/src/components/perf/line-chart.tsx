/** Minimal dependency-free SVG line chart: one shared x axis (seconds), one or two series with their own y scales. */
export type Series = { label: string; color: string; values: number[]; unit: string };

export function LineChart({
  series,
  height = 180,
  label,
}: {
  series: Series[];
  height?: number;
  label: string;
}) {
  const width = 640;
  const pad = { l: 44, r: 44, t: 12, b: 22 };
  const n = Math.max(...series.map((s) => s.values.length), 1);
  const x = (i: number) => pad.l + (n <= 1 ? 0 : (i / (n - 1)) * (width - pad.l - pad.r));
  const scales = series.map((s) => Math.max(1, ...s.values) * 1.1);
  const y = (v: number, k: number) => pad.t + (1 - v / scales[k]!) * (height - pad.t - pad.b);
  return (
    <figure className="space-y-1">
      <svg viewBox={`0 0 ${width} ${height}`} className="w-full" role="img" aria-label={label}>
        {[0, 0.5, 1].map((f) => (
          <line
            key={f}
            x1={pad.l}
            x2={width - pad.r}
            y1={pad.t + f * (height - pad.t - pad.b)}
            y2={pad.t + f * (height - pad.t - pad.b)}
            stroke="currentColor"
            className="text-border"
            strokeDasharray="3 3"
          />
        ))}
        {series.map((s, k) => (
          <g key={s.label}>
            <polyline
              fill="none"
              stroke={s.color}
              strokeWidth={2}
              strokeLinejoin="round"
              points={s.values.map((v, i) => `${x(i)},${y(v, k)}`).join(' ')}
            />
            {s.values.length === 1 && <circle cx={x(0)} cy={y(s.values[0]!, k)} r={3} fill={s.color} />}
            <text
              x={k === 0 ? pad.l - 6 : width - pad.r + 6}
              y={pad.t + 4}
              textAnchor={k === 0 ? 'end' : 'start'}
              className="fill-current text-[10px] text-muted"
            >
              {Math.round(scales[k]! / 1.1)}
            </text>
          </g>
        ))}
        <text x={pad.l} y={height - 6} className="fill-current text-[10px] text-muted">
          0 s
        </text>
        <text
          x={width - pad.r}
          y={height - 6}
          textAnchor="end"
          className="fill-current text-[10px] text-muted"
        >
          {n} s
        </text>
      </svg>
      <figcaption className="flex flex-wrap gap-4 text-xs text-muted">
        {series.map((s) => (
          <span key={s.label} className="flex items-center gap-1.5">
            <span className="inline-block h-0.5 w-4" style={{ background: s.color }} />
            {s.label} ({s.unit})
          </span>
        ))}
      </figcaption>
    </figure>
  );
}
