import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BellRing, Mail, Pencil, Plus, Send, Trash2, Webhook } from 'lucide-react';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Select, Switch, Textarea } from '@/components/ui/input';
import { toast, toastError } from '@/components/ui/toast';
import { api } from '@/lib/api';
import type { NotifyChannel } from '@/lib/types';

type Kind = NotifyChannel['kind'];
export const CHANNEL_LABEL: Record<Kind, string> = {
  telegram: 'Telegram',
  email: 'email',
  slack: 'Slack',
  teams: 'Teams',
  webhook: 'webhook',
};
const WEBHOOK_KINDS: Kind[] = ['slack', 'teams', 'webhook'];
const TITLE: Record<Kind, string> = {
  telegram: 'Add Telegram',
  email: 'Add email',
  slack: 'Add Slack, Mattermost or Rocket.Chat',
  teams: 'Add Microsoft Teams',
  webhook: 'Add a webhook',
};
const HELP: Record<Kind, string> = {
  telegram: 'Create a bot with @BotFather, add it to your group, and paste its token and the chat ID.',
  email: 'Any SMTP server works (your mail provider, or the local Mailpit for trying it out).',
  slack:
    'Create an Incoming Webhook (Slack: Apps → Incoming WebHooks; Mattermost and Rocket.Chat: Integrations → Incoming webhook) and paste its URL.',
  teams:
    'In the channel: Workflows → "Post to a channel when a webhook request is received", then paste the URL it gives you.',
  webhook: 'StepForge POSTs the run summary as JSON ({ event, summary, text }) to this URL.',
};

type Draft = {
  id?: string;
  kind: Kind;
  name: string;
  on: 'always' | 'failures';
  chatId: string;
  host: string;
  port: number;
  secure: boolean;
  user: string;
  from: string;
  to: string;
  flavor: 'slack' | 'mattermost';
  mention: string;
  /** Webhook headers, one "Name: value" per line. Empty keeps the stored ones when editing. */
  headers: string;
  /** Names of the stored webhook headers (their values are stored encrypted and never sent back). */
  headerNames: string[];
  /** Empty keeps the stored token/password when editing. */
  secret: string;
  hasSecret: boolean;
};

const blank = (kind: Draft['kind']): Draft => ({
  kind,
  name: { telegram: 'QA chat', email: 'QA team', slack: '#qa', teams: 'QA channel', webhook: 'Webhook' }[
    kind
  ],
  flavor: 'slack',
  mention: '',
  headers: '',
  headerNames: [],
  on: 'always',
  chatId: '',
  host: '',
  port: 587,
  secure: false,
  user: '',
  from: '',
  to: '',
  secret: '',
  hasSecret: false,
});

function toDraft(c: NotifyChannel): Draft {
  const cfg = c.config as Record<string, unknown>;
  return {
    ...blank(c.kind),
    id: c.id,
    name: c.name,
    on: c.on,
    hasSecret: c.hasSecret,
    chatId: String(cfg.chatId ?? ''),
    host: String(cfg.host ?? ''),
    port: Number(cfg.port ?? 587),
    secure: !!cfg.secure,
    user: String(cfg.user ?? ''),
    from: String(cfg.from ?? ''),
    to: Array.isArray(cfg.to) ? (cfg.to as string[]).join(', ') : '',
    flavor: cfg.flavor === 'mattermost' ? 'mattermost' : 'slack',
    mention: String(cfg.mention ?? ''),
    headerNames: Array.isArray(cfg.headerNames) ? (cfg.headerNames as string[]) : [],
  };
}

function ChannelEditor({ draft, onClose }: { draft: Draft | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [d, setD] = useState<Draft | null>(draft);
  const [prev, setPrev] = useState(draft);
  if (draft !== prev) {
    setPrev(draft);
    setD(draft);
  }
  const save = useMutation({
    mutationFn: () => {
      const v = d!;
      const config =
        v.kind === 'telegram'
          ? { chatId: v.chatId.trim() }
          : v.kind === 'slack'
            ? { flavor: v.flavor, ...(v.mention.trim() && { mention: v.mention.trim() }) }
            : v.kind === 'teams'
              ? {}
              : v.kind === 'webhook'
                ? {
                    headers: Object.fromEntries(
                      v.headers
                        .split('\n')
                        .map((l) => l.split(/:(.*)/s).map((x) => x.trim()))
                        .filter(([k, val]) => k && val),
                    ),
                  }
                : {
                    host: v.host.trim(),
                    port: v.port,
                    secure: v.secure,
                    user: v.user.trim(),
                    from: v.from.trim(),
                    to: v.to
                      .split(/[,;\s]+/)
                      .map((x) => x.trim())
                      .filter(Boolean),
                  };
      const body = {
        kind: v.kind,
        name: v.name.trim(),
        on: v.on,
        config,
        ...(v.secret && { secret: v.secret }),
      };
      return v.id
        ? api<NotifyChannel>(`/api/notify-channels/${v.id}`, { method: 'PUT', json: body })
        : api<NotifyChannel>('/api/notify-channels', { method: 'POST', json: body });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['notify-channels'] });
      toast('Notification channel saved');
      onClose();
    },
    onError: toastError,
  });
  if (!d) return null;
  const webhook = WEBHOOK_KINDS.includes(d.kind);
  const valid =
    d.name.trim() &&
    (d.kind === 'telegram'
      ? d.chatId.trim() && (d.secret || d.hasSecret)
      : webhook
        ? /^https?:\/\//.test(d.secret.trim()) || (!d.secret && d.hasSecret)
        : d.host.trim() && d.from.trim() && d.to.trim());
  return (
    <Dialog
      open={!!draft}
      onClose={onClose}
      title={d.id ? `Edit ${d.name}` : TITLE[d.kind]}
      description={HELP[d.kind]}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!valid || save.isPending} onClick={() => save.mutate()}>
            Save
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
        <Field label="Name">
          <Input
            aria-label="Channel name"
            value={d.name}
            onChange={(e) => setD({ ...d, name: e.target.value })}
          />
        </Field>
        <Field label="Send">
          <Select
            aria-label="When to send"
            value={d.on}
            onChange={(e) => setD({ ...d, on: e.target.value as Draft['on'] })}
          >
            <option value="always">After every run</option>
            <option value="failures">Only when tests fail</option>
          </Select>
        </Field>
        {webhook ? (
          <>
            <Field
              label="Webhook URL"
              className="sm:col-span-2"
              hint={
                d.hasSecret
                  ? 'Stored encrypted (it contains a token). Leave empty to keep it.'
                  : 'Stored encrypted: it contains a token.'
              }
            >
              <Input
                aria-label="Webhook URL"
                type="password"
                autoComplete="off"
                value={d.secret}
                placeholder={d.hasSecret ? '••••••••' : 'https://…'}
                onChange={(e) => setD({ ...d, secret: e.target.value })}
              />
            </Field>
            {d.kind === 'slack' && (
              <>
                <Field label="App">
                  <Select
                    aria-label="Chat app"
                    value={d.flavor}
                    onChange={(e) => setD({ ...d, flavor: e.target.value as Draft['flavor'] })}
                  >
                    <option value="slack">Slack or Rocket.Chat</option>
                    <option value="mattermost">Mattermost</option>
                  </Select>
                </Field>
                <Field label="Mention on failure (optional)" hint="Slack: <!here> · Mattermost: @channel">
                  <Input
                    aria-label="Mention on failure"
                    value={d.mention}
                    onChange={(e) => setD({ ...d, mention: e.target.value })}
                  />
                </Field>
              </>
            )}
            {d.kind === 'webhook' && (
              <Field
                label="Headers (optional)"
                className="sm:col-span-2"
                hint={
                  d.headerNames.length
                    ? `One per line: Name: value. Stored encrypted; leave empty to keep: ${d.headerNames.join(', ')}`
                    : 'One per line: Name: value. Stored encrypted.'
                }
              >
                <Textarea
                  aria-label="Webhook headers"
                  rows={2}
                  className="font-mono text-xs"
                  value={d.headers}
                  onChange={(e) => setD({ ...d, headers: e.target.value })}
                />
              </Field>
            )}
          </>
        ) : d.kind === 'telegram' ? (
          <>
            <Field
              label="Bot token"
              hint={d.hasSecret ? 'Stored encrypted. Leave empty to keep it.' : 'Stored encrypted.'}
            >
              <Input
                aria-label="Bot token"
                type="password"
                autoComplete="off"
                value={d.secret}
                placeholder={d.hasSecret ? '••••••••' : '123456:ABC-DEF…'}
                onChange={(e) => setD({ ...d, secret: e.target.value })}
              />
            </Field>
            <Field label="Chat ID" hint="A group ID starts with -100…">
              <Input
                aria-label="Chat ID"
                className="font-mono"
                value={d.chatId}
                onChange={(e) => setD({ ...d, chatId: e.target.value })}
              />
            </Field>
          </>
        ) : (
          <>
            <Field label="SMTP server">
              <Input
                aria-label="SMTP server"
                value={d.host}
                placeholder="smtp.example.com"
                onChange={(e) => setD({ ...d, host: e.target.value })}
              />
            </Field>
            <Field label="Port">
              <Input
                aria-label="SMTP port"
                type="number"
                value={d.port}
                onChange={(e) => setD({ ...d, port: Number(e.target.value) })}
              />
            </Field>
            <Field label="Username (optional)">
              <Input
                aria-label="SMTP username"
                value={d.user}
                onChange={(e) => setD({ ...d, user: e.target.value })}
              />
            </Field>
            <Field
              label="Password"
              hint={d.hasSecret ? 'Stored encrypted. Leave empty to keep it.' : 'Stored encrypted.'}
            >
              <Input
                aria-label="SMTP password"
                type="password"
                autoComplete="off"
                value={d.secret}
                placeholder={d.hasSecret ? '••••••••' : ''}
                onChange={(e) => setD({ ...d, secret: e.target.value })}
              />
            </Field>
            <Field label="From">
              <Input
                aria-label="From address"
                value={d.from}
                placeholder="StepForge <qa@example.com>"
                onChange={(e) => setD({ ...d, from: e.target.value })}
              />
            </Field>
            <Field label="To" hint="Separate addresses with commas.">
              <Input
                aria-label="To addresses"
                value={d.to}
                onChange={(e) => setD({ ...d, to: e.target.value })}
              />
            </Field>
            <label className="flex items-center gap-2 sm:col-span-2">
              <Switch label="Use TLS" checked={d.secure} onChange={(v) => setD({ ...d, secure: v })} />
              TLS from the start (port 465). Otherwise STARTTLS is used when the server offers it.
            </label>
          </>
        )}
      </div>
    </Dialog>
  );
}

/** Settings → Notifications: where scheduled and CLI runs send their summary. */
export function NotificationsCard() {
  const qc = useQueryClient();
  const channels = useQuery({
    queryKey: ['notify-channels'],
    queryFn: () => api<NotifyChannel[]>('/api/notify-channels'),
  });
  const [editing, setEditing] = useState<Draft | null>(null);
  const [deleting, setDeleting] = useState<NotifyChannel | null>(null);
  const test = useMutation({
    mutationFn: (id: string) =>
      api<{ ok: boolean; message: string }>(`/api/notify-channels/${id}/test`, { method: 'POST' }),
    onSuccess: (r) => toast(r.message, r.ok ? 'success' : 'error'),
    onError: toastError,
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/api/notify-channels/${id}`, { method: 'DELETE' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['notify-channels'] }),
    onError: toastError,
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <BellRing className="h-4 w-4" /> Notifications
        </CardTitle>
      </CardHeader>
      <CardBody className="space-y-3 text-sm">
        <p className="text-muted">
          Scheduled runs, campaigns (and <code className="font-mono text-xs">stepforge run --notify</code>)
          send a summary with the failed tests, their diagnosis, the quality gate and a link to the run.
          Tokens and passwords are stored encrypted and never shown again.
        </p>
        {channels.data?.length ? (
          <ul
            className="divide-y divide-border/60 rounded-lg border border-border"
            data-testid="notify-channels"
          >
            {channels.data.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center gap-3 px-3 py-2">
                {c.kind === 'telegram' ? (
                  <Send className="h-4 w-4 text-muted" />
                ) : c.kind === 'email' ? (
                  <Mail className="h-4 w-4 text-muted" />
                ) : (
                  <Webhook className="h-4 w-4 text-muted" />
                )}
                <span className="font-medium">{c.name}</span>
                <span className="text-xs text-muted">
                  {c.kind === 'telegram'
                    ? `Telegram chat ${String(c.config.chatId ?? '')}`
                    : c.kind === 'email'
                      ? `${(c.config.to as string[] | undefined)?.join(', ') ?? ''} via ${String(c.config.host ?? '')}`
                      : c.kind === 'slack'
                        ? `${c.config.flavor === 'mattermost' ? 'Mattermost' : 'Slack'} webhook`
                        : c.kind === 'teams'
                          ? 'Microsoft Teams workflow'
                          : 'JSON webhook'}
                </span>
                {c.on === 'failures' && <Badge tone="warn">failures only</Badge>}
                {c.kind === 'telegram' && !c.hasSecret && <Badge tone="fail">no token</Badge>}
                {WEBHOOK_KINDS.includes(c.kind) && !c.hasSecret && <Badge tone="fail">no URL</Badge>}
                <div className="ml-auto flex gap-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={test.isPending}
                    aria-label={`Send a test to ${c.name}`}
                    onClick={() => test.mutate(c.id)}
                  >
                    Send test
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`Edit ${c.name}`}
                    onClick={() => setEditing(toDraft(c))}
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`Delete ${c.name}`}
                    onClick={() => setDeleting(c)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" onClick={() => setEditing(blank('telegram'))}>
            <Plus className="h-3.5 w-3.5" /> Telegram
          </Button>
          <Button size="sm" variant="outline" onClick={() => setEditing(blank('email'))}>
            <Plus className="h-3.5 w-3.5" /> Email
          </Button>
          <Button size="sm" variant="outline" onClick={() => setEditing(blank('slack'))}>
            <Plus className="h-3.5 w-3.5" /> Slack / Mattermost
          </Button>
          <Button size="sm" variant="outline" onClick={() => setEditing(blank('teams'))}>
            <Plus className="h-3.5 w-3.5" /> Teams
          </Button>
          <Button size="sm" variant="outline" onClick={() => setEditing(blank('webhook'))}>
            <Plus className="h-3.5 w-3.5" /> Webhook
          </Button>
        </div>
      </CardBody>
      <ChannelEditor draft={editing} onClose={() => setEditing(null)} />
      <ConfirmDialog
        open={!!deleting}
        title={`Delete “${deleting?.name}”?`}
        description="Schedules that use it stop sending to it. Its stored token or password is deleted."
        onConfirm={() => {
          if (deleting) remove.mutate(deleting.id);
          setDeleting(null);
        }}
        onClose={() => setDeleting(null)}
      />
    </Card>
  );
}
