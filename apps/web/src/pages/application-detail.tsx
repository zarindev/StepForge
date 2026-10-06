import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { Archive, ArrowLeft, FolderTree, Pencil, ShieldAlert, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { AppAvatar, AppFormDialog, type AppFormValues } from '@/components/applications/app-form';
import { BlocksTab } from '@/components/applications/blocks-tab';
import { ConnectionsTab } from '@/components/applications/connections-tab';
import { EnvironmentsTab } from '@/components/applications/environments-tab';
import { SecretsTab } from '@/components/applications/secrets-tab';
import { TagsTab } from '@/components/applications/tags-tab';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorState } from '@/components/ui/states';
import { Tabs } from '@/components/ui/tabs';
import { toast, toastError } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { setCurrentAppId } from '@/lib/current-app';
import { qk, useApplication } from '@/lib/queries';

type Tab = 'environments' | 'secrets' | 'connections' | 'tags' | 'blocks' | 'settings';

export function ApplicationDetailPage() {
  const { appId } = useParams({ from: '/applications/$appId' });
  const app = useApplication(appId);
  const [tab, setTab] = useState<Tab>('environments');
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const qc = useQueryClient();
  const navigate = useNavigate();
  const refresh = () => qc.invalidateQueries({ queryKey: qk.applications });

  const update = useMutation({
    mutationFn: (v: Partial<AppFormValues> & { archived?: boolean }) =>
      api(`/api/applications/${appId}`, { method: 'PATCH', json: v }),
    onSuccess: () => {
      refresh();
      setEditing(false);
      toast('Application updated');
    },
    onError: toastError,
  });
  const remove = useMutation({
    mutationFn: (confirm: string) =>
      api(`/api/applications/${appId}`, { method: 'DELETE', json: { confirm } }),
    onSuccess: () => {
      setCurrentAppId(null);
      refresh();
      toast('Application deleted');
      navigate({ to: '/applications' });
    },
    onError: toastError,
  });

  if (app.isError) return <ErrorState error={app.error} onRetry={() => app.refetch()} />;
  if (app.isPending) return <Skeleton className="h-40" />;
  const a = app.data;

  return (
    <>
      <Link
        to="/applications"
        className="mb-4 inline-flex items-center gap-1 text-sm text-muted hover:text-fg"
      >
        <ArrowLeft className="h-3.5 w-3.5" /> Applications
      </Link>
      {a.hasProduction && (
        <div
          role="alert"
          className="mb-4 flex items-center gap-2 rounded-lg border border-fail/40 bg-fail/10 px-4 py-2.5 text-sm text-fail"
        >
          <ShieldAlert className="h-4 w-4" />
          This application has a production environment. Destructive database queries and load tests there
          require typed confirmation.
        </div>
      )}
      <div className="mb-6 flex flex-wrap items-start gap-4">
        <AppAvatar app={a} size={52} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-semibold tracking-tight">{a.name}</h1>
            <Badge>{a.category}</Badge>
            {a.archived && <Badge tone="skip">Archived</Badge>}
          </div>
          <p className="font-mono text-xs text-muted">{a.slug}</p>
          {a.description && <p className="mt-1.5 max-w-2xl text-sm text-muted">{a.description}</p>}
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => setEditing(true)}>
            <Pencil className="h-4 w-4" /> Edit
          </Button>
          <Link to="/explorer" onClick={() => setCurrentAppId(a.id)}>
            <Button>
              <FolderTree className="h-4 w-4" /> Open test tree
            </Button>
          </Link>
        </div>
      </div>

      <div className="mb-6 grid grid-cols-3 gap-3 md:grid-cols-6">
        {(
          [
            ['Environments', a.counts.environments],
            ['Modules', a.counts.modules],
            ['Scenarios', a.counts.scenarios],
            ['Test cases', a.counts.testCases],
            ['Runs', a.counts.runs],
            ['Open bugs', a.counts.openBugs],
          ] as const
        ).map(([label, n]) => (
          <Card key={label} className="px-4 py-3">
            <div className="text-[11px] text-muted">{label}</div>
            <div className="font-mono text-lg font-semibold tabular-nums">{n}</div>
          </Card>
        ))}
      </div>

      <Tabs
        className="mb-5"
        value={tab}
        onChange={setTab}
        tabs={[
          { value: 'environments', label: 'Environments', count: a.counts.environments },
          { value: 'secrets', label: 'Secrets' },
          { value: 'connections', label: 'Databases' },
          { value: 'tags', label: 'Tags' },
          { value: 'blocks', label: 'Blocks' },
          { value: 'settings', label: 'Settings' },
        ]}
      />
      {tab === 'environments' && <EnvironmentsTab app={a} />}
      {tab === 'secrets' && <SecretsTab app={a} />}
      {tab === 'connections' && <ConnectionsTab app={a} />}
      {tab === 'tags' && <TagsTab app={a} />}
      {tab === 'blocks' && <BlocksTab app={a} />}
      {tab === 'settings' && (
        <div className="max-w-2xl space-y-4">
          <Card className="flex items-center justify-between gap-4 p-4">
            <div>
              <p className="font-medium">{a.archived ? 'Unarchive application' : 'Archive application'}</p>
              <p className="text-sm text-muted">
                Archived applications are hidden from lists and schedules but keep all data.
              </p>
            </div>
            <Button variant="outline" onClick={() => update.mutate({ archived: !a.archived })}>
              <Archive className="h-4 w-4" /> {a.archived ? 'Unarchive' : 'Archive'}
            </Button>
          </Card>
          <Card className="flex items-center justify-between gap-4 border-fail/40 p-4">
            <div>
              <p className="font-medium text-fail">Delete application</p>
              <p className="text-sm text-muted">
                Permanently deletes environments, secrets, modules, scenarios, runs and bugs.
              </p>
            </div>
            <Button variant="danger" onClick={() => setDeleting(true)}>
              <Trash2 className="h-4 w-4" /> Delete
            </Button>
          </Card>
        </div>
      )}

      {editing && (
        <AppFormDialog
          open
          initial={a}
          onClose={() => setEditing(false)}
          onSubmit={(v) => update.mutate(v)}
          busy={update.isPending}
          error={(update.error as Error | null)?.message}
        />
      )}
      <ConfirmDialog
        open={deleting}
        onClose={() => setDeleting(false)}
        title={`Delete ${a.name}?`}
        description="This cannot be undone. Everything that belongs to this application is removed."
        typeToConfirm={a.name}
        busy={remove.isPending}
        onConfirm={(typed) => remove.mutate(typed)}
      />
    </>
  );
}
