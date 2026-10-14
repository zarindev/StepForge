import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Eye, Plus, Save, Table2, Trash2, X } from 'lucide-react';
import { useState } from 'react';
import { CodeEditor } from '@/components/editor/code-editor';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm';
import { Field, Input, Select } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/ui/states';
import { toast, toastError } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { useConnections, useEnvironments } from '@/lib/queries';
import type { Application } from '@/lib/types';
import { cn } from '@/lib/utils';

type Kind = 'table' | 'csv' | 'sql' | 'api';
type Source = {
  id: string;
  name: string;
  kind: Kind;
  description: string;
  configJson: Record<string, unknown>;
  columnsJson: string[];
  rowsJson: Record<string, string>[];
  usedBySteps: number;
};
type Preview = { columns: string[]; rows: Record<string, unknown>[]; total: number };

const KIND_LABEL: Record<Kind, string> = {
  table: 'Table (rows kept in StepForge)',
  csv: 'CSV file on this computer',
  sql: 'SQL query (read-only)',
  api: 'API call',
};

/** Pasted CSV → columns and rows (quotes, "" escapes, commas and line breaks inside quotes). */
function parseCsv(text: string): { columns: string[]; rows: Record<string, string>[] } {
  const records: string[][] = [];
  let field = '';
  let record: string[] = [];
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"' && field === '') quoted = true;
    else if (ch === ',') {
      record.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      record.push(field);
      records.push(record);
      record = [];
      field = '';
    } else field += ch;
  }
  if (field || record.length) {
    record.push(field);
    records.push(record);
  }
  const [header, ...body] = records.filter((r) => r.some((c) => c.trim()));
  const columns = (header ?? []).map((h, i) => h.trim() || `column${i + 1}`);
  return { columns, rows: body.map((r) => Object.fromEntries(columns.map((c, i) => [c, r[i] ?? '']))) };
}

/**
 * The test data library: data sources a `util.useData` step reads a row from (first, random, a given row, a matching
 * row, or one not used yet in the run). Everything is read locally: rows kept here, a CSV file, a read-only SQL query
 * on one of this application's connections, or an API call to the application.
 */
export function DataTab({ app }: { app: Application }) {
  const qc = useQueryClient();
  const list = useQuery({
    queryKey: ['data-sources', app.id],
    queryFn: () => api<Source[]>(`/api/applications/${app.id}/data-sources`),
  });
  const [selected, setSelected] = useState<string | 'new' | null>(null);
  const [deleting, setDeleting] = useState<Source | null>(null);
  const current =
    selected === 'new' ? null : (list.data?.find((d) => d.id === selected) ?? list.data?.[0] ?? null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['data-sources', app.id] });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/api/data-sources/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      void refresh();
      setSelected(null);
      setDeleting(null);
    },
    onError: toastError,
  });

  if (list.isPending) return <Skeleton className="h-40" />;
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <p className="text-sm text-muted">
          Named data your tests read rows from with a <b>util.useData</b> step — the row becomes{' '}
          <code>{'{{vars.<name>.<column>}}'}</code>. Pick the first row, a random one, a given row, the row
          matching a value, or one no other test used yet in the run. Rows are read once per run.
        </p>
        <Button size="sm" onClick={() => setSelected('new')}>
          <Plus className="h-3.5 w-3.5" /> New data source
        </Button>
      </div>
      {list.data?.length === 0 && selected !== 'new' ? (
        <EmptyState
          icon={Table2}
          title="No test data yet"
          description="Add a table of rows, a CSV file, a read-only SQL query or an API call, then read it from any test."
        />
      ) : (
        <div className="grid gap-4 lg:grid-cols-[260px_1fr]">
          <Card className="h-fit p-1.5" aria-label="Data sources">
            {list.data?.map((d) => (
              <button
                key={d.id}
                onClick={() => setSelected(d.id)}
                className={cn(
                  'flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-fg/[0.04]',
                  current?.id === d.id && selected !== 'new' && 'bg-brand/10',
                )}
              >
                <span className="flex-1 truncate">{d.name}</span>
                <Badge className="shrink-0">{d.kind}</Badge>
                <span className="text-xs text-muted" title="Steps that use it">
                  {d.usedBySteps}
                </span>
              </button>
            ))}
          </Card>
          <Card className="p-4">
            <SourceEditor
              key={selected === 'new' ? 'new' : `${current?.id}:${current?.name}`}
              app={app}
              source={selected === 'new' ? null : current}
              onSaved={(id) => {
                void refresh();
                setSelected(id);
              }}
              onDelete={(s) => setDeleting(s)}
            />
          </Card>
        </div>
      )}
      <ConfirmDialog
        open={!!deleting}
        onClose={() => setDeleting(null)}
        title={`Delete data source "${deleting?.name ?? ''}"?`}
        description={
          deleting?.usedBySteps
            ? `${deleting.usedBySteps} step(s) read it; they will stop with "No data source named ${deleting.name}".`
            : 'No step reads it.'
        }
        busy={remove.isPending}
        onConfirm={() => deleting && remove.mutate(deleting.id)}
      />
    </div>
  );
}

function SourceEditor({
  app,
  source,
  onSaved,
  onDelete,
}: {
  app: Application;
  source: Source | null;
  onSaved: (id: string) => void;
  onDelete: (s: Source) => void;
}) {
  const envs = useEnvironments(app.id);
  const conns = useConnections(app.id);
  const cfg = source?.configJson ?? {};
  const [name, setName] = useState(source?.name ?? '');
  const [kind, setKind] = useState<Kind>(source?.kind ?? 'table');
  const [description, setDescription] = useState(source?.description ?? '');
  const [columns, setColumns] = useState<string[]>(
    source?.columnsJson.length ? source.columnsJson : ['name'],
  );
  const [rows, setRows] = useState<Record<string, string>[]>(source?.rowsJson ?? []);
  const [path, setPath] = useState(String(cfg.path ?? ''));
  const [connection, setConnection] = useState(String(cfg.connection ?? ''));
  const [query, setQuery] = useState(String(cfg.query ?? 'SELECT * FROM '));
  const [method, setMethod] = useState(String(cfg.method ?? 'GET'));
  const [url, setUrl] = useState(String(cfg.url ?? '/api/'));
  const [rowsPath, setRowsPath] = useState(String(cfg.rowsPath ?? '$'));
  const [headers, setHeaders] = useState(
    Object.entries((cfg.headers as Record<string, string>) ?? {})
      .map(([k, v]) => `${k}: ${v}`)
      .join('\n'),
  );
  const [pasting, setPasting] = useState(false);
  const [csvText, setCsvText] = useState('');
  const [envId, setEnvId] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const connNames = [...new Set((conns.data ?? []).map((c) => c.name))];

  const body = () => {
    const common = { name, description, kind };
    if (kind === 'table') return { ...common, columns, rows };
    if (kind === 'csv') return { ...common, config: { path } };
    if (kind === 'sql') return { ...common, config: { connection, query } };
    return {
      ...common,
      config: {
        method,
        url,
        rowsPath,
        headers: Object.fromEntries(
          headers
            .split('\n')
            .map((l) => l.split(/:(.*)/s).map((x) => x.trim()))
            .filter(([k]) => k)
            .map(([k, v]) => [k!, v ?? '']),
        ),
      },
    };
  };
  const save = useMutation({
    mutationFn: () =>
      source
        ? api<Source>(`/api/data-sources/${source.id}`, { method: 'PUT', json: body() })
        : api<Source>(`/api/applications/${app.id}/data-sources`, { method: 'POST', json: body() }),
    onSuccess: (s) => {
      toast(source ? 'Data source saved' : 'Data source created');
      onSaved(s.id);
    },
    onError: toastError,
  });
  const runPreview = useMutation({
    mutationFn: () =>
      api<Preview>(`/api/data-sources/${source!.id}/preview`, {
        method: 'POST',
        json: { environmentId: envId || envs.data?.[0]?.id },
      }),
    onSuccess: setPreview,
    onError: toastError,
  });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 font-semibold">
          <Table2 className="h-4 w-4 text-brand" /> {source ? source.name : 'New data source'}
          {source && (
            <span className="text-xs font-normal text-muted">· read by {source.usedBySteps} step(s)</span>
          )}
        </h3>
        <div className="flex gap-2">
          {source && (
            <Button variant="ghost" size="sm" onClick={() => onDelete(source)}>
              <Trash2 className="h-3.5 w-3.5" /> Delete
            </Button>
          )}
          <Button size="sm" disabled={!name.trim() || save.isPending} onClick={() => save.mutate()}>
            <Save className="h-3.5 w-3.5" /> {source ? 'Save' : 'Create'}
          </Button>
        </div>
      </div>
      <div className="grid gap-3 md:grid-cols-3">
        <Field label="Name" hint="Steps refer to it by name; renaming updates them">
          <Input
            aria-label="Data source name"
            value={name}
            placeholder="patients"
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <Field label="Kind">
          <Select
            aria-label="Data source kind"
            value={kind}
            disabled={!!source}
            onChange={(e) => setKind(e.target.value as Kind)}
          >
            {(Object.keys(KIND_LABEL) as Kind[]).map((k) => (
              <option key={k} value={k}>
                {KIND_LABEL[k]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Description">
          <Input
            aria-label="Data source description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </Field>
      </div>

      {kind === 'table' && (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-medium text-muted">Columns and rows</span>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setColumns([...columns, `column${columns.length + 1}`])}
            >
              <Plus className="h-3.5 w-3.5" /> Column
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setRows([...rows, Object.fromEntries(columns.map((c) => [c, '']))])}
            >
              <Plus className="h-3.5 w-3.5" /> Row
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setPasting(!pasting)}>
              Paste CSV
            </Button>
          </div>
          {pasting && (
            <div className="space-y-2 rounded-lg border border-border p-3">
              <textarea
                aria-label="CSV text"
                className="h-28 w-full rounded-md border border-border bg-bg p-2 font-mono text-xs"
                placeholder={'email,role\nana@clinic.test,admin'}
                value={csvText}
                onChange={(e) => setCsvText(e.target.value)}
              />
              <Button
                size="sm"
                disabled={!csvText.trim()}
                onClick={() => {
                  const p = parseCsv(csvText);
                  setColumns(p.columns);
                  setRows(p.rows);
                  setPasting(false);
                  setCsvText('');
                }}
              >
                Use these rows
              </Button>
            </div>
          )}
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-xs" aria-label="Table rows">
              <thead>
                <tr className="border-b border-border">
                  <th className="w-8" />
                  {columns.map((c, i) => (
                    <th key={i} className="p-1">
                      <div className="flex items-center gap-1">
                        <Input
                          aria-label={`Column ${i + 1}`}
                          className="h-7 font-mono text-xs"
                          value={c}
                          onChange={(e) => {
                            const next = [...columns];
                            next[i] = e.target.value;
                            setRows(rows.map((r) => ({ ...r, [e.target.value]: r[c] ?? '' })));
                            setColumns(next);
                          }}
                        />
                        {columns.length > 1 && (
                          <button
                            aria-label={`Remove column ${c}`}
                            className="text-muted hover:text-fail"
                            onClick={() => setColumns(columns.filter((_, j) => j !== i))}
                          >
                            <X className="h-3.5 w-3.5" />
                          </button>
                        )}
                      </div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r, ri) => (
                  <tr key={ri} className="border-b border-border/60 last:border-0">
                    <td className="px-1 text-center font-mono text-muted">{ri + 1}</td>
                    {columns.map((c) => (
                      <td key={c} className="p-1">
                        <Input
                          aria-label={`Row ${ri + 1} ${c}`}
                          className="h-7 text-xs"
                          value={r[c] ?? ''}
                          onChange={(e) =>
                            setRows(rows.map((x, j) => (j === ri ? { ...x, [c]: e.target.value } : x)))
                          }
                        />
                      </td>
                    ))}
                    <td>
                      <button
                        aria-label={`Remove row ${ri + 1}`}
                        className="px-1 text-muted hover:text-fail"
                        onClick={() => setRows(rows.filter((_, j) => j !== ri))}
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {rows.length === 0 && (
              <p className="p-3 text-xs text-muted">No rows yet — add some or paste CSV.</p>
            )}
          </div>
        </div>
      )}
      {kind === 'csv' && (
        <Field
          label="CSV file"
          hint="A .csv, .tsv or .txt file: an absolute path, or relative to StepForge's data folder. The first line holds the column names."
        >
          <Input
            aria-label="CSV path"
            className="font-mono"
            value={path}
            placeholder="test-data/patients.csv"
            onChange={(e) => setPath(e.target.value)}
          />
        </Field>
      )}
      {kind === 'sql' && (
        <div className="space-y-3">
          <Field
            label="Connection"
            hint="The run uses the connection with this name in its environment. The query always runs read-only."
          >
            <Select
              aria-label="Connection"
              value={connection}
              onChange={(e) => setConnection(e.target.value)}
            >
              <option value="">Choose…</option>
              {connNames.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </Select>
          </Field>
          <div className="space-y-1.5">
            <span className="text-xs font-medium text-muted">Query (each result row is one data row)</span>
            <CodeEditor
              ariaLabel="Data source query"
              language="sql"
              value={query}
              onChange={setQuery}
              height={120}
            />
          </div>
        </div>
      )}
      {kind === 'api' && (
        <div className="grid gap-3 md:grid-cols-[120px_1fr]">
          <Field label="Method">
            <Select aria-label="Method" value={method} onChange={(e) => setMethod(e.target.value)}>
              <option>GET</option>
              <option>POST</option>
            </Select>
          </Field>
          <Field
            label="URL"
            hint="Absolute, or relative to the environment's base URL; {{env.…}} and {{secret.…}} allowed"
          >
            <Input
              aria-label="Data source URL"
              className="font-mono"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
          </Field>
          <Field label="Rows at" hint="JSONPath to the list, e.g. $.items" className="md:col-span-2">
            <Input
              aria-label="Rows path"
              className="font-mono"
              value={rowsPath}
              onChange={(e) => setRowsPath(e.target.value)}
            />
          </Field>
          <Field label="Headers (one per line, Name: value)" className="md:col-span-2">
            <textarea
              aria-label="Headers"
              className="h-20 w-full rounded-md border border-border bg-bg p-2 font-mono text-xs"
              value={headers}
              placeholder="Authorization: Bearer {{secret.apiToken}}"
              onChange={(e) => setHeaders(e.target.value)}
            />
          </Field>
        </div>
      )}

      {source && (
        <section aria-label="Preview" className="space-y-2 border-t border-border pt-3">
          <div className="flex flex-wrap items-end gap-2">
            <Field label="Preview in">
              <Select
                aria-label="Preview environment"
                value={envId}
                onChange={(e) => setEnvId(e.target.value)}
              >
                {envs.data?.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Button
              variant="outline"
              size="sm"
              disabled={runPreview.isPending || !envs.data?.length}
              onClick={() => runPreview.mutate()}
            >
              <Eye className="h-3.5 w-3.5" /> Preview rows
            </Button>
            {preview && (
              <span className="text-xs text-muted">
                {preview.total} row(s){preview.total > 50 ? ', first 50 shown' : ''}
              </span>
            )}
          </div>
          {preview && preview.rows.length > 0 && (
            <div className="max-h-72 overflow-auto rounded-lg border border-border">
              <table className="w-full text-xs" aria-label="Preview rows">
                <thead>
                  <tr className="border-b border-border text-left text-muted">
                    <th className="px-2 py-1">#</th>
                    {preview.columns.map((c) => (
                      <th key={c} className="px-2 py-1 font-mono">
                        {c}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {preview.rows.map((r, i) => (
                    <tr key={i} className="border-b border-border/60 last:border-0">
                      <td className="px-2 py-1 text-muted">{i + 1}</td>
                      {preview.columns.map((c) => (
                        <td key={c} className="px-2 py-1 font-mono">
                          {typeof r[c] === 'object' ? JSON.stringify(r[c]) : String(r[c] ?? '')}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
