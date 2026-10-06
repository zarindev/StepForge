import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Inbox as InboxIcon, Mail, Pencil, PlugZap, Plus, Trash2, XCircle } from 'lucide-react';
import { useState } from 'react';
import { InboxViewer } from '@/components/email/inbox-viewer';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Select, Switch } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorState } from '@/components/ui/states';
import { toast, toastError } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { qk, useInboxes } from '@/lib/queries';
import type { Application, Inbox } from '@/lib/types';

type Form = {
  name: string;
  kind: 'mailpit' | 'imap';
  url: string;
  host: string;
  port: string;
  secure: boolean;
  user: string;
  password: string;
  mailbox: string;
};

function toBody(f: Form, editing: boolean) {
  const config =
    f.kind === 'mailpit'
      ? { ...(f.url.trim() && { url: f.url.trim() }) }
      : {
          host: f.host.trim(),
          ...(f.port && { port: Number(f.port) }),
          secure: f.secure,
          user: f.user.trim(),
          ...(f.mailbox.trim() && { mailbox: f.mailbox.trim() }),
        };
  return {
    name: f.name.trim(),
    kind: f.kind,
    config,
    // Editing: an empty password keeps the stored one.
    ...(f.kind === 'imap' && (f.password || !editing) ? { password: f.password || undefined } : {}),
  };
}

function InboxDialog({ app, initial, onClose }: { app: Application; initial?: Inbox; onClose: () => void }) {
  const qc = useQueryClient();
  const c = initial?.config ?? {};
  const [f, setF] = useState<Form>({
    name: initial?.name ?? '',
    kind: initial?.kind ?? 'mailpit',
    url: c.url ?? '',
    host: c.host ?? '',
    port: c.port ? String(c.port) : '993',
    secure: c.secure ?? true,
    user: c.user ?? '',
    password: '',
    mailbox: c.mailbox ?? '',
  });
  const set = (p: Partial<Form>) => setF((x) => ({ ...x, ...p }));
  const test = useMutation({
    mutationFn: () =>
      api<{ ok: boolean; message: string }>(`/api/applications/${app.id}/inboxes/test`, {
        method: 'POST',
        json: { ...toBody(f, false), ...(initial && !f.password && { inboxId: initial.id }) },
      }),
  });
  const save = useMutation({
    mutationFn: () =>
      initial
        ? api(`/api/inboxes/${initial.id}`, { method: 'PATCH', json: toBody(f, true) })
        : api(`/api/applications/${app.id}/inboxes`, { method: 'POST', json: toBody(f, false) }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.inboxes(app.id) });
      toast(`Inbox ${f.name} saved`);
      onClose();
    },
  });
  const valid = f.name.trim() && (f.kind === 'mailpit' || (f.host.trim() && f.user.trim()));

  return (
    <Dialog
      open
      onClose={onClose}
      title={initial ? `Edit ${initial.name}` : 'New inbox'}
      footer={
        <>
          <Button
            variant="outline"
            className="mr-auto"
            disabled={!valid || test.isPending}
            onClick={() => test.mutate()}
          >
            <PlugZap className="h-4 w-4" /> {test.isPending ? 'Testing…' : 'Test'}
          </Button>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!valid || save.isPending} onClick={() => save.mutate()}>
            Save inbox
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Name" hint="Email steps refer to the inbox by this name">
            <Input
              autoFocus
              value={f.name}
              onChange={(e) => set({ name: e.target.value })}
              placeholder="Gmail QA"
            />
          </Field>
          <Field label="Type">
            <Select value={f.kind} onChange={(e) => set({ kind: e.target.value as Form['kind'] })}>
              <option value="mailpit">Mailpit</option>
              <option value="imap">IMAP (Gmail, Outlook, any provider)</option>
            </Select>
          </Field>
        </div>
        {f.kind === 'mailpit' ? (
          <Field
            label="Mailpit URL"
            hint="Leave empty to use StepForge's own local Mailpit (Settings → Email)"
          >
            <Input
              className="font-mono"
              value={f.url}
              onChange={(e) => set({ url: e.target.value })}
              placeholder="http://127.0.0.1:8025"
            />
          </Field>
        ) : (
          <>
            <div className="grid grid-cols-4 gap-3">
              <Field label="IMAP host" className="col-span-2">
                <Input
                  value={f.host}
                  onChange={(e) => set({ host: e.target.value })}
                  placeholder="imap.gmail.com"
                />
              </Field>
              <Field label="Port">
                <Input
                  inputMode="numeric"
                  value={f.port}
                  onChange={(e) => set({ port: e.target.value.replace(/\D/g, '') })}
                />
              </Field>
              <label className="flex items-center gap-2 self-end pb-2 text-sm">
                <Switch checked={f.secure} onChange={(v) => set({ secure: v })} label="TLS" /> TLS
              </label>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="User">
                <Input
                  autoComplete="off"
                  value={f.user}
                  onChange={(e) => set({ user: e.target.value })}
                  placeholder="qa.team@gmail.com"
                />
              </Field>
              <Field
                label="Password"
                hint={
                  initial?.hasPassword
                    ? 'Stored encrypted. Leave empty to keep it.'
                    : 'Gmail: use an app password, not your account password'
                }
              >
                <Input
                  type="password"
                  autoComplete="new-password"
                  value={f.password}
                  placeholder={initial?.hasPassword ? '••••••••' : ''}
                  onChange={(e) => set({ password: e.target.value })}
                />
              </Field>
            </div>
            <Field label="Folder" hint="Default INBOX">
              <Input
                value={f.mailbox}
                onChange={(e) => set({ mailbox: e.target.value })}
                placeholder="INBOX"
              />
            </Field>
            <p className="text-xs text-muted">
              Tip: use plus-addressing for unique sign-ups that all land in this inbox, e.g.{' '}
              <code className="font-mono">qa.team+{'{{run.id}}'}@gmail.com</code>.
            </p>
          </>
        )}
        {test.data && (
          <p
            role="status"
            className={`flex items-center gap-2 text-sm ${test.data.ok ? 'text-pass' : 'text-fail'}`}
          >
            {test.data.ok ? <CheckCircle2 className="h-4 w-4" /> : <XCircle className="h-4 w-4" />}
            {test.data.message}
          </p>
        )}
        {save.error && <p className="text-sm text-fail">{save.error.message}</p>}
      </div>
    </Dialog>
  );
}

export function InboxesTab({ app }: { app: Application }) {
  const inboxes = useInboxes(app.id);
  const qc = useQueryClient();
  const [editing, setEditing] = useState<Inbox | 'new' | null>(null);
  const [deleting, setDeleting] = useState<Inbox | null>(null);
  const [viewing, setViewing] = useState<{ id: string; title: string; clearable: boolean } | null>(null);
  const test = useMutation({
    mutationFn: (i: Inbox) =>
      api<{ ok: boolean; message: string }>(`/api/inboxes/${i.id}/test`, { method: 'POST' }),
    onSuccess: (r, i) =>
      r.ok ? toast(`${i.name}: ${r.message}`) : toastError(new Error(`${i.name}: ${r.message}`)),
    onError: toastError,
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/api/inboxes/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.inboxes(app.id) });
      setDeleting(null);
    },
    onError: toastError,
  });

  if (inboxes.isPending) return <Skeleton className="h-32" />;
  if (inboxes.isError) return <ErrorState error={inboxes.error} onRetry={() => inboxes.refetch()} />;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-2xl text-sm text-muted">
          Email steps read from these inboxes by name. A step without an inbox uses the first one below, or
          StepForge's local Mailpit when there is none.
        </p>
        <Button size="sm" onClick={() => setEditing('new')}>
          <Plus className="h-3.5 w-3.5" /> Add inbox
        </Button>
      </div>
      <Card>
        <ul className="divide-y divide-border">
          {inboxes.data.map((i) => (
            <li key={i.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
              <Mail className="h-4 w-4 text-muted" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{i.name}</span>
                  <Badge>{i.kind === 'mailpit' ? 'Mailpit' : 'IMAP'}</Badge>
                </div>
                <p className="truncate font-mono text-xs text-muted">
                  {i.kind === 'mailpit'
                    ? i.config.url || 'StepForge local Mailpit'
                    : `${i.config.user}@${i.config.host}:${i.config.port ?? 993}/${i.config.mailbox ?? 'INBOX'}`}
                </p>
              </div>
              <Button variant="ghost" size="sm" disabled={test.isPending} onClick={() => test.mutate(i)}>
                <PlugZap className="h-3.5 w-3.5" /> Test
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setViewing({ id: i.id, title: i.name, clearable: i.kind === 'mailpit' })}
              >
                <InboxIcon className="h-3.5 w-3.5" /> Open
              </Button>
              <Button variant="ghost" size="icon" aria-label={`Edit ${i.name}`} onClick={() => setEditing(i)}>
                <Pencil className="h-4 w-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                aria-label={`Delete ${i.name}`}
                onClick={() => setDeleting(i)}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </li>
          ))}
          {inboxes.data.length === 0 && (
            <li className="flex flex-wrap items-center gap-3 px-4 py-3">
              <Mail className="h-4 w-4 text-muted" />
              <div className="flex-1">
                <span className="font-medium">Local Mailpit</span>{' '}
                <span className="text-xs text-muted">(used by default — no inbox configured)</span>
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setViewing({ id: 'local', title: 'Local inbox (Mailpit)', clearable: true })}
              >
                <InboxIcon className="h-3.5 w-3.5" /> Open
              </Button>
            </li>
          )}
        </ul>
      </Card>
      {editing && (
        <InboxDialog
          app={app}
          initial={editing === 'new' ? undefined : editing}
          onClose={() => setEditing(null)}
        />
      )}
      {viewing && (
        <InboxViewer
          inboxId={viewing.id}
          title={viewing.title}
          clearable={viewing.clearable}
          onClose={() => setViewing(null)}
        />
      )}
      <ConfirmDialog
        open={!!deleting}
        onClose={() => setDeleting(null)}
        title={`Delete inbox ${deleting?.name}?`}
        description="Email steps that name this inbox will be reported as broken."
        busy={remove.isPending}
        onConfirm={() => deleting && remove.mutate(deleting.id)}
      />
    </div>
  );
}
