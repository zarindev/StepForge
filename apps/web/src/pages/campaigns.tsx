import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import {
  ArrowLeft,
  Ban,
  ChevronDown,
  ChevronRight,
  Grid3x3,
  Pencil,
  Play,
  Plus,
  RotateCw,
  Trash2,
} from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import { formatDuration, StatusIcon, StatusPill, timeAgo, TotalsBar } from '@/components/runs/status';
import { PageHeader } from '@/components/shell/layout';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Select } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { toast, toastError } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { useLiveEvent, type LiveEvent } from '@/lib/live';
import { useCurrentApp, useEnvironments, useTags, useTree } from '@/lib/queries';
import { flattenModules } from '@/lib/tree';
import { cn } from '@/lib/utils';

type Totals = {
  total: number;
  passed: number;
  failed: number;
  broken: number;
  skipped: number;
  flaky: number;
};
type CampaignRunSummary = {
  id: string;
  campaignId: string;
  campaignName: string;
  applicationId: string;
  trigger: 'manual' | 'schedule' | 'cli' | 'rerun';
  parentId: string | null;
  status: string;
  totals: Totals;
  runs: number;
  durationMs: number | null;
  createdAt: string;
  finishedAt: string | null;
};
type Selection = { all: true } | { modules: string[]; tags: string[]; scenarios: string[] };
type Campaign = {
  id: string;
  applicationId: string;
  name: string;
  description: string;
  selectionJson: Selection;
  environmentIdsJson: string[];
  browsersJson: string[];
  viewportsJson: string[];
  optionsJson: { workers?: number; retries?: number; priority?: 'high' | 'normal' | 'low' };
  notifyChannelIdsJson: string[];
  lastRun: CampaignRunSummary | null;
};
type CampaignRunDetail = CampaignRunSummary & {
  cells: {
    runId: string;
    environment: string;
    browser: string;
    viewport: string;
    status: string;
    totals: Totals;
    durationMs: number | null;
  }[];
  grid: {
    scenarioId: string | null;
    name: string;
    results: Record<string, { status: string; itemId: string }>;
  }[];
  parent: CampaignRunSummary | null;
};

const BROWSERS = ['chromium', 'firefox', 'webkit'] as const;
const VIEWPORTS = ['desktop', 'tablet', 'mobile'] as const;
const TRIGGER_LABEL: Record<string, string> = {
  manual: 'manual',
  schedule: 'schedule',
  cli: 'CLI',
  rerun: 'rerun of failed',
};
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

/** Saved test sets run across environments × browsers × screen sizes. */
export function CampaignsPage() {
  const { app } = useCurrentApp();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const envs = useEnvironments(app?.id);
  const list = useQuery({
    queryKey: ['campaigns', app?.id],
    queryFn: () => api<Campaign[]>(`/api/applications/${app!.id}/campaigns`),
    enabled: !!app,
  });
  const [editing, setEditing] = useState<Campaign | 'new' | null>(null);
  const [deleting, setDeleting] = useState<Campaign | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  useLiveEvent(
    useCallback(
      (e: LiveEvent) => {
        if (e.type === 'campaign.updated') void qc.invalidateQueries({ queryKey: ['campaigns'] });
      },
      [qc],
    ),
  );
  const run = useMutation({
    mutationFn: (id: string) => api<CampaignRunSummary>(`/api/campaigns/${id}/run`, { method: 'POST' }),
    onSuccess: (r) => {
      toast(`Campaign started: ${plural(r.runs, 'run')}`);
      void navigate({ to: '/campaign-runs/$campaignRunId', params: { campaignRunId: r.id } });
    },
    onError: toastError,
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/api/campaigns/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      setDeleting(null);
      void qc.invalidateQueries({ queryKey: ['campaigns'] });
      toast('Campaign deleted');
    },
    onError: toastError,
  });
  const envName = new Map(envs.data?.map((e) => [e.id, e.name]));

  return (
    <>
      <PageHeader
        title="Campaigns"
        description="Run a saved set of tests in every environment × browser × screen size at once, see the results side by side, and rerun only what failed."
        actions={
          <Button disabled={!app || !envs.data?.length} onClick={() => setEditing('new')}>
            <Plus className="h-4 w-4" /> New campaign
          </Button>
        }
      />
      {!app ? (
        <EmptyState
          icon={Grid3x3}
          title="Create an application first"
          description="Campaigns run an application's tests."
        />
      ) : list.isPending ? (
        <Skeleton className="h-40" />
      ) : list.isError ? (
        <ErrorState error={list.error} onRetry={() => void list.refetch()} />
      ) : list.data.length === 0 ? (
        <EmptyState
          icon={Grid3x3}
          title="No campaigns yet"
          description="A campaign is a saved selection of tests (all, or some modules, tags or scenarios) with the environments, browsers and screen sizes to run them in. Run it with one click, from a schedule or from the CLI."
          action={
            <Button disabled={!envs.data?.length} onClick={() => setEditing('new')}>
              <Plus className="h-4 w-4" /> New campaign
            </Button>
          }
        />
      ) : (
        <div className="space-y-3">
          {list.data.map((c) => {
            const combos = c.environmentIdsJson.length * c.browsersJson.length * c.viewportsJson.length;
            return (
              <Card key={c.id} className="p-4" data-testid="campaign-card">
                <div className="flex flex-wrap items-start gap-3">
                  <button
                    aria-label={open === c.id ? `Hide history of ${c.name}` : `Show history of ${c.name}`}
                    className="mt-0.5 text-muted hover:text-fg"
                    onClick={() => setOpen(open === c.id ? null : c.id)}
                  >
                    {open === c.id ? (
                      <ChevronDown className="h-4 w-4" />
                    ) : (
                      <ChevronRight className="h-4 w-4" />
                    )}
                  </button>
                  <div className="min-w-0 flex-1">
                    <h3 className="font-semibold">{c.name}</h3>
                    <p className="text-xs text-muted">
                      {'all' in c.selectionJson && c.selectionJson.all
                        ? 'All tests'
                        : describeSelection(c.selectionJson)}{' '}
                      · {c.environmentIdsJson.map((id) => envName.get(id) ?? 'deleted').join(', ')} ·{' '}
                      {c.browsersJson.join(', ')} · {c.viewportsJson.join(', ')} ={' '}
                      <b className="text-fg">{plural(combos, 'run')}</b>
                    </p>
                    {c.description && <p className="mt-1 text-sm text-muted">{c.description}</p>}
                  </div>
                  {c.lastRun && (
                    <Link
                      to="/campaign-runs/$campaignRunId"
                      params={{ campaignRunId: c.lastRun.id }}
                      className="flex items-center gap-1.5 text-xs hover:text-brand"
                    >
                      <StatusIcon status={c.lastRun.status} /> {timeAgo(c.lastRun.createdAt)} ·{' '}
                      {c.lastRun.totals.passed}/{c.lastRun.totals.total} passed
                    </Link>
                  )}
                  <div className="flex gap-1">
                    <Button
                      size="sm"
                      disabled={run.isPending}
                      onClick={() => run.mutate(c.id)}
                      aria-label={`Run ${c.name}`}
                    >
                      <Play className="h-3.5 w-3.5" /> Run
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={`Edit ${c.name}`}
                      onClick={() => setEditing(c)}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={`Delete ${c.name}`}
                      onClick={() => setDeleting(c)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
                {open === c.id && <History campaignId={c.id} />}
              </Card>
            );
          })}
        </div>
      )}
      {editing && app && (
        <CampaignEditor
          applicationId={app.id}
          initial={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
        />
      )}
      <ConfirmDialog
        open={!!deleting}
        onClose={() => setDeleting(null)}
        title={`Delete campaign "${deleting?.name ?? ''}"?`}
        description="Its run history stays in Runs. Schedules that run this campaign are deleted with it."
        busy={remove.isPending}
        onConfirm={() => deleting && remove.mutate(deleting.id)}
      />
    </>
  );
}

function describeSelection(s: Selection): string {
  if ('all' in s) return 'All tests';
  return (
    [
      s.modules.length && plural(s.modules.length, 'module'),
      s.tags.length && plural(s.tags.length, 'tag'),
      s.scenarios.length && plural(s.scenarios.length, 'scenario'),
    ]
      .filter(Boolean)
      .join(', ') || 'Nothing selected'
  );
}

function History({ campaignId }: { campaignId: string }) {
  const q = useQuery({
    queryKey: ['campaigns', campaignId, 'runs'],
    queryFn: () => api<{ runs: CampaignRunSummary[] }>(`/api/campaigns/${campaignId}`),
  });
  if (q.isPending) return <Skeleton className="mt-3 h-8" />;
  if (!q.data?.runs.length) return <p className="mt-3 text-xs text-muted">Not run yet.</p>;
  return (
    <ul className="mt-3 space-y-1 border-t border-border pt-3 text-xs" aria-label="Campaign runs">
      {q.data.runs.map((r) => (
        <li key={r.id} className="flex flex-wrap items-center gap-3">
          <StatusIcon status={r.status} />
          <Link
            to="/campaign-runs/$campaignRunId"
            params={{ campaignRunId: r.id }}
            className="hover:text-brand"
          >
            {new Date(r.createdAt).toLocaleString()}
          </Link>
          <span className="font-mono text-muted">
            {r.totals.passed}/{r.totals.total} passed · {plural(r.runs, 'run')} ·{' '}
            {formatDuration(r.durationMs)}
          </span>
          <Badge>{TRIGGER_LABEL[r.trigger]}</Badge>
        </li>
      ))}
    </ul>
  );
}

function Checks<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: { id: T; label: string }[];
  value: T[];
  onChange: (v: T[]) => void;
}) {
  return (
    <fieldset className="space-y-1.5" aria-label={label}>
      <legend className="mb-1 text-xs font-medium text-muted">{label}</legend>
      <div className="flex flex-wrap gap-x-4 gap-y-1.5 text-sm">
        {options.map((o) => (
          <label key={o.id} className="flex items-center gap-2">
            <input
              type="checkbox"
              className="accent-[#F97316]"
              checked={value.includes(o.id)}
              onChange={(e) =>
                onChange(e.target.checked ? [...value, o.id] : value.filter((x) => x !== o.id))
              }
            />
            {o.label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function CampaignEditor({
  applicationId,
  initial,
  onClose,
}: {
  applicationId: string;
  initial: Campaign | null;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const envs = useEnvironments(applicationId);
  const tags = useTags(applicationId);
  const tree = useTree(applicationId);
  const channels = useQuery({
    queryKey: ['notify-channels'],
    queryFn: () => api<{ id: string; name: string }[]>('/api/notify-channels'),
  });
  const sel = initial?.selectionJson;
  const [name, setName] = useState(initial?.name ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [all, setAll] = useState(!sel || 'all' in sel);
  const [modules, setModules] = useState<string[]>(sel && !('all' in sel) ? sel.modules : []);
  const [tagIds, setTagIds] = useState<string[]>(sel && !('all' in sel) ? sel.tags : []);
  const [scenarios, setScenarios] = useState<string[]>(sel && !('all' in sel) ? sel.scenarios : []);
  const [environmentIds, setEnvironmentIds] = useState<string[]>(initial?.environmentIdsJson ?? []);
  const [browsers, setBrowsers] = useState<string[]>(initial?.browsersJson ?? ['chromium']);
  const [viewports, setViewports] = useState<string[]>(initial?.viewportsJson ?? ['desktop']);
  const [workers, setWorkers] = useState(initial?.optionsJson.workers ?? 2);
  const [retries, setRetries] = useState(initial?.optionsJson.retries ?? 0);
  const [priority, setPriority] = useState(initial?.optionsJson.priority ?? 'normal');
  const [channelIds, setChannelIds] = useState<string[]>(initial?.notifyChannelIdsJson ?? []);
  const combos = environmentIds.length * browsers.length * viewports.length;
  const nothing = !all && modules.length + tagIds.length + scenarios.length === 0;
  const save = useMutation({
    mutationFn: () => {
      const body = {
        name,
        description,
        selection: all ? { all: true } : { modules, tags: tagIds, scenarios },
        environmentIds,
        browsers,
        viewports,
        options: { workers, retries, priority },
        channelIds,
      };
      return initial
        ? api(`/api/campaigns/${initial.id}`, { method: 'PUT', json: body })
        : api(`/api/applications/${applicationId}/campaigns`, { method: 'POST', json: body });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['campaigns'] });
      toast(initial ? 'Campaign saved' : 'Campaign created');
      onClose();
    },
    onError: toastError,
  });
  const mods = useMemo(() => (tree.data ? flattenModules(tree.data) : []), [tree.data]);

  return (
    <Dialog
      open
      onClose={onClose}
      title={initial ? 'Edit campaign' : 'New campaign'}
      size="lg"
      footer={
        <>
          <span className="mr-auto text-sm text-muted" data-testid="campaign-combos">
            = {plural(combos, 'run')} per campaign run
          </span>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={!name.trim() || !combos || nothing || save.isPending}
            onClick={() => save.mutate()}
          >
            {initial ? 'Save' : 'Create campaign'}
          </Button>
        </>
      }
    >
      <div className="space-y-4 text-sm">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name">
            <Input
              aria-label="Campaign name"
              value={name}
              placeholder="Release check"
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          <Field label="Description (optional)">
            <Input
              aria-label="Campaign description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </Field>
        </div>
        <fieldset className="space-y-2" aria-label="Tests">
          <legend className="mb-1 text-xs font-medium text-muted">Tests</legend>
          <div className="flex gap-4">
            <label className="flex items-center gap-2">
              <input type="radio" className="accent-[#F97316]" checked={all} onChange={() => setAll(true)} />{' '}
              All tests
            </label>
            <label className="flex items-center gap-2">
              <input
                type="radio"
                className="accent-[#F97316]"
                checked={!all}
                onChange={() => setAll(false)}
              />{' '}
              Choose modules, tags or scenarios
            </label>
          </div>
          {!all && (
            <div className="space-y-3 rounded-lg border border-border p-3">
              <Checks
                label="Modules (with their sub-modules)"
                options={mods.map((m) => ({ id: m.id, label: m.label.trim() }))}
                value={modules}
                onChange={setModules}
              />
              {tags.data?.length ? (
                <Checks
                  label="Tags"
                  options={tags.data.map((t) => ({ id: t.id, label: `#${t.name}` }))}
                  value={tagIds}
                  onChange={setTagIds}
                />
              ) : null}
              <Field label="Single scenarios">
                <Select
                  aria-label="Add a scenario"
                  value=""
                  onChange={(e) =>
                    e.target.value && setScenarios([...new Set([...scenarios, e.target.value])])
                  }
                >
                  <option value="">Add a scenario…</option>
                  {tree.data?.scenarios.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </Select>
              </Field>
              {scenarios.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {scenarios.map((id) => (
                    <button
                      key={id}
                      className="rounded-md bg-fg/5 px-2 py-0.5 text-xs hover:bg-fail/15"
                      title="Remove"
                      onClick={() => setScenarios(scenarios.filter((x) => x !== id))}
                    >
                      {tree.data?.scenarios.find((s) => s.id === id)?.name ?? 'deleted'} ×
                    </button>
                  ))}
                </div>
              )}
              {nothing && <p className="text-xs text-fail">Choose at least one module, tag or scenario.</p>}
            </div>
          )}
        </fieldset>
        <Checks
          label="Environments"
          options={(envs.data ?? []).map((e) => ({
            id: e.id,
            label: `${e.name}${e.isProduction ? ' (production)' : ''}`,
          }))}
          value={environmentIds}
          onChange={setEnvironmentIds}
        />
        <div className="grid gap-4 sm:grid-cols-2">
          <Checks
            label="Browsers"
            options={BROWSERS.map((b) => ({ id: b, label: b[0]!.toUpperCase() + b.slice(1) }))}
            value={browsers}
            onChange={setBrowsers}
          />
          <Checks
            label="Screen sizes"
            options={VIEWPORTS.map((v) => ({ id: v, label: v[0]!.toUpperCase() + v.slice(1) }))}
            value={viewports}
            onChange={setViewports}
          />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Parallel tests per run">
            <Select aria-label="Workers" value={workers} onChange={(e) => setWorkers(Number(e.target.value))}>
              {[1, 2, 3, 4, 6, 8].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Retries for failed tests">
            <Select aria-label="Retries" value={retries} onChange={(e) => setRetries(Number(e.target.value))}>
              {[0, 1, 2, 3].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Queue priority">
            <Select
              aria-label="Queue priority"
              value={priority}
              onChange={(e) => setPriority(e.target.value as 'high' | 'normal' | 'low')}
            >
              <option value="high">High</option>
              <option value="normal">Normal</option>
              <option value="low">Low</option>
            </Select>
          </Field>
        </div>
        {channels.data?.length ? (
          <Checks
            label="Send one summary at the end to"
            options={channels.data.map((c) => ({ id: c.id, label: c.name }))}
            value={channelIds}
            onChange={setChannelIds}
          />
        ) : null}
      </div>
    </Dialog>
  );
}

/** One campaign run: every combination side by side, each test's result per combination, rerun failed. */
export function CampaignRunPage() {
  const { campaignRunId } = useParams({ from: '/campaign-runs/$campaignRunId' });
  const qc = useQueryClient();
  const navigate = useNavigate();
  const q = useQuery({
    queryKey: ['campaign-run', campaignRunId],
    queryFn: () => api<CampaignRunDetail>(`/api/campaign-runs/${campaignRunId}`),
  });
  const runIds = useMemo(() => new Set(q.data?.cells.map((c) => c.runId)), [q.data]);
  useLiveEvent(
    useCallback(
      (e: LiveEvent) => {
        const run = (e as { run?: { id?: string; campaignRunId?: string } }).run;
        if (
          (e.type === 'campaign.updated' &&
            (e as { campaignRunId?: string }).campaignRunId === campaignRunId) ||
          (e.type === 'run.updated' &&
            (run?.campaignRunId === campaignRunId || (run?.id && runIds.has(run.id))))
        )
          void qc.invalidateQueries({ queryKey: ['campaign-run', campaignRunId] });
      },
      [qc, campaignRunId, runIds],
    ),
  );
  const rerun = useMutation({
    mutationFn: () =>
      api<CampaignRunSummary>(`/api/campaign-runs/${campaignRunId}/rerun-failed`, { method: 'POST' }),
    onSuccess: (r) => {
      toast(`Rerunning the failed tests: ${plural(r.runs, 'run')}`);
      void navigate({ to: '/campaign-runs/$campaignRunId', params: { campaignRunId: r.id } });
    },
    onError: toastError,
  });
  const cancel = useMutation({
    mutationFn: () => api(`/api/campaign-runs/${campaignRunId}/cancel`, { method: 'POST' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['campaign-run', campaignRunId] }),
    onError: toastError,
  });

  if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  if (q.isPending) return <Skeleton className="h-96" />;
  const d = q.data;
  const live = d.status === 'queued' || d.status === 'running';
  const label = (c: CampaignRunDetail['cells'][number]) => `${c.environment} · ${c.browser} · ${c.viewport}`;
  return (
    <>
      <Link to="/campaigns" className="mb-4 inline-flex items-center gap-1 text-sm text-muted hover:text-fg">
        <ArrowLeft className="h-3.5 w-3.5" /> Campaigns
      </Link>
      <Card className="mb-5 p-5">
        <div className="flex flex-wrap items-start gap-4">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-3">
              <StatusPill status={d.status} />
              <h1 className="text-lg font-semibold">{d.campaignName}</h1>
              <Badge>{TRIGGER_LABEL[d.trigger]}</Badge>
            </div>
            <p className="mt-1 text-sm text-muted">
              {plural(d.cells.length, 'combination')} · started {timeAgo(d.createdAt)} ·{' '}
              {formatDuration(d.durationMs)}
              {d.parent && (
                <>
                  {' '}
                  · reruns the failures of{' '}
                  <Link
                    to="/campaign-runs/$campaignRunId"
                    params={{ campaignRunId: d.parent.id }}
                    className="text-brand hover:underline"
                  >
                    {new Date(d.parent.createdAt).toLocaleString()}
                  </Link>
                </>
              )}
            </p>
          </div>
          <div className="flex gap-2">
            {live && (
              <Button variant="outline" size="sm" disabled={cancel.isPending} onClick={() => cancel.mutate()}>
                <Ban className="h-3.5 w-3.5" /> Cancel
              </Button>
            )}
            {!live && d.status === 'failed' && (
              <Button size="sm" disabled={rerun.isPending} onClick={() => rerun.mutate()}>
                <RotateCw className="h-3.5 w-3.5" /> Rerun failed
              </Button>
            )}
          </div>
        </div>
        <TotalsBar totals={d.totals} className="mt-4" />
        <div className="mt-2 flex flex-wrap gap-4 text-xs text-muted">
          <span className="text-pass">{d.totals.passed} passed</span>
          <span className="text-fail">{d.totals.failed} failed</span>
          <span className="text-orange-400">{d.totals.broken} broken</span>
          <span className="text-warn">{d.totals.flaky} flaky</span>
          <span>{d.totals.skipped} skipped</span>
        </div>
      </Card>

      <div className="mb-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4" aria-label="Combinations">
        {d.cells.map((c) => (
          <Link
            key={c.runId}
            to="/runs/$runId"
            params={{ runId: c.runId }}
            search={{}}
            className={cn(
              'rounded-xl border border-border bg-surface p-3 hover:border-brand/50',
              (c.status === 'failed' || c.status === 'interrupted') && 'border-fail/40',
            )}
            data-testid="campaign-cell"
          >
            <div className="flex items-center gap-2 text-sm font-medium">
              <StatusIcon status={c.status} /> {c.environment}
            </div>
            <p className="mt-0.5 text-xs text-muted">
              {c.browser} · {c.viewport}
            </p>
            <p className="mt-2 font-mono text-xs">
              {c.totals.passed}/{c.totals.total} passed · {formatDuration(c.durationMs)}
            </p>
          </Link>
        ))}
      </div>

      <Card className="overflow-x-auto">
        <table className="w-full text-sm" aria-label="Results per test and combination">
          <thead>
            <tr className="border-b border-border text-left text-xs text-muted">
              <th className="px-4 py-2 font-medium">Test</th>
              {d.cells.map((c) => (
                <th
                  key={c.runId}
                  className="px-3 py-2 text-center font-medium whitespace-nowrap"
                  title={label(c)}
                >
                  {c.environment}
                  <div className="font-normal">
                    {c.browser} · {c.viewport}
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {d.grid.map((t) => (
              <tr key={t.scenarioId ?? t.name} className="border-b border-border/60 last:border-0">
                <td className="px-4 py-2">{t.name}</td>
                {d.cells.map((c) => {
                  const r = t.results[c.runId];
                  return (
                    <td key={c.runId} className="px-3 py-2 text-center">
                      {r ? (
                        <Link
                          to="/runs/$runId"
                          params={{ runId: c.runId }}
                          search={{ item: r.itemId }}
                          aria-label={`${t.name} — ${label(c)}: ${r.status}`}
                          className="inline-flex"
                        >
                          <StatusIcon status={r.status} />
                        </Link>
                      ) : (
                        <span className="text-muted">—</span>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </>
  );
}
