import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, Inbox, Mail, Play, Square } from 'lucide-react';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { Switch } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorState } from '@/components/ui/states';
import { toast, toastError } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { qk } from '@/lib/queries';
import type { MailpitStatus } from '@/lib/types';
import { InboxViewer } from './inbox-viewer';

/** Settings → Email: install, start/stop and browse StepForge's local Mailpit (SMTP catcher). */
export function MailpitCard() {
  const qc = useQueryClient();
  const [viewing, setViewing] = useState(false);
  const status = useQuery({ queryKey: qk.mailpit, queryFn: () => api<MailpitStatus>('/api/email/mailpit') });
  const act = useMutation({
    mutationFn: (action: 'install' | 'start' | 'stop') =>
      api<MailpitStatus>(`/api/email/mailpit/${action}`, { method: 'POST' }),
    onSuccess: (_s, action) => {
      void qc.invalidateQueries({ queryKey: qk.mailpit });
      toast(
        action === 'install'
          ? 'Mailpit installed'
          : action === 'start'
            ? 'Mailpit started'
            : 'Mailpit stopped',
      );
    },
    onError: toastError,
  });
  const autostart = useMutation({
    mutationFn: (enabled: boolean) =>
      api('/api/email/mailpit/autostart', { method: 'PUT', json: { enabled } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.mailpit }),
    onError: toastError,
  });
  const s = status.data;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Mail className="h-4 w-4" /> Email (Mailpit)
        </CardTitle>
      </CardHeader>
      <CardBody className="space-y-3 text-sm">
        <p className="text-muted">
          Mailpit is a free local SMTP server that catches every email your app sends, so email steps can read
          sign-up codes and links without a real mailbox. It only listens on 127.0.0.1.
        </p>
        {status.isPending ? (
          <Skeleton className="h-16" />
        ) : status.isError ? (
          <ErrorState error={status.error} onRetry={() => status.refetch()} />
        ) : (
          s && (
            <>
              <div className="flex flex-wrap items-center gap-2" role="status" data-testid="mailpit-status">
                {s.running ? (
                  <Badge tone="pass">Running {s.version}</Badge>
                ) : s.installed ? (
                  <Badge tone="skip">Stopped</Badge>
                ) : (
                  <Badge tone="warn">Not installed</Badge>
                )}
                {s.external && <Badge>started outside StepForge</Badge>}
                {s.error && <span className="text-xs text-fail">{s.error}</span>}
              </div>
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
                <dt className="text-muted">SMTP (point your app here)</dt>
                <dd className="font-mono">
                  {s.smtpHost}:{s.smtpPort}
                </dd>
                <dt className="text-muted">Web UI and API</dt>
                <dd className="font-mono">{s.url}</dd>
              </dl>
              <div className="flex flex-wrap items-center gap-2">
                {!s.installed && (
                  <Button size="sm" disabled={act.isPending} onClick={() => act.mutate('install')}>
                    <Download className="h-3.5 w-3.5" /> {act.isPending ? 'Downloading…' : 'Install Mailpit'}
                  </Button>
                )}
                {s.installed && !s.running && (
                  <Button size="sm" disabled={act.isPending} onClick={() => act.mutate('start')}>
                    <Play className="h-3.5 w-3.5" /> Start
                  </Button>
                )}
                {s.running && !s.external && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={act.isPending}
                    onClick={() => act.mutate('stop')}
                  >
                    <Square className="h-3.5 w-3.5" /> Stop
                  </Button>
                )}
                {s.running && (
                  <Button size="sm" variant="outline" onClick={() => setViewing(true)}>
                    <Inbox className="h-3.5 w-3.5" /> Open inbox
                  </Button>
                )}
                <label className="ml-auto flex items-center gap-2 text-xs">
                  <Switch
                    checked={s.autostart}
                    disabled={!s.installed || autostart.isPending}
                    onChange={(v) => autostart.mutate(v)}
                    label="Start Mailpit with StepForge"
                  />
                  Start with StepForge
                </label>
              </div>
            </>
          )
        )}
      </CardBody>
      {viewing && (
        <InboxViewer
          inboxId="local"
          title="Local inbox (Mailpit)"
          clearable
          onClose={() => setViewing(false)}
        />
      )}
    </Card>
  );
}
