import { Download } from 'lucide-react';
import { Button } from '@/components/ui/button';

const cellText = (v: unknown): string =>
  v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);

/** RFC 4180 CSV; cells that look like formulas are prefixed so spreadsheets do not execute them. */
export function toCsv(columns: string[], rows: Record<string, unknown>[]): string {
  const esc = (v: unknown) => {
    let s = cellText(v);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [columns.map(esc).join(','), ...rows.map((r) => columns.map((c) => esc(r[c])).join(','))].join(
    '\r\n',
  );
}

export function downloadCsv(name: string, columns: string[], rows: Record<string, unknown>[]) {
  const blob = new Blob(['\uFEFF', toCsv(columns, rows)], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${name.replace(/[^\w.-]+/g, '_') || 'result'}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export function ResultsGrid({
  columns,
  rows,
  exportName,
  maxHeight = 420,
}: {
  columns: string[];
  rows: Record<string, unknown>[];
  exportName?: string;
  maxHeight?: number;
}) {
  const cols = columns.length ? columns : [...new Set(rows.flatMap((r) => Object.keys(r)))];
  return (
    <div className="space-y-2">
      {exportName && rows.length > 0 && (
        <div className="flex justify-end">
          <Button variant="ghost" size="sm" onClick={() => downloadCsv(exportName, cols, rows)}>
            <Download className="h-3.5 w-3.5" /> Export CSV
          </Button>
        </div>
      )}
      <div className="overflow-auto rounded-lg border border-border" style={{ maxHeight }}>
        <table className="w-full text-xs" data-testid="results-grid">
          <thead className="sticky top-0 bg-surface text-left text-muted">
            <tr>
              <th className="w-10 border-b border-border px-2 py-1.5 text-right font-normal">#</th>
              {cols.map((c) => (
                <th key={c} className="border-b border-border px-2 py-1.5 font-medium whitespace-nowrap">
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="font-mono">
            {rows.map((r, i) => (
              <tr key={i} className="odd:bg-fg/[0.02] hover:bg-brand/5">
                <td className="px-2 py-1 text-right text-muted tabular-nums">{i + 1}</td>
                {cols.map((c) => (
                  <td
                    key={c}
                    className="max-w-72 truncate px-2 py-1 whitespace-nowrap"
                    title={cellText(r[c])}
                  >
                    {r[c] === null || r[c] === undefined ? (
                      <span className="text-muted/60 italic">NULL</span>
                    ) : (
                      cellText(r[c])
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 && <p className="px-3 py-4 text-sm text-muted">No rows.</p>}
      </div>
    </div>
  );
}
