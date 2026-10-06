import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Database, Lock, Pencil, PlugZap, Plus, RotateCcw, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { ConnectionDialog, ENGINE_LABEL } from '@/components/database/connection-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { toast, toastError } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { setCurrentAppId } from '@/lib/current-app';
import { qk, useConnections, useEnvironments } from '@/lib/queries';
import type { Application, DbConnection } from '@/lib/types';

export function ConnectionsTab({ app }: { app: Application }) {
  const envs = useEnvironments(app.id);
  const conns = useConnections(app.id);
  const qc = useQueryClient();
  const [editing, setEditing] = useState<DbConnection | 'new' | null>(null);
  const [deleting, setDeleting] = useState<DbConnection | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: qk.connections(app.id) });

  const test = useMutation({
    mutationFn: (c: DbConnection) =>
      api<{ ok: boolean; message: string }>(`/api/connections/${c.id}/test`, { method: 'POST' }),
    onSuccess: (r, c) =>
      r.ok ? toast(`${c.name}: ${r.message}`) : toastError(new Error(`${c.name}: ${r.message}`)),
    onError: toastError,
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/api/connections/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      refresh();
      setDeleting(null);
      toast('Connection deleted');
    },
    onError: toastError,
  });

  if (envs.isPending || conns.isPending) return <Skeleton className="h-32" />;
  if (envs.isError) return <ErrorState error={envs.error} onRetry={() => envs.refetch()} />;
  if (conns.isError) return <ErrorState error={conns.error} onRetry={() => conns.refetch()} />;
  if (envs.data.length === 0)
    return (
      <EmptyState
        icon={Database}
        title="Add an environment first"
        description="Database connections belong to an environment."
      />
    );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-2xl text-sm text-muted">
          Steps refer to a connection by name, so give the same name to the matching database in each
          environment (e.g. <code className="font-mono">main</code> in Local and Staging) and a run uses the
          one of its environment.
        </p>
        <Button size="sm" onClick={() => setEditing('new')}>
          <Plus className="h-3.5 w-3.5" /> Add connection
        </Button>
      </div>
      {conns.data.length === 0 ? (
        <EmptyState
          icon={Database}
          title="No database connections"
          description="Connect SQLite, PostgreSQL, MySQL, SQL Server or MongoDB to query data in the SQL Workbench and assert on it in tests. New connections are read-only with rollback mode on."
          action={<Button onClick={() => setEditing('new')}>Add connection</Button>}
        />
      ) : (
        <Card>
          <ul className="divide-y divide-border">
            {conns.data.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <Database className="h-4 w-4 text-muted" />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{c.name}</span>
                    <Badge>{ENGINE_LABEL[c.engine]}</Badge>
                    <Badge tone={c.isProduction ? 'fail' : 'indigo'}>{c.environmentName}</Badge>
                    {c.readOnly && (
                      <Badge tone="pass">
                        <Lock className="mr-1 inline h-3 w-3" />
                        read-only
                      </Badge>
                    )}
                    {c.rollbackMode && (
                      <Badge tone="warn">
                        <RotateCcw className="mr-1 inline h-3 w-3" />
                        rollback
                      </Badge>
                    )}
                  </div>
                  <p className="truncate font-mono text-xs text-muted">
                    {c.engine === 'sqlite'
                      ? c.database
                      : `${c.username ? `${c.username}@` : ''}${c.host || 'connection string'}${c.port ? `:${c.port}` : ''}${c.database ? `/${c.database}` : ''}`}
                  </p>
                </div>
                <Button variant="ghost" size="sm" disabled={test.isPending} onClick={() => test.mutate(c)}>
                  <PlugZap className="h-3.5 w-3.5" /> Test
                </Button>
                <Link to="/sql" search={{ connection: c.id }} onClick={() => setCurrentAppId(app.id)}>
                  <Button variant="ghost" size="sm">
                    Open in workbench
                  </Button>
                </Link>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Edit ${c.name}`}
                  onClick={() => setEditing(c)}
                >
                  <Pencil className="h-4 w-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Delete ${c.name}`}
                  onClick={() => setDeleting(c)}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </li>
            ))}
          </ul>
        </Card>
      )}
      {editing && (
        <ConnectionDialog
          environments={envs.data}
          initial={editing === 'new' ? undefined : editing}
          onClose={() => setEditing(null)}
          onSaved={(c) => {
            refresh();
            setEditing(null);
            toast(`Connection ${c.name} saved`);
          }}
        />
      )}
      <ConfirmDialog
        open={!!deleting}
        onClose={() => setDeleting(null)}
        title={`Delete connection ${deleting?.name}?`}
        description="Steps that use this connection name in this environment will be reported as broken."
        busy={remove.isPending}
        onConfirm={() => deleting && remove.mutate(deleting.id)}
      />
    </div>
  );
}
