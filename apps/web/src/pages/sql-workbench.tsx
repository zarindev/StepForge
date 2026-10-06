import type { OnMount } from '@monaco-editor/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { AlertTriangle, Database, Lock, Play, RefreshCw, RotateCcw, Save, ShieldAlert } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { AuditPanel } from '@/components/database/audit-panel';
import { ENGINE_LABEL } from '@/components/database/connection-dialog';
import { ResultsGrid } from '@/components/database/results-grid';
import { SaveDbTestDialog, type DraftAssertion } from '@/components/database/save-test-dialog';
import { SchemaTree } from '@/components/database/schema-tree';
import { CodeEditor } from '@/components/editor/code-editor';
import { registerSqlCompletions } from '@/components/editor/sql-completions';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm';
import { Kbd } from '@/components/ui/kbd';
import { Select } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { Tabs } from '@/components/ui/tabs';
import { api, ApiError } from '@/lib/api';
import { qk, useConnections, useCurrentApp } from '@/lib/queries';
import type { DbConnection, DbSchema, DbTable, QueryResult } from '@/lib/types';

const DRAFT_KEY = 'stepforge.sql.drafts';
const readDrafts = (): Record<string, string> => {
  try {
    return JSON.parse(localStorage.getItem(DRAFT_KEY) ?? '{}') as Record<string, string>;
  } catch {
    return {};
  }
};
const writeDraft = (id: string, text: string) => {
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify({ ...readDrafts(), [id]: text }));
  } catch {
    /* storage unavailable: drafts are a convenience only */
  }
};

const ident = (c: DbConnection, name: string) =>
  /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)
    ? name
    : c.engine === 'mysql'
      ? `\`${name}\``
      : c.engine === 'mssql'
        ? `[${name}]`
        : `"${name}"`;

function tableQuery(c: DbConnection, t: DbTable): string {
  if (c.engine === 'mongo') return JSON.stringify({ collection: t.name, find: {}, limit: 50 }, null, 2);
  const name = t.schema ? `${ident(c, t.schema)}.${ident(c, t.name)}` : ident(c, t.name);
  return c.engine === 'mssql' ? `SELECT TOP 100 * FROM ${name};` : `SELECT * FROM ${name} LIMIT 100;`;
}

function starter(c: DbConnection): string {
  return c.engine === 'mongo'
    ? '{\n  "collection": "",\n  "find": {},\n  "limit": 50\n}'
    : '-- Ctrl/Cmd+Enter runs the statement (or the selection)\nSELECT 1;';
}

/** Assertions suggested when saving a result: COUNT-style results check the value, others the row count. */
function suggestAssertions(r: QueryResult): DraftAssertion[] {
  if (r.columns.length === 0)
    return [{ target: 'affected', operator: 'equals', expected: String(r.affected ?? 0) }];
  if (r.rowCount === 1 && r.columns.length === 1) {
    const v = r.rows[0]![r.columns[0]!];
    return [{ target: 'value', operator: 'equals', expected: v === null ? 'null' : String(v) }];
  }
  return [{ target: 'rowCount', operator: 'equals', expected: String(r.rowCount) }];
}

export function SqlWorkbenchPage() {
  const { app, apps } = useCurrentApp();
  const search = useSearch({ from: '/sql' });
  const navigate = useNavigate();
  const conns = useConnections(app?.id);
  const conn = conns.data?.find((c) => c.id === search.connection) ?? conns.data?.[0];
  const qc = useQueryClient();
  const [tab, setTab] = useState<'query' | 'audit'>('query');
  const [sql, setSql] = useState('');
  const [result, setResult] = useState<(QueryResult & { sql: string }) | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [saving, setSaving] = useState<{
    sql: string;
    columns: string[];
    assertions: DraftAssertion[];
    name: string;
    audit?: { tables: string[]; checks: string[] };
  } | null>(null);
  const editorRef = useRef<Parameters<OnMount>[0] | null>(null);
  const runRef = useRef<() => void>(() => {});
  const completions = useRef<{ dispose(): void } | null>(null);
  const monacoRef = useRef<Parameters<OnMount>[1] | null>(null);

  const schema = useQuery({
    queryKey: qk.dbSchema(conn?.id ?? ''),
    queryFn: () => api<DbSchema>(`/api/connections/${conn!.id}/schema`),
    enabled: !!conn,
    retry: false,
  });

  // Load this connection's draft (or a starter query) when switching connections.
  useEffect(() => {
    if (!conn) return;
    setSql(readDrafts()[conn.id] ?? starter(conn));
    setResult(null);
  }, [conn?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Schema-aware autocomplete for the active connection.
  const applyCompletions = () => {
    completions.current?.dispose();
    completions.current = null;
    if (monacoRef.current && schema.data && conn?.engine !== 'mongo')
      completions.current = registerSqlCompletions(monacoRef.current, schema.data);
  };
  useEffect(() => {
    applyCompletions();
    return () => completions.current?.dispose();
  }, [schema.data, conn?.engine]); // eslint-disable-line react-hooks/exhaustive-deps

  const run = useMutation({
    mutationFn: (v: { sql: string; confirm?: string }) =>
      api<QueryResult>(`/api/connections/${conn!.id}/query`, { method: 'POST', json: v }),
    onSuccess: (r, v) => {
      setResult({ ...r, sql: v.sql });
      if (r.write && !r.rolledBack) qc.invalidateQueries({ queryKey: qk.dbSchema(conn!.id) });
    },
    onError: (err, v) => {
      if (err instanceof ApiError && err.status === 403 && /Type the application name/.test(err.message))
        setConfirming(v.sql);
    },
  });

  const selectedOrAll = () => {
    const ed = editorRef.current;
    const sel = ed?.getSelection();
    const text = sel && !sel.isEmpty() ? ed!.getModel()!.getValueInRange(sel) : sql;
    return text.trim();
  };
  runRef.current = () => {
    const text = selectedOrAll();
    if (text && conn && !run.isPending) run.mutate({ sql: text });
  };

  const insert = (text: string, replace = false) => {
    const ed = editorRef.current;
    if (replace || !ed) {
      setSql(text);
      if (conn) writeDraft(conn.id, text);
      ed?.setValue(text);
      return;
    }
    ed.executeEdits('schema', [{ range: ed.getSelection()!, text, forceMoveMarkers: true }]);
    ed.focus();
  };

  if (apps.isPending) return <Skeleton className="h-64" />;
  if (!app)
    return (
      <EmptyState
        icon={Database}
        title="No application yet"
        description="Create an application, then add a database connection to one of its environments."
        action={
          <Link to="/applications">
            <Button>Go to Applications</Button>
          </Link>
        }
      />
    );
  if (conns.isPending) return <Skeleton className="h-64" />;
  if (conns.isError) return <ErrorState error={conns.error} onRetry={() => conns.refetch()} />;
  if (!conn)
    return (
      <EmptyState
        icon={Database}
        title={`No database connections in ${app.name}`}
        description="Open the application's Databases tab to connect SQLite, PostgreSQL, MySQL, SQL Server or MongoDB. Connections are read-only with rollback mode by default."
        action={
          <Link to="/applications/$appId" params={{ appId: app.id }}>
            <Button>Open {app.name}</Button>
          </Link>
        }
      />
    );

  const error = run.error && !confirming ? run.error : null;
  const isMongo = conn.engine === 'mongo';

  return (
    <div className="flex h-full flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold tracking-tight">SQL Workbench</h1>
        <Select
          aria-label="Connection"
          className="w-72"
          value={conn.id}
          onChange={(e) => navigate({ to: '/sql', search: { connection: e.target.value } })}
        >
          {conns.data.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name} · {c.environmentName} ({ENGINE_LABEL[c.engine]})
            </option>
          ))}
        </Select>
        {conn.readOnly ? (
          <Badge tone="pass" title="Writes are blocked">
            <Lock className="mr-1 inline h-3 w-3" />
            read-only
          </Badge>
        ) : (
          <Badge tone="warn">read-write</Badge>
        )}
        {conn.rollbackMode && (
          <Badge tone="warn" title="Writes are rolled back after each statement or test">
            <RotateCcw className="mr-1 inline h-3 w-3" />
            rollback mode
          </Badge>
        )}
        <Link
          to="/applications/$appId"
          params={{ appId: app.id }}
          className="ml-auto text-sm text-muted hover:text-fg"
        >
          Manage connections
        </Link>
      </div>

      {conn.isProduction && (
        <div
          role="alert"
          className="flex items-center gap-2 rounded-lg border border-fail/40 bg-fail/10 px-4 py-2.5 text-sm text-fail"
        >
          <ShieldAlert className="h-4 w-4 shrink-0" />
          Production database ({conn.environmentName}). Every write asks you to type “{app.name}” first.
        </div>
      )}

      <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[260px_1fr]">
        <Card className="flex max-h-[70vh] min-h-64 flex-col p-3 lg:max-h-none">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs font-medium text-muted">{isMongo ? 'Collections' : 'Schema'}</span>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Refresh schema"
              onClick={() =>
                api<DbSchema>(`/api/connections/${conn.id}/schema?refresh=1`).then((s) =>
                  qc.setQueryData(qk.dbSchema(conn.id), s),
                )
              }
            >
              <RefreshCw className={`h-3.5 w-3.5 ${schema.isFetching ? 'animate-spin' : ''}`} />
            </Button>
          </div>
          {schema.isPending ? (
            <Skeleton className="h-40" />
          ) : schema.isError ? (
            <div className="space-y-2 text-sm">
              <p className="flex items-start gap-1.5 text-fail">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> {schema.error.message}
              </p>
              <Button variant="outline" size="sm" onClick={() => schema.refetch()}>
                Retry
              </Button>
            </div>
          ) : (
            <SchemaTree
              schema={schema.data}
              onTable={(t) => {
                setTab('query');
                insert(tableQuery(conn, t), true);
              }}
              onColumn={(c) => insert(ident(conn, c))}
            />
          )}
        </Card>

        <div className="min-w-0 space-y-3">
          <Tabs
            value={tab}
            onChange={setTab}
            tabs={[
              { value: 'query', label: isMongo ? 'Command' : 'Query' },
              { value: 'audit', label: 'Data quality audit' },
            ]}
          />
          {tab === 'query' ? (
            <>
              {/* Ctrl/Cmd+Enter runs; caught before Monaco (which binds Ctrl+Enter to "insert line below"). */}
              <div
                onKeyDownCapture={(e) => {
                  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                    e.preventDefault();
                    e.stopPropagation();
                    runRef.current();
                  }
                }}
              >
                <CodeEditor
                  ariaLabel="SQL editor"
                  language={isMongo ? 'json' : 'sql'}
                  height={220}
                  lineNumbers
                  value={sql}
                  onChange={(v) => {
                    setSql(v);
                    writeDraft(conn.id, v);
                  }}
                  onMount={(editor, monaco) => {
                    editorRef.current = editor;
                    monacoRef.current = monaco;

                    applyCompletions();
                  }}
                />
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  aria-label="Run query"
                  disabled={!sql.trim() || run.isPending}
                  onClick={() => runRef.current()}
                >
                  <Play className="h-4 w-4" /> {run.isPending ? 'Running…' : 'Run'}
                </Button>
                <span className="text-xs text-muted">
                  <Kbd>Ctrl</Kbd> + <Kbd>Enter</Kbd>
                </span>
                {isMongo && (
                  <span className="text-xs text-muted">
                    JSON command: find, aggregate, countDocuments, distinct, insertOne…, updateMany…,
                    deleteMany…
                  </span>
                )}
                {result && result.columns.length > 0 && (
                  <Button
                    variant="outline"
                    className="ml-auto"
                    onClick={() =>
                      setSaving({
                        sql: result.sql,
                        columns: result.columns,
                        assertions: suggestAssertions(result),
                        name: `${conn.name}: ${result.sql.replace(/\s+/g, ' ').slice(0, 60)}`,
                      })
                    }
                  >
                    <Save className="h-4 w-4" /> Save as DB test
                  </Button>
                )}
              </div>
              {error && (
                <div
                  role="alert"
                  className="rounded-lg border border-fail/40 bg-fail/10 px-3 py-2 font-mono text-sm text-fail"
                >
                  {error.message}
                </div>
              )}
              {result && (
                <div className="space-y-2">
                  <p className="text-sm" role="status" data-testid="query-status">
                    {result.columns.length > 0 ? (
                      <>
                        {result.rowCount} row{result.rowCount === 1 ? '' : 's'}
                        {result.truncated && ` (showing the first ${result.rows.length})`}
                      </>
                    ) : (
                      <>
                        {result.affected ?? 0} row{result.affected === 1 ? '' : 's'} affected
                      </>
                    )}
                    <span className="text-muted"> in {result.durationMs} ms</span>
                    {result.rolledBack && (
                      <Badge tone="warn" className="ml-2">
                        rolled back (rollback mode)
                      </Badge>
                    )}
                  </p>
                  {result.columns.length > 0 && (
                    <ResultsGrid
                      columns={result.columns}
                      rows={result.rows}
                      exportName={`${conn.name}-result`}
                    />
                  )}
                </div>
              )}
            </>
          ) : schema.data ? (
            <AuditPanel
              connection={conn}
              schema={schema.data}
              onOpenSql={(text) => {
                setTab('query');
                insert(text, true);
              }}
              onSaveFinding={(f) =>
                setSaving({
                  sql: f.sql!,
                  columns: [],
                  assertions: [{ target: 'rowCount', operator: 'equals', expected: '0' }],
                  name: `No ${f.check} in ${f.table} (${f.columns.join(', ')})`,
                })
              }
              onSaveAudit={(tables, checks) =>
                setSaving({
                  sql: '',
                  columns: [],
                  assertions: [],
                  name: `Data quality: ${conn.name}`,
                  audit: { tables, checks },
                })
              }
            />
          ) : (
            <Skeleton className="h-40" />
          )}
        </div>
      </div>

      <ConfirmDialog
        open={!!confirming}
        onClose={() => {
          setConfirming(null);
          run.reset();
        }}
        title="Write to a production database?"
        description={`This statement changes data in ${conn.environmentName}${conn.rollbackMode ? ' (rollback mode will undo it afterwards)' : ''}. Type the application name to confirm.`}
        confirmLabel="Run on production"
        typeToConfirm={app.name}
        busy={run.isPending}
        onConfirm={(typed) => {
          const text = confirming!;
          setConfirming(null);
          run.mutate({ sql: text, confirm: typed });
        }}
      />
      {saving && (
        <SaveDbTestDialog
          applicationId={app.id}
          connectionName={conn.name}
          sql={saving.sql}
          columns={saving.columns}
          initialAssertions={saving.assertions}
          defaultName={saving.name}
          audit={saving.audit}
          onClose={() => setSaving(null)}
        />
      )}
    </div>
  );
}
