import { useMutation } from '@tanstack/react-query';
import { CheckCircle2, PlugZap, ShieldAlert, XCircle } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Select, Switch } from '@/components/ui/input';
import { api } from '@/lib/api';
import type { DbConnection, DbEngine, Environment } from '@/lib/types';

export const ENGINE_LABEL: Record<DbEngine, string> = {
  sqlite: 'SQLite',
  pg: 'PostgreSQL',
  mysql: 'MySQL / MariaDB',
  mssql: 'SQL Server',
  mongo: 'MongoDB',
};
const DEFAULT_PORT: Record<DbEngine, string> = {
  sqlite: '',
  pg: '5432',
  mysql: '3306',
  mssql: '1433',
  mongo: '27017',
};

type Form = {
  environmentId: string;
  name: string;
  engine: DbEngine;
  host: string;
  port: string;
  database: string;
  username: string;
  password: string;
  connectionString: string;
  ssl: boolean;
  readOnly: boolean;
  rollbackMode: boolean;
};

function toBody(f: Form, editing: boolean) {
  const options: Record<string, unknown> = {};
  if (f.connectionString.trim())
    options[f.engine === 'mongo' ? 'uri' : 'connectionString'] = f.connectionString.trim();
  if (f.ssl) options.ssl = true;
  return {
    name: f.name.trim(),
    engine: f.engine,
    host: f.host.trim(),
    ...(f.port.trim() && { port: Number(f.port) }),
    database: f.database.trim(),
    username: f.username.trim(),
    // Editing: an empty password field keeps the stored one.
    ...(f.password || !editing ? { password: f.password || undefined } : {}),
    options,
    readOnly: f.readOnly,
    rollbackMode: f.rollbackMode,
  };
}

export function ConnectionDialog({
  environments,
  initial,
  defaultEnvironmentId,
  onClose,
  onSaved,
}: {
  environments: Environment[];
  initial?: DbConnection;
  defaultEnvironmentId?: string;
  onClose: () => void;
  onSaved: (c: DbConnection) => void;
}) {
  const opts = initial?.optionsJson ?? {};
  const [f, setF] = useState<Form>({
    environmentId: initial?.environmentId ?? defaultEnvironmentId ?? environments[0]?.id ?? '',
    name: initial?.name ?? '',
    engine: initial?.engine ?? 'sqlite',
    host: initial?.host ?? '',
    port: initial?.port ? String(initial.port) : '',
    database: initial?.database ?? '',
    username: initial?.username ?? '',
    password: '',
    connectionString: String(opts.connectionString ?? opts.uri ?? ''),
    ssl: !!opts.ssl,
    readOnly: initial?.readOnly ?? true,
    rollbackMode: initial?.rollbackMode ?? true,
  });
  const set = (p: Partial<Form>) => setF((c) => ({ ...c, ...p }));
  const env = environments.find((e) => e.id === f.environmentId);
  const isFile = f.engine === 'sqlite';

  const test = useMutation({
    mutationFn: () =>
      api<{ ok: boolean; message: string; durationMs: number }>(
        `/api/environments/${f.environmentId}/connections/test`,
        {
          method: 'POST',
          json: { ...toBody(f, false), ...(initial && !f.password && { connectionId: initial.id }) },
        },
      ),
  });
  const save = useMutation({
    mutationFn: () =>
      initial
        ? api<DbConnection>(`/api/connections/${initial.id}`, { method: 'PATCH', json: toBody(f, true) })
        : api<DbConnection>(`/api/environments/${f.environmentId}/connections`, {
            method: 'POST',
            json: toBody(f, false),
          }),
    onSuccess: onSaved,
  });

  const valid =
    f.name.trim() &&
    f.environmentId &&
    (isFile ? f.database.trim() : f.host.trim() || f.connectionString.trim());

  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title={initial ? `Edit ${initial.name}` : 'New database connection'}
      footer={
        <>
          <Button
            variant="outline"
            className="mr-auto"
            disabled={!valid || test.isPending}
            onClick={() => test.mutate()}
          >
            <PlugZap className="h-4 w-4" /> {test.isPending ? 'Testing…' : 'Test connection'}
          </Button>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!valid || save.isPending} onClick={() => save.mutate()}>
            Save connection
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Field label="Name" hint="Steps refer to the connection by this name" className="sm:col-span-1">
            <Input
              autoFocus
              value={f.name}
              onChange={(e) => set({ name: e.target.value })}
              placeholder="main"
            />
          </Field>
          <Field label="Environment">
            <Select
              value={f.environmentId}
              disabled={!!initial}
              onChange={(e) => set({ environmentId: e.target.value })}
            >
              {environments.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name}
                  {e.isProduction ? ' (production)' : ''}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Engine">
            <Select
              value={f.engine}
              onChange={(e) => {
                const engine = e.target.value as DbEngine;
                set({
                  engine,
                  port: f.port && f.port !== DEFAULT_PORT[f.engine] ? f.port : DEFAULT_PORT[engine],
                });
              }}
            >
              {(Object.keys(ENGINE_LABEL) as DbEngine[]).map((k) => (
                <option key={k} value={k}>
                  {ENGINE_LABEL[k]}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        {env?.isProduction && (
          <div
            role="alert"
            className="flex items-start gap-2 rounded-lg border border-fail/40 bg-fail/10 px-3 py-2 text-sm text-fail"
          >
            <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
            Production environment: every write needs the application name typed to confirm. Keep this
            connection read-only unless you really must write.
          </div>
        )}

        {isFile ? (
          <Field label="Database file" hint="Absolute path to the .db / .sqlite file on this computer">
            <Input
              className="font-mono"
              value={f.database}
              onChange={(e) => set({ database: e.target.value })}
              placeholder="C:\\apps\\shop\\data.db or /home/me/app/data.db"
            />
          </Field>
        ) : (
          <>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
              <Field label="Host" className="sm:col-span-2">
                <Input
                  value={f.host}
                  onChange={(e) => set({ host: e.target.value })}
                  placeholder="127.0.0.1"
                />
              </Field>
              <Field label="Port">
                <Input
                  inputMode="numeric"
                  value={f.port}
                  onChange={(e) => set({ port: e.target.value.replace(/\D/g, '') })}
                />
              </Field>
              <Field label="Database">
                <Input value={f.database} onChange={(e) => set({ database: e.target.value })} />
              </Field>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="Username">
                <Input
                  autoComplete="off"
                  value={f.username}
                  onChange={(e) => set({ username: e.target.value })}
                />
              </Field>
              <Field
                label="Password"
                hint={
                  initial?.hasPassword
                    ? 'Stored encrypted. Leave empty to keep it.'
                    : 'Stored encrypted (AES-256-GCM), never shown again'
                }
              >
                <Input
                  type="password"
                  autoComplete="new-password"
                  value={f.password}
                  onChange={(e) => set({ password: e.target.value })}
                  placeholder={initial?.hasPassword ? '••••••••' : ''}
                />
              </Field>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
              <Field
                label={f.engine === 'mongo' ? 'Connection URI (optional)' : 'Connection string (optional)'}
                hint="Overrides host, port and database. Do not put the password here — use the field above."
                className="sm:col-span-3"
              >
                <Input
                  className="font-mono text-xs"
                  value={f.connectionString}
                  onChange={(e) => set({ connectionString: e.target.value })}
                  placeholder={f.engine === 'mongo' ? 'mongodb://host:27017/?replicaSet=rs0' : ''}
                />
              </Field>
              <label className="flex items-center gap-2 self-center pt-4 text-sm">
                <Switch checked={f.ssl} onChange={(v) => set({ ssl: v })} label="Use TLS/SSL" /> TLS/SSL
              </label>
            </div>
          </>
        )}

        <div className="space-y-2 rounded-lg border border-border p-3">
          <label className="flex items-start gap-3 text-sm">
            <Switch checked={f.readOnly} onChange={(v) => set({ readOnly: v })} label="Read-only" />
            <span>
              <span className="font-medium">Read-only</span>
              <span className="block text-xs text-muted">
                Blocks INSERT, UPDATE, DELETE, DDL and other writes
                {f.engine === 'mssql' ? ' (by statement inspection — use a read-only login too)' : ''}.
              </span>
            </span>
          </label>
          <label className="flex items-start gap-3 text-sm">
            <Switch
              checked={f.rollbackMode}
              onChange={(v) => set({ rollbackMode: v })}
              label="Rollback mode"
            />
            <span>
              <span className="font-medium">Rollback mode</span>
              <span className="block text-xs text-muted">
                Writes made by tests and the workbench run in a transaction that is rolled back at the end
                {f.engine === 'mongo' ? ' (MongoDB needs a replica set for this)' : ''}.
              </span>
            </span>
          </label>
        </div>

        {test.data && (
          <p
            className={`flex items-center gap-2 text-sm ${test.data.ok ? 'text-pass' : 'text-fail'}`}
            role="status"
          >
            {test.data.ok ? <CheckCircle2 className="h-4 w-4" /> : <XCircle className="h-4 w-4" />}
            {test.data.message}
            <span className="text-xs text-muted">({test.data.durationMs} ms)</span>
          </p>
        )}
        {test.error && <p className="text-sm text-fail">{test.error.message}</p>}
        {save.error && <p className="text-sm text-fail">{save.error.message}</p>}
      </div>
    </Dialog>
  );
}
