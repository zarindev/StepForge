import { useMutation, useQuery } from '@tanstack/react-query';
import { Inbox as InboxIcon, RefreshCw, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { toastError } from '@/components/ui/toast';
import { api } from '@/lib/api';
import type { EmailMessage, EmailSummary } from '@/lib/types';
import { cn } from '@/lib/utils';
import { EmailPreview } from './email-preview';

/** Browses an inbox: `inboxId` is an inbox id or "local" (StepForge's Mailpit). Refreshes every 3 s. */
export function InboxViewer({
  inboxId,
  title,
  clearable,
  onClose,
}: {
  inboxId: string;
  title: string;
  clearable?: boolean;
  onClose: () => void;
}) {
  const [to, setTo] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const list = useQuery({
    queryKey: ['inbox', inboxId, to],
    queryFn: () =>
      api<EmailSummary[]>(
        `/api/inboxes/${inboxId}/messages?limit=100${to ? `&to=${encodeURIComponent(to)}` : ''}`,
      ),
    refetchInterval: 3000,
    retry: false,
  });
  const current = selected ?? list.data?.[0]?.id ?? null;
  const message = useQuery({
    queryKey: ['inbox-message', inboxId, current],
    queryFn: () => api<EmailMessage>(`/api/inboxes/${inboxId}/messages/${current}`),
    enabled: !!current,
    staleTime: Infinity,
  });
  const clear = useMutation({
    mutationFn: () => api(`/api/inboxes/${inboxId}/messages`, { method: 'DELETE' }),
    onSuccess: () => {
      setSelected(null);
      void list.refetch();
    },
    onError: toastError,
  });

  return (
    <Dialog open onClose={onClose} title={title} size="lg">
      <div className="mb-3 flex items-center gap-2">
        <Input
          aria-label="Filter by recipient"
          placeholder="Filter by recipient…"
          value={to}
          onChange={(e) => setTo(e.target.value)}
          className="h-8 max-w-64 text-xs"
        />
        <Button variant="ghost" size="sm" onClick={() => list.refetch()}>
          <RefreshCw className={cn('h-3.5 w-3.5', list.isFetching && 'animate-spin')} /> Refresh
        </Button>
        {clearable && (
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto"
            disabled={clear.isPending}
            onClick={() => clear.mutate()}
          >
            <Trash2 className="h-3.5 w-3.5" /> Clear inbox
          </Button>
        )}
      </div>
      {list.isPending ? (
        <Skeleton className="h-48" />
      ) : list.isError ? (
        <ErrorState error={list.error} onRetry={() => list.refetch()} />
      ) : list.data.length === 0 ? (
        <EmptyState
          icon={InboxIcon}
          title="No emails yet"
          description="New messages appear here automatically."
        />
      ) : (
        <div className="grid gap-3 md:grid-cols-[240px_1fr]">
          <ul className="max-h-[60vh] space-y-1 overflow-auto" aria-label="Messages">
            {list.data.map((m) => (
              <li key={m.id}>
                <button
                  type="button"
                  onClick={() => setSelected(m.id)}
                  className={cn(
                    'w-full rounded-lg px-2.5 py-2 text-left text-xs hover:bg-fg/[0.05]',
                    current === m.id && 'bg-brand/10',
                  )}
                >
                  <span className="block truncate text-sm font-medium">{m.subject || '(no subject)'}</span>
                  <span className="block truncate text-muted">to {m.to.join(', ')}</span>
                  <span className="block text-muted">{new Date(m.date).toLocaleTimeString()}</span>
                </button>
              </li>
            ))}
          </ul>
          <div className="min-w-0">
            {message.isPending ? (
              <Skeleton className="h-64" />
            ) : message.isError ? (
              <ErrorState error={message.error} onRetry={() => message.refetch()} />
            ) : (
              message.data && <EmailPreview email={message.data} />
            )}
          </div>
        </div>
      )}
    </Dialog>
  );
}
