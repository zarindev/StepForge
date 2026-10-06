import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Globe, MoreHorizontal, Pencil, Plus, ShieldAlert, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Select, Switch, Textarea } from '@/components/ui/input';
import { Menu } from '@/components/ui/menu';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { toast, toastError } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { qk, useEnvironments } from '@/lib/queries';
import type { Application, Environment } from '@/lib/types';

type EnvForm = {
  name: string;
  baseUrl: string;
  isProduction: boolean;
  variables: string;
  browser: string;
  headless: boolean;
};

const toLines = (vars: Record<string, string>) =>
  Object.entries(vars)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
export function parseVariables(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

export function EnvironmentsTab({ app }: { app: Application }) {
  const envs = useEnvironments(app.id);
  const qc = useQueryClient();
  const [editing, setEditing] = useState<Environment | 'new' | null>(null);
  const [deleting, setDeleting] = useState<Environment | null>(null);
  const refresh = () => {
    qc.invalidateQueries({ queryKey: qk.environments(app.id) });
    qc.invalidateQueries({ queryKey: qk.applications });
  };

  const save = useMutation({
    mutationFn: (f: EnvForm) => {
      const body = {
        name: f.name,
        baseUrl: f.baseUrl,
        isProduction: f.isProduction,
        variables: parseVariables(f.variables),
        browserDefaults: { browser: f.browser, headless: f.headless },
      };
      return editing === 'new' || !editing
        ? api(`/api/applications/${app.id}/environments`, { method: 'POST', json: body })
        : api(`/api/environments/${editing.id}`, { method: 'PATCH', json: body });
    },
    onSuccess: () => {
      refresh();
      toast(editing === 'new' ? 'Environment added' : 'Environment saved');
      setEditing(null);
    },
  });
  const remove = useMutation({
    mutationFn: ({ env, confirm }: { env: Environment; confirm: string }) =>
      api(`/api/environments/${env.id}`, { method: 'DELETE', json: { confirm } }),
    onSuccess: () => {
      refresh();
      setDeleting(null);
      toast('Environment deleted');
    },
    onError: toastError,
  });

  if (envs.isError) return <ErrorState error={envs.error} onRetry={() => envs.refetch()} />;
  if (envs.isPending) return <Skeleton className="h-32" />;

  return (
    <div className="space-y-4">
      <div className="flex justify-between">
        <p className="text-sm text-muted">
          Where tests run. Use {'{{env.baseUrl}}'} and {'{{env.<variable>}}'} in steps.
        </p>
        <Button size="sm" onClick={() => setEditing('new')}>
          <Plus className="h-3.5 w-3.5" /> Add environment
        </Button>
      </div>
      {envs.data.length === 0 ? (
        <EmptyState
          icon={Globe}
          title="No environments"
          description="Add at least one environment (for example Local at http://localhost:3000) so scenarios know where to run."
          action={<Button onClick={() => setEditing('new')}>Add environment</Button>}
        />
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {envs.data.map((env) => (
            <Card key={env.id} className={env.isProduction ? 'border-fail/40' : ''}>
              <div className="flex items-start gap-3 p-4">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold">{env.name}</span>
                    {env.isProduction && (
                      <Badge tone="fail">
                        <ShieldAlert className="h-3 w-3" /> Production
                      </Badge>
                    )}
                  </div>
                  <p className="mt-0.5 truncate font-mono text-xs text-muted">{env.baseUrl}</p>
                  <p className="mt-2 text-xs text-muted">
                    {Object.keys(env.variablesJson).length} variables ·{' '}
                    {String(env.browserDefaultsJson.browser ?? 'chromium')}
                  </p>
                </div>
                <Menu
                  trigger={(toggle) => (
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Actions for ${env.name}`}
                      onClick={toggle}
                    >
                      <MoreHorizontal className="h-4 w-4" />
                    </Button>
                  )}
                  items={[
                    { label: 'Edit', icon: Pencil, onSelect: () => setEditing(env) },
                    { label: 'Delete', icon: Trash2, danger: true, onSelect: () => setDeleting(env) },
                  ]}
                />
              </div>
            </Card>
          ))}
        </div>
      )}

      {editing && (
        <EnvironmentDialog
          env={editing === 'new' ? undefined : editing}
          onClose={() => setEditing(null)}
          onSubmit={(f) => save.mutate(f)}
          busy={save.isPending}
          error={save.error?.message}
        />
      )}
      <ConfirmDialog
        open={!!deleting}
        onClose={() => setDeleting(null)}
        title={`Delete ${deleting?.name}?`}
        description="Secrets and database connections stored for this environment are deleted too."
        typeToConfirm={deleting?.isProduction ? app.name : undefined}
        busy={remove.isPending}
        onConfirm={(confirm) => deleting && remove.mutate({ env: deleting, confirm })}
      />
    </div>
  );
}

function EnvironmentDialog({
  env,
  onClose,
  onSubmit,
  busy,
  error,
}: {
  env?: Environment;
  onClose: () => void;
  onSubmit: (f: EnvForm) => void;
  busy: boolean;
  error?: string;
}) {
  const [f, setF] = useState<EnvForm>({
    name: env?.name ?? '',
    baseUrl: env?.baseUrl ?? 'http://localhost:3000',
    isProduction: env?.isProduction ?? false,
    variables: toLines(env?.variablesJson ?? {}),
    browser: String(env?.browserDefaultsJson.browser ?? 'chromium'),
    headless: (env?.browserDefaultsJson.headless as boolean | undefined) ?? true,
  });
  const set = (p: Partial<EnvForm>) => setF((c) => ({ ...c, ...p }));
  return (
    <Dialog
      open
      onClose={onClose}
      title={env ? `Edit ${env.name}` : 'Add environment'}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!f.name || !f.baseUrl || busy} onClick={() => onSubmit(f)}>
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid grid-cols-3 gap-3">
          <Field label="Name">
            <Input
              autoFocus
              value={f.name}
              placeholder="Staging"
              onChange={(e) => set({ name: e.target.value })}
            />
          </Field>
          <Field label="Base URL" className="col-span-2">
            <Input
              value={f.baseUrl}
              className="font-mono"
              onChange={(e) => set({ baseUrl: e.target.value })}
            />
          </Field>
        </div>
        <Field label="Variables" hint="One per line: KEY=value. Use secrets for passwords and tokens.">
          <Textarea
            value={f.variables}
            rows={4}
            className="font-mono text-xs"
            placeholder={'apiBase=http://localhost:3000/api\nadminEmail=admin@example.test'}
            onChange={(e) => set({ variables: e.target.value })}
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Default browser">
            <Select value={f.browser} onChange={(e) => set({ browser: e.target.value })}>
              <option value="chromium">Chromium</option>
              <option value="firefox">Firefox</option>
              <option value="webkit">WebKit</option>
            </Select>
          </Field>
          <div className="flex items-end gap-2 pb-2 text-sm">
            <Switch checked={f.headless} onChange={(headless) => set({ headless })} label="Headless" />{' '}
            Headless
          </div>
        </div>
        <div className="flex items-start gap-3 rounded-lg border border-fail/30 bg-fail/5 p-3">
          <Switch
            checked={f.isProduction}
            onChange={(isProduction) => set({ isProduction })}
            label="Production environment"
          />
          <div className="text-sm">
            <p className="font-medium">Production environment</p>
            <p className="text-xs text-muted">
              Shows a red banner. Destructive queries and load tests here need typed confirmation.
            </p>
          </div>
        </div>
        {error && <p className="text-sm text-fail">{error}</p>}
      </div>
    </Dialog>
  );
}
