import { useMutation, useQueryClient } from '@tanstack/react-query';
import { KeyRound, Lock, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Select } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { toast, toastError } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { qk, useEnvironments, useSecrets } from '@/lib/queries';
import type { Application } from '@/lib/types';

export function SecretsTab({ app }: { app: Application }) {
  const envs = useEnvironments(app.id);
  const [envId, setEnvId] = useState<string | null>(null);
  const activeEnv = envs.data?.find((e) => e.id === envId) ?? envs.data?.[0];
  const secrets = useSecrets(activeEnv?.id);
  const qc = useQueryClient();
  const [adding, setAdding] = useState<{ key: string; value: string } | null>(null);

  const save = useMutation({
    mutationFn: (s: { key: string; value: string }) =>
      api(`/api/environments/${activeEnv!.id}/secrets`, { method: 'PUT', json: s }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.secrets(activeEnv!.id) });
      setAdding(null);
      toast('Secret saved (encrypted)');
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/api/secrets/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.secrets(activeEnv!.id) }),
    onError: toastError,
  });

  if (envs.isPending) return <Skeleton className="h-32" />;
  if (envs.isError) return <ErrorState error={envs.error} onRetry={() => envs.refetch()} />;
  if (!activeEnv) {
    return (
      <EmptyState
        icon={KeyRound}
        title="Add an environment first"
        description="Secrets are stored per environment."
      />
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-sm text-muted">
          <Lock className="h-3.5 w-3.5" /> AES-256-GCM encrypted on disk. Values are never shown again.
        </div>
        <div className="flex items-center gap-2">
          <Select
            aria-label="Environment"
            className="w-44"
            value={activeEnv.id}
            onChange={(e) => setEnvId(e.target.value)}
          >
            {envs.data.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
              </option>
            ))}
          </Select>
          <Button size="sm" onClick={() => setAdding({ key: '', value: '' })}>
            <Plus className="h-3.5 w-3.5" /> Add secret
          </Button>
        </div>
      </div>
      {secrets.isPending ? (
        <Skeleton className="h-24" />
      ) : secrets.data?.length === 0 ? (
        <EmptyState
          icon={KeyRound}
          title={`No secrets in ${activeEnv.name}`}
          description="Store passwords, tokens and API keys here and reference them as {{secret.KEY}}. They are masked in logs, reports and exported code."
        />
      ) : (
        <Card>
          <ul className="divide-y divide-border">
            {secrets.data?.map((s) => (
              <li key={s.id} className="flex items-center gap-3 px-4 py-2.5">
                <KeyRound className="h-4 w-4 text-muted" />
                <span className="font-mono text-sm">{s.key}</span>
                <span className="font-mono text-sm tracking-widest text-muted">••••••••</span>
                <code className="ml-auto text-xs text-muted">{`{{secret.${s.key}}}`}</code>
                <Button variant="ghost" size="sm" onClick={() => setAdding({ key: s.key, value: '' })}>
                  Replace
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Delete ${s.key}`}
                  onClick={() => remove.mutate(s.id)}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </li>
            ))}
          </ul>
        </Card>
      )}
      {adding && (
        <Dialog
          open
          onClose={() => setAdding(null)}
          title={`Secret for ${activeEnv.name}`}
          footer={
            <>
              <Button variant="ghost" onClick={() => setAdding(null)}>
                Cancel
              </Button>
              <Button
                disabled={!adding.key || !adding.value || save.isPending}
                onClick={() => save.mutate(adding)}
              >
                Save secret
              </Button>
            </>
          }
        >
          <div className="space-y-4">
            <Field label="Key" hint="Letters, digits and underscores, e.g. adminPassword">
              <Input
                autoFocus={!adding.key}
                className="font-mono"
                value={adding.key}
                onChange={(e) => setAdding({ ...adding, key: e.target.value })}
              />
            </Field>
            <Field label="Value">
              <Input
                autoFocus={!!adding.key}
                type="password"
                autoComplete="new-password"
                value={adding.value}
                onChange={(e) => setAdding({ ...adding, value: e.target.value })}
              />
            </Field>
            {save.error && <p className="text-sm text-fail">{save.error.message}</p>}
          </div>
        </Dialog>
      )}
    </div>
  );
}
