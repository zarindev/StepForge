import { useMutation } from '@tanstack/react-query';
import { CheckCircle2, ClipboardCheck, FileCode2, Save, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Switch } from '@/components/ui/input';
import { EmptyState } from '@/components/ui/states';
import { toastError } from '@/components/ui/toast';
import { api } from '@/lib/api';
import type { AuditCheck, AuditFinding, AuditReport, DbConnection, DbSchema } from '@/lib/types';
import { ResultsGrid } from './results-grid';

const CHECKS: { value: AuditCheck; label: string; hint: string }[] = [
  {
    value: 'orphans',
    label: 'Orphaned references',
    hint: 'Foreign keys (declared, or inferred from x_id names) pointing at missing rows',
  },
  {
    value: 'duplicates',
    label: 'Duplicates',
    hint: 'Email/phone/code-like columns, and name + date of birth',
  },
  { value: 'nulls', label: 'Missing required values', hint: 'NULL or empty in name/title/status columns' },
  { value: 'formats', label: 'Invalid formats', hint: 'Email and phone columns' },
  {
    value: 'negatives',
    label: 'Negative numbers',
    hint: 'Price, amount, quantity, stock, fee, total… columns',
  },
];
const SEVERITY_TONE = { high: 'fail', medium: 'warn', low: 'skip' } as const;

export function AuditPanel({
  connection,
  schema,
  onOpenSql,
  onSaveFinding,
  onSaveAudit,
}: {
  connection: DbConnection;
  schema: DbSchema;
  onOpenSql: (sql: string) => void;
  onSaveFinding: (f: AuditFinding) => void;
  onSaveAudit: (tables: string[], checks: AuditCheck[]) => void;
}) {
  const auditable = schema.tables.filter((t) => t.kind !== 'view');
  const [tables, setTables] = useState<Set<string>>(() => new Set(auditable.map((t) => t.name)));
  const [checks, setChecks] = useState<Set<AuditCheck>>(() => new Set(CHECKS.map((c) => c.value)));
  const run = useMutation({
    mutationFn: () =>
      api<AuditReport>(`/api/connections/${connection.id}/audit`, {
        method: 'POST',
        json: { tables: [...tables], checks: [...checks] },
      }),
    onError: toastError,
  });
  const toggle = <T,>(set: Set<T>, v: T, on: boolean) => {
    const next = new Set(set);
    if (on) next.add(v);
    else next.delete(v);
    return next;
  };
  const report = run.data;

  return (
    <div className="grid gap-4 lg:grid-cols-[280px_1fr]">
      <Card className="space-y-4 p-4">
        <div>
          <p className="mb-2 text-xs font-medium text-muted">Checks</p>
          <ul className="space-y-2">
            {CHECKS.map((c) => (
              <li key={c.value}>
                <label className="flex items-start gap-2 text-sm">
                  <Switch
                    checked={checks.has(c.value)}
                    onChange={(on) => setChecks((s) => toggle(s, c.value, on))}
                    label={c.label}
                    disabled={c.value === 'orphans' && schema.engine === 'mongo'}
                  />
                  <span>
                    {c.label}
                    <span className="block text-[11px] text-muted">{c.hint}</span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
        </div>
        <div>
          <div className="mb-2 flex items-center justify-between">
            <p className="text-xs font-medium text-muted">
              {schema.engine === 'mongo' ? 'Collections' : 'Tables'} ({tables.size}/{auditable.length})
            </p>
            <button
              type="button"
              className="text-[11px] text-brand hover:underline"
              onClick={() =>
                setTables(
                  tables.size === auditable.length ? new Set() : new Set(auditable.map((t) => t.name)),
                )
              }
            >
              {tables.size === auditable.length ? 'None' : 'All'}
            </button>
          </div>
          <ul className="max-h-60 space-y-1 overflow-auto text-sm">
            {auditable.map((t) => (
              <li key={t.name}>
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    className="accent-brand"
                    checked={tables.has(t.name)}
                    onChange={(e) => setTables((s) => toggle(s, t.name, e.target.checked))}
                  />
                  <span className="truncate font-mono text-xs">{t.name}</span>
                </label>
              </li>
            ))}
          </ul>
        </div>
        <div className="flex flex-col gap-2">
          <Button disabled={!tables.size || !checks.size || run.isPending} onClick={() => run.mutate()}>
            <ShieldCheck className="h-4 w-4" /> {run.isPending ? 'Auditing…' : 'Run audit'}
          </Button>
          <Button
            variant="outline"
            disabled={!tables.size || !checks.size}
            onClick={() => onSaveAudit([...tables], [...checks])}
            title="Adds a db.dataQualityCheck step that fails when issues appear"
          >
            <Save className="h-4 w-4" /> Save as DB test
          </Button>
        </div>
        <p className="text-[11px] text-muted">The audit only reads (it always connects read-only).</p>
      </Card>

      <div className="min-w-0 space-y-3">
        {!report && !run.isPending && (
          <EmptyState
            icon={ClipboardCheck}
            title="Data quality audit"
            description="Pick tables and checks, then run the audit. Each finding comes with sample rows and the query that found it."
          />
        )}
        {report && (
          <>
            <div className="flex flex-wrap items-center gap-2 text-sm" role="status">
              {report.findings.length === 0 ? (
                <span className="flex items-center gap-1.5 text-pass">
                  <CheckCircle2 className="h-4 w-4" /> No issues found
                </span>
              ) : (
                <span className="font-medium">
                  {report.findings.length} issue{report.findings.length === 1 ? '' : 's'} found
                </span>
              )}
              <span className="text-muted">
                · {report.coverage.length} checks on {report.tables.length} table
                {report.tables.length === 1 ? '' : 's'} in {report.durationMs} ms
              </span>
            </div>
            {report.notes.map((n) => (
              <p key={n} className="text-xs text-muted">
                {n}
              </p>
            ))}
            {report.findings.map((f, i) => (
              <Card key={i} className="space-y-2 p-3" data-testid="audit-finding">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={SEVERITY_TONE[f.severity]}>{f.severity}</Badge>
                  <Badge>{CHECKS.find((c) => c.value === f.check)?.label ?? f.check}</Badge>
                  <span className="text-sm">{f.message}</span>
                  <span className="ml-auto flex gap-1">
                    {f.sql && (
                      <>
                        <Button variant="ghost" size="sm" onClick={() => onOpenSql(f.sql!)}>
                          <FileCode2 className="h-3.5 w-3.5" /> Open query
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => onSaveFinding(f)}>
                          <Save className="h-3.5 w-3.5" /> Save as test
                        </Button>
                      </>
                    )}
                  </span>
                </div>
                {f.sample.length > 0 && <ResultsGrid columns={[]} rows={f.sample} maxHeight={180} />}
              </Card>
            ))}
            {report.coverage.length > 0 && (
              <details className="text-xs text-muted">
                <summary className="cursor-pointer">What was checked</summary>
                <ul className="mt-1 space-y-0.5 font-mono">
                  {report.coverage.map((c, i) => (
                    <li key={i}>
                      {c.check}: {c.table}.{c.columns.join('+')}
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </>
        )}
      </div>
    </div>
  );
}
