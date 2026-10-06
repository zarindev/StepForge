import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import {
  BellRing,
  CalendarClock,
  ChevronDown,
  ChevronRight,
  Pencil,
  Play,
  Plus,
  Terminal,
  Trash2,
} from 'lucide-react';
import { Fragment, useCallback, useEffect, useState } from 'react';
import { StatusIcon } from '@/components/runs/status';
import { PageHeader } from '@/components/shell/layout';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Select, Switch } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { toast, toastError } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { useLiveEvent, type LiveEvent } from '@/lib/live';
import { useApplications, useEnvironments, useTags, useTree } from '@/lib/queries';
import type { NotifyChannel, RunScope, Schedule, ScheduleRun } from '@/lib/types';

/** Common schedules; anything else is entered as a cron expression. */
export const CRON_PRESETS = [
  { cron: '0 2 * * *', label: 'Every night at 02:00' },
  { cron: '0 6 * * 1-5', label: 'Weekdays at 06:00' },
  { cron: '0 * * * *', label: 'Every hour' },
  { cron: '*/15 * * * *', label: 'Every 15 minutes' },
  { cron: '0 7 * * 1', label: 'Mondays at 07:00' },
] as const;
export const describeCron = (cron: string) => CRON_PRESETS.find((p) => p.cron === cron)?.label ?? cron;

const fmtWhen = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : '—');

type Draft = {
  applicationId: string;
  name: string;
  environmentId: string;
  cron: string;
  scope: RunScope;
  browser: 'chromium' | 'firefox' | 'webkit';
  retries: number;
  enabled: boolean;
  channelIds: string[];
};

function useChannels() {
  return useQuery({
    queryKey: ['notify-channels'],
    queryFn: () => api<NotifyChannel[]>('/api/notify-channels'),
  });
}

function ScheduleEditor({
  open,
  initial,
  onClose,
}: {
  open: boolean;
  initial: (Draft & { id?: string }) | null;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const apps = useApplications();
  const [d, setD] = useState<Draft & { id?: string }>();
  useEffect(() => {
    if (open && initial) setD(initial);
  }, [open, initial]);
  const envs = useEnvironments(d?.applicationId);
  const tags = useTags(d?.applicationId);
  const tree = useTree(d?.applicationId);
  const channels = useChannels();
  const custom = d ? !CRON_PRESETS.some((p) => p.cron === d.cron) : false;
  const [customMode, setCustomMode] = useState(false);
  useEffect(() => setCustomMode(custom), [open]); // eslint-disable-line react-hooks/exhaustive-deps

  // Default to the first environment once the application's environments load.
  useEffect(() => {
    if (d && !d.environmentId && envs.data?.[0]) setD({ ...d, environmentId: envs.data[0].id });
  }, [d, envs.data]);

  const preview = useQuery({
    queryKey: ['cron-preview', d?.cron],
    enabled: !!d?.cron.trim(),
    retry: false,
    queryFn: () =>
      api<{ next: string[] }>(`/api/schedules/preview?count=5&cron=${encodeURIComponent(d!.cron.trim())}`),
  });
  const save = useMutation({
    mutationFn: () => {
      const body = {
        name: d!.name,
        environmentId: d!.environmentId,
        cron: d!.cron.trim(),
        scope: d!.scope,
        options: { browser: d!.browser, retries: d!.retries },
        enabled: d!.enabled,
        channelIds: d!.channelIds,
      };
      return d!.id
        ? api<Schedule>(`/api/schedules/${d!.id}`, { method: 'PUT', json: body })
        : api<Schedule>(`/api/applications/${d!.applicationId}/schedules`, { method: 'POST', json: body });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['schedules'] });
      toast(d!.id ? 'Schedule saved' : 'Schedule created');
      onClose();
    },
    onError: toastError,
  });
  if (!d) return null;
  const scopeValue =
    d.scope.type === 'tag' ? `tag:${d.scope.id}` : d.scope.type === 'module' ? `module:${d.scope.id}` : 'all';

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      title={d.id ? 'Edit schedule' : 'New schedule'}
      description="Schedules run while StepForge is open. For unattended runs, use the CLI with your operating system's scheduler."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={
              !d.name.trim() || !d.environmentId || !d.cron.trim() || preview.isError || save.isPending
            }
            onClick={() => save.mutate()}
          >
            {d.id ? 'Save' : 'Create schedule'}
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
        <Field label="Name">
          <Input
            aria-label="Schedule name"
            value={d.name}
            placeholder="Nightly regression"
            onChange={(e) => setD({ ...d, name: e.target.value })}
          />
        </Field>
        <Field label="Application">
          <Select
            aria-label="Application"
            value={d.applicationId}
            disabled={!!d.id}
            onChange={(e) =>
              setD({ ...d, applicationId: e.target.value, environmentId: '', scope: { type: 'application' } })
            }
          >
            {apps.data?.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Environment">
          <Select
            aria-label="Environment"
            value={d.environmentId}
            onChange={(e) => setD({ ...d, environmentId: e.target.value })}
          >
            {envs.data?.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
                {e.isProduction ? ' (production)' : ''}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Tests">
          <Select
            aria-label="Tests to run"
            value={scopeValue}
            onChange={(e) => {
              const [type, id] = e.target.value.split(':') as [string, string];
              setD({
                ...d,
                scope: type === 'all' ? { type: 'application' } : ({ type, id } as RunScope),
              });
            }}
          >
            <option value="all">All tests</option>
            {tags.data?.length ? (
              <optgroup label="Tag">
                {tags.data.map((t) => (
                  <option key={t.id} value={`tag:${t.id}`}>
                    #{t.name}
                  </option>
                ))}
              </optgroup>
            ) : null}
            {tree.data?.modules.length ? (
              <optgroup label="Module">
                {tree.data.modules.map((m) => (
                  <option key={m.id} value={`module:${m.id}`}>
                    {m.name}
                  </option>
                ))}
              </optgroup>
            ) : null}
          </Select>
        </Field>
        <Field label="When" className="sm:col-span-2">
          <div className="flex flex-wrap gap-2">
            <Select
              aria-label="Schedule preset"
              className="w-56"
              value={customMode ? 'custom' : d.cron}
              onChange={(e) => {
                if (e.target.value === 'custom') return setCustomMode(true);
                setCustomMode(false);
                setD({ ...d, cron: e.target.value });
              }}
            >
              {CRON_PRESETS.map((p) => (
                <option key={p.cron} value={p.cron}>
                  {p.label}
                </option>
              ))}
              <option value="custom">Custom (cron)…</option>
            </Select>
            {customMode && (
              <Input
                aria-label="Cron expression"
                className="w-48 font-mono"
                value={d.cron}
                placeholder="30 1 * * *"
                onChange={(e) => setD({ ...d, cron: e.target.value })}
              />
            )}
          </div>
        </Field>
        <div
          className="rounded-lg border border-border bg-surface-2/40 p-3 sm:col-span-2"
          data-testid="cron-preview"
        >
          <div className="mb-1 text-xs font-medium text-muted">Next runs</div>
          {preview.isError ? (
            <p className="text-xs text-fail">{(preview.error as Error).message}</p>
          ) : (
            <ul className="grid grid-cols-1 gap-x-4 font-mono text-xs sm:grid-cols-2">
              {preview.data?.next.map((n) => (
                <li key={n}>{new Date(n).toLocaleString()}</li>
              ))}
            </ul>
          )}
        </div>
        <Field label="Browser">
          <Select
            aria-label="Browser"
            value={d.browser}
            onChange={(e) => setD({ ...d, browser: e.target.value as Draft['browser'] })}
          >
            <option value="chromium">Chromium</option>
            <option value="firefox">Firefox</option>
            <option value="webkit">WebKit</option>
          </Select>
        </Field>
        <Field label="Retries for failed tests">
          <Select
            aria-label="Retries"
            value={d.retries}
            onChange={(e) => setD({ ...d, retries: Number(e.target.value) })}
          >
            {[0, 1, 2, 3].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </Select>
        </Field>
        <div className="sm:col-span-2">
          <div className="mb-1.5 text-xs font-medium text-muted">Send the summary to</div>
          {channels.data?.length ? (
            <div className="flex flex-wrap gap-3">
              {channels.data.map((c) => (
                <label key={c.id} className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={d.channelIds.includes(c.id)}
                    onChange={(e) =>
                      setD({
                        ...d,
                        channelIds: e.target.checked
                          ? [...d.channelIds, c.id]
                          : d.channelIds.filter((x) => x !== c.id),
                      })
                    }
                  />
                  {c.name}
                  <span className="text-xs text-muted">
                    ({c.kind === 'telegram' ? 'Telegram' : 'email'}
                    {c.on === 'failures' ? ', failures only' : ''})
                  </span>
                </label>
              ))}
            </div>
          ) : (
            <p className="text-xs text-muted">
              No notification channels yet.{' '}
              <Link to="/settings" className="text-brand hover:underline">
                Add Telegram or email in Settings
              </Link>
              .
            </p>
          )}
        </div>
        <label className="flex items-center gap-2 sm:col-span-2">
          <Switch label="Enabled" checked={d.enabled} onChange={(v) => setD({ ...d, enabled: v })} />
          Enabled
        </label>
      </div>
    </Dialog>
  );
}

function History({ scheduleId }: { scheduleId: string }) {
  const runs = useQuery({
    queryKey: ['schedules', scheduleId, 'runs'],
    queryFn: () => api<ScheduleRun[]>(`/api/schedules/${scheduleId}/runs`),
  });
  if (runs.isPending) return <Skeleton className="h-8 w-full" />;
  if (!runs.data?.length) return <p className="text-xs text-muted">No runs yet.</p>;
  return (
    <ul className="space-y-1 text-xs">
      {runs.data.map((r) => (
        <li key={r.id} className="flex flex-wrap items-center gap-3">
          <StatusIcon status={r.status} />
          <Link to="/runs/$runId" params={{ runId: r.id }} search={{}} className="hover:text-brand">
            {new Date(r.createdAt).toLocaleString()}
          </Link>
          <span className="font-mono text-muted">
            {r.totalsJson.passed ?? 0}/{r.totalsJson.total ?? 0} passed
          </span>
          {r.notifications?.map((n) => (
            <Badge key={n.channelId} tone={n.ok ? (n.skipped ? 'skip' : 'pass') : 'fail'}>
              <span title={n.error}>
                {n.channel}: {n.ok ? (n.skipped ? 'skipped' : 'sent') : 'failed'}
              </span>
            </Badge>
          ))}
        </li>
      ))}
    </ul>
  );
}

export function SchedulesPage() {
  const qc = useQueryClient();
  const apps = useApplications();
  const list = useQuery({ queryKey: ['schedules'], queryFn: () => api<Schedule[]>('/api/schedules') });
  const [editing, setEditing] = useState<(Draft & { id?: string }) | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<Schedule | null>(null);
  const appName = new Map(apps.data?.map((a) => [a.id, a.name]));

  useLiveEvent(
    useCallback(
      (e: LiveEvent) => {
        if (
          ['schedule.triggered', 'notifications.sent'].includes(e.type) ||
          (e.type === 'run.updated' && (e.run as { scheduleId?: string })?.scheduleId)
        )
          void qc.invalidateQueries({ queryKey: ['schedules'] });
      },
      [qc],
    ),
  );

  const patch = useMutation({
    mutationFn: (s: Schedule & { enabled: boolean }) =>
      api(`/api/schedules/${s.id}`, {
        method: 'PUT',
        json: {
          name: s.name,
          environmentId: s.environmentId,
          cron: s.cron,
          scope: s.scopeJson,
          options: s.optionsJson,
          enabled: s.enabled,
          channelIds: s.notifyChannelIdsJson,
        },
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['schedules'] }),
    onError: toastError,
  });
  const runNow = useMutation({
    mutationFn: (id: string) => api<{ id: string }>(`/api/schedules/${id}/run`, { method: 'POST' }),
    onSuccess: () => {
      toast('Run started');
      void qc.invalidateQueries({ queryKey: ['schedules'] });
    },
    onError: toastError,
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/api/schedules/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      toast('Schedule deleted');
      void qc.invalidateQueries({ queryKey: ['schedules'] });
    },
    onError: toastError,
  });

  const newDraft = (): Draft => ({
    applicationId: apps.data?.[0]?.id ?? '',
    name: '',
    environmentId: '',
    cron: CRON_PRESETS[0].cron,
    scope: { type: 'application' },
    browser: 'chromium',
    retries: 0,
    enabled: true,
    channelIds: [],
  });
  const editDraft = (s: Schedule): Draft & { id: string } => ({
    id: s.id,
    applicationId: s.applicationId,
    name: s.name,
    environmentId: s.environmentId ?? '',
    cron: s.cron,
    scope: s.scopeJson,
    browser: s.optionsJson.browser ?? 'chromium',
    retries: s.optionsJson.retries ?? 0,
    enabled: s.enabled,
    channelIds: s.notifyChannelIdsJson,
  });

  return (
    <div>
      <PageHeader
        title="Schedules"
        description="Run tests automatically and send the results to Telegram or email."
        actions={
          <Button disabled={!apps.data?.length} onClick={() => setEditing(newDraft())}>
            <Plus className="h-4 w-4" /> New schedule
          </Button>
        }
      />
      {list.isError ? (
        <ErrorState error={list.error} onRetry={() => void list.refetch()} />
      ) : list.isPending ? (
        <Skeleton className="h-40 w-full" />
      ) : !list.data.length ? (
        <EmptyState
          icon={CalendarClock}
          title="No schedules yet"
          description={
            apps.data?.length
              ? 'Run a test suite every night or every hour, and get a summary with failures and their diagnosis.'
              : 'Create an application with tests first.'
          }
          action={
            apps.data?.length ? (
              <Button onClick={() => setEditing(newDraft())}>
                <Plus className="h-4 w-4" /> New schedule
              </Button>
            ) : undefined
          }
        />
      ) : (
        <Card className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-border text-left text-xs text-muted">
              <tr>
                <th className="w-8 px-3 py-2" />
                <th className="px-3 py-2 font-medium">Schedule</th>
                <th className="px-3 py-2 font-medium">When</th>
                <th className="px-3 py-2 font-medium">Next run</th>
                <th className="px-3 py-2 font-medium">Last run</th>
                <th className="px-3 py-2 font-medium">On</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {list.data.map((s) => (
                <Fragment key={s.id}>
                  <tr className="border-b border-border/60" data-testid="schedule-row">
                    <td className="px-3 py-2">
                      <button
                        aria-label={expanded === s.id ? 'Hide history' : 'Show history'}
                        className="text-muted hover:text-fg"
                        onClick={() => setExpanded(expanded === s.id ? null : s.id)}
                      >
                        {expanded === s.id ? (
                          <ChevronDown className="h-4 w-4" />
                        ) : (
                          <ChevronRight className="h-4 w-4" />
                        )}
                      </button>
                    </td>
                    <td className="px-3 py-2">
                      <div className="font-medium">{s.name}</div>
                      <div className="text-xs text-muted">
                        {appName.get(s.applicationId) ?? '—'}
                        {s.notifyChannelIdsJson.length > 0 && (
                          <span className="ml-2 inline-flex items-center gap-1">
                            <BellRing className="h-3 w-3" /> {s.notifyChannelIdsJson.length}
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-3 py-2">
                      {describeCron(s.cron) !== s.cron && <div>{describeCron(s.cron)}</div>}
                      <div className="font-mono text-xs text-muted">{s.cron}</div>
                    </td>
                    <td className="px-3 py-2 text-xs">{s.enabled ? fmtWhen(s.nextRunAt) : 'Off'}</td>
                    <td className="px-3 py-2 text-xs">
                      {s.lastRun ? (
                        <Link
                          to="/runs/$runId"
                          params={{ runId: s.lastRun.id }}
                          search={{}}
                          className="inline-flex items-center gap-1.5 hover:text-brand"
                        >
                          <StatusIcon status={s.lastRun.status} /> {fmtWhen(s.lastRun.createdAt)}
                        </Link>
                      ) : (
                        <span className="text-muted">Never</span>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <Switch
                        label={`Enable ${s.name}`}
                        checked={s.enabled}
                        onChange={(v) => patch.mutate({ ...s, enabled: v })}
                      />
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex justify-end gap-1">
                        <Button
                          size="sm"
                          variant="ghost"
                          aria-label={`Run ${s.name} now`}
                          disabled={runNow.isPending}
                          onClick={() => runNow.mutate(s.id)}
                        >
                          <Play className="h-3.5 w-3.5" /> Run now
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          aria-label={`Edit ${s.name}`}
                          onClick={() => setEditing(editDraft(s))}
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          aria-label={`Delete ${s.name}`}
                          onClick={() => setDeleting(s)}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </td>
                  </tr>
                  {expanded === s.id && (
                    <tr className="border-b border-border/60 bg-surface-2/30">
                      <td />
                      <td colSpan={6} className="px-3 py-3">
                        <History scheduleId={s.id} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      <Card className="mt-4 flex items-start gap-3 p-4 text-sm">
        <Terminal className="mt-0.5 h-4 w-4 shrink-0 text-muted" />
        <div className="text-muted">
          Schedules run only while StepForge is open; a time missed while it was closed is skipped. To run
          unattended or in CI, call the CLI from Windows Task Scheduler, cron or GitHub Actions:{' '}
          <code className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-xs text-fg">
            stepforge run --app &lt;slug&gt; --env &lt;name&gt; --junit results.xml
          </code>{' '}
          (see docs/CLI.md).
        </div>
      </Card>

      <ScheduleEditor open={!!editing} initial={editing} onClose={() => setEditing(null)} />
      <ConfirmDialog
        open={!!deleting}
        title={`Delete “${deleting?.name}”?`}
        description="Past runs are kept; only the schedule is removed."
        confirmLabel="Delete"
        onConfirm={() => {
          if (deleting) remove.mutate(deleting.id);
          setDeleting(null);
        }}
        onClose={() => setDeleting(null)}
      />
    </div>
  );
}
