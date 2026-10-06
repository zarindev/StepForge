import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { Bug as BugIcon, Copy, Download, ExternalLink, FileText, Sheet, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { OWNER_LABEL, OWNER_TONE } from '@/components/diagnosis/diagnosis-panel';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm';
import { Field, Select } from '@/components/ui/input';
import { Menu } from '@/components/ui/menu';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { toast, toastError } from '@/components/ui/toast';
import { api, artifactUrl, download, sessionToken } from '@/lib/api';
import { setCurrentAppId } from '@/lib/current-app';
import { useCurrentApp } from '@/lib/queries';
import type { Bug, BugDetail, BugSeverity, BugStatus, Owner } from '@/lib/types';
import { cn } from '@/lib/utils';

const STATUSES: BugStatus[] = ['open', 'in_progress', 'fixed', 'wont_fix', 'duplicate'];
const SEVERITIES: BugSeverity[] = ['critical', 'major', 'minor', 'trivial'];
const SEVERITY_TONE: Record<BugSeverity, 'fail' | 'warn' | 'indigo' | 'skip'> = {
  critical: 'fail',
  major: 'fail',
  minor: 'warn',
  trivial: 'skip',
};
const label = (s: string) => s.replace(/_/g, ' ');

function BugDetailView({ id, onDeleted }: { id: string; onDeleted: () => void }) {
  const qc = useQueryClient();
  const [deleting, setDeleting] = useState(false);
  const bug = useQuery({ queryKey: ['bug', id], queryFn: () => api<BugDetail>(`/api/bugs/${id}`) });
  const update = useMutation({
    mutationFn: (patch: Partial<Bug>) => api<Bug>(`/api/bugs/${id}`, { method: 'PATCH', json: patch }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['bug', id] });
      void qc.invalidateQueries({ queryKey: ['bugs'] });
    },
    onError: toastError,
  });
  const remove = useMutation({
    mutationFn: () => api(`/api/bugs/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['bugs'] });
      onDeleted();
    },
    onError: toastError,
  });
  const copyMarkdown = async () => {
    const res = await fetch(`/api/bugs/${id}/export?format=md`, {
      headers: { 'x-stepforge-token': sessionToken() },
    });
    await navigator.clipboard.writeText(await res.text());
    toast('Markdown copied — paste it into a GitHub issue');
  };

  if (bug.isPending) return <Skeleton className="h-96" />;
  if (bug.isError) return <ErrorState error={bug.error} onRetry={() => bug.refetch()} />;
  const b = bug.data;
  const d = b.diagnosisJson;
  const env = b.environmentJson;
  const shot = b.failedStep?.screenshotPath;
  return (
    <Card className="space-y-4 p-5" data-testid="bug-detail">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="font-mono text-xs text-muted">{b.code}</p>
          <h2 className="text-lg font-semibold">{b.title}</h2>
          <p className="text-xs text-muted">
            Seen {b.occurrences}× · first {new Date(b.createdAt).toLocaleString()} · last{' '}
            {new Date(b.lastSeenAt ?? b.createdAt).toLocaleString()}
          </p>
        </div>
        <Menu
          trigger={(open) => (
            <Button variant="outline" size="sm" onClick={open}>
              <Download className="h-3.5 w-3.5" /> Export
            </Button>
          )}
          items={[
            { label: 'PDF', icon: FileText, onSelect: () => download(`/api/bugs/${id}/export?format=pdf`) },
            {
              label: 'Markdown (GitHub issue)',
              icon: FileText,
              onSelect: () => download(`/api/bugs/${id}/export?format=md`),
            },
            { label: 'Copy as Markdown', icon: Copy, onSelect: () => void copyMarkdown() },
            { label: 'HTML', icon: FileText, onSelect: () => download(`/api/bugs/${id}/export?format=html`) },
          ]}
        />
        <Button variant="ghost" size="icon" aria-label="Delete bug" onClick={() => setDeleting(true)}>
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>
      <div className="grid grid-cols-3 gap-3">
        <Field label="Status">
          <Select
            aria-label="Status"
            value={b.status}
            onChange={(e) => update.mutate({ status: e.target.value as BugStatus })}
          >
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {label(s)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Severity">
          <Select
            aria-label="Severity"
            value={b.severity}
            onChange={(e) => update.mutate({ severity: e.target.value as BugSeverity })}
          >
            {SEVERITIES.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </Select>
        </Field>
        <Field label="Priority">
          <Select
            aria-label="Priority"
            value={b.priority}
            onChange={(e) => update.mutate({ priority: e.target.value as Bug['priority'] })}
          >
            {['P1', 'P2', 'P3', 'P4'].map((p) => (
              <option key={p}>{p}</option>
            ))}
          </Select>
        </Field>
      </div>
      <p className="text-sm whitespace-pre-line">{b.summary}</p>
      <dl className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[140px_1fr]">
        {b.scenario && (
          <>
            <dt className="text-muted">Scenario</dt>
            <dd>
              <Link
                to="/explorer"
                search={{ scenario: b.scenario.id }}
                onClick={() => setCurrentAppId(b.applicationId)}
                className="text-brand hover:underline"
              >
                {b.scenario.name}
              </Link>
              {env.testCase && <span className="text-muted"> · {env.testCase}</span>}
            </dd>
          </>
        )}
        <dt className="text-muted">Environment</dt>
        <dd>
          {env.name} · <span className="font-mono text-xs">{env.url}</span>
        </dd>
        <dt className="text-muted">Browser</dt>
        <dd>
          {env.browser} · {env.viewport} · {env.os}
        </dd>
        {b.runId && (
          <>
            <dt className="text-muted">Last failing run</dt>
            <dd>
              <Link to="/runs/$runId" params={{ runId: b.runId }} className="text-brand hover:underline">
                Open the run with all evidence <ExternalLink className="inline h-3 w-3" />
              </Link>
            </dd>
          </>
        )}
      </dl>
      {b.preconditions && (
        <div>
          <h3 className="mb-1 text-xs font-medium text-muted">Preconditions</h3>
          <p className="text-sm">{b.preconditions}</p>
        </div>
      )}
      <div>
        <h3 className="mb-1 text-xs font-medium text-muted">Steps to reproduce</h3>
        <pre
          className="overflow-auto rounded-lg border border-border bg-bg p-3 font-mono text-xs whitespace-pre-wrap"
          data-testid="steps-to-reproduce"
        >
          {b.stepsToReproduceJson.join('\n')}
        </pre>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <h3 className="mb-1 text-xs font-medium text-muted">Expected</h3>
          <p className="text-sm">{b.expected}</p>
        </div>
        <div>
          <h3 className="mb-1 text-xs font-medium text-muted">Actual</h3>
          <p className="text-sm text-fail">{b.actual}</p>
        </div>
      </div>
      {d && (
        <div className="rounded-lg border border-brand/30 bg-brand/[0.04] p-3 text-sm">
          <p className="mb-1 flex items-center gap-2">
            <Badge tone={OWNER_TONE[d.owner]}>{OWNER_LABEL[d.owner]}</Badge>
            <span className="font-medium">{d.title}</span>
          </p>
          <p className="text-muted">{d.explanation}</p>
          <p className="mt-1">
            <span className="text-muted">How to fix:</span> {d.fix}
          </p>
        </div>
      )}
      {shot && (
        <div>
          <h3 className="mb-1 text-xs font-medium text-muted">
            Failure screenshot (failing element outlined when it exists)
          </h3>
          <img
            src={artifactUrl(shot)}
            alt="Failure screenshot"
            className="max-h-96 rounded-lg border border-border"
          />
        </div>
      )}
      {b.artifacts.length > 0 && (
        <p className="text-xs text-muted">
          Evidence in the run: {[...new Set(b.artifacts.map((a) => label(a.kind)))].join(', ')}
        </p>
      )}
      <ConfirmDialog
        open={deleting}
        onClose={() => setDeleting(false)}
        title={`Delete ${b.code}?`}
        description="The bug report is removed. If the test fails again, a new bug is filed."
        busy={remove.isPending}
        onConfirm={() => remove.mutate()}
      />
    </Card>
  );
}

export function BugsPage() {
  const { app, apps } = useCurrentApp();
  const search = useSearch({ from: '/bugs' });
  const navigate = useNavigate();
  const [status, setStatus] = useState('open,in_progress');
  const [severity, setSeverity] = useState('');
  const [owner, setOwner] = useState('');
  const query = new URLSearchParams({
    ...(status && { status }),
    ...(severity && { severity }),
    ...(owner && { owner }),
  }).toString();
  const bugs = useQuery({
    queryKey: ['bugs', app?.id, query],
    queryFn: () => api<Bug[]>(`/api/applications/${app!.id}/bugs?${query}`),
    enabled: !!app,
  });
  const selected = search.bug ?? bugs.data?.[0]?.id;

  if (apps.isPending) return <Skeleton className="h-64" />;
  if (!app)
    return (
      <EmptyState
        icon={BugIcon}
        title="No application yet"
        description="Bugs are filed automatically when tests fail."
      />
    );
  const exportList = (format: string) =>
    download(`/api/applications/${app.id}/bugs/export?format=${format}${status ? `&status=${status}` : ''}`);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <h1 className="mr-auto text-xl font-semibold tracking-tight">Bugs</h1>
        <Field label="Status">
          <Select
            aria-label="Status filter"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            className="w-40"
          >
            <option value="open,in_progress">Open</option>
            <option value="fixed">Fixed</option>
            <option value="wont_fix,duplicate">Closed</option>
            <option value="">All</option>
          </Select>
        </Field>
        <Field label="Severity">
          <Select
            aria-label="Severity filter"
            value={severity}
            onChange={(e) => setSeverity(e.target.value)}
            className="w-32"
          >
            <option value="">All</option>
            {SEVERITIES.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </Select>
        </Field>
        <Field label="Whose issue">
          <Select
            aria-label="Owner filter"
            value={owner}
            onChange={(e) => setOwner(e.target.value)}
            className="w-40"
          >
            <option value="">All</option>
            {(Object.keys(OWNER_LABEL) as Owner[]).map((o) => (
              <option key={o} value={o}>
                {OWNER_LABEL[o]}
              </option>
            ))}
          </Select>
        </Field>
        <Menu
          trigger={(open) => (
            <Button variant="outline" onClick={open} disabled={!bugs.data?.length}>
              <Download className="h-4 w-4" /> Export list
            </Button>
          )}
          items={[
            { label: 'PDF (list + every bug)', icon: FileText, onSelect: () => exportList('pdf') },
            { label: 'Excel (XLSX)', icon: Sheet, onSelect: () => exportList('xlsx') },
            { label: 'Jira CSV', icon: Sheet, onSelect: () => exportList('jira') },
            { label: 'Trello CSV', icon: Sheet, onSelect: () => exportList('trello') },
            { label: 'Markdown', icon: FileText, onSelect: () => exportList('md') },
          ]}
        />
      </div>
      {bugs.isPending ? (
        <Skeleton className="h-64" />
      ) : bugs.isError ? (
        <ErrorState error={bugs.error} onRetry={() => bugs.refetch()} />
      ) : bugs.data.length === 0 ? (
        <EmptyState
          icon={BugIcon}
          title="No bugs here"
          description="When a test fails, StepForge diagnoses it and files a bug with the steps to reproduce and the evidence."
        />
      ) : (
        <div className="grid gap-4 xl:grid-cols-[minmax(0,460px)_1fr]">
          <Card className="overflow-hidden">
            <ul className="divide-y divide-border" aria-label="Bug list">
              {bugs.data.map((b) => (
                <li key={b.id}>
                  <button
                    type="button"
                    onClick={() => navigate({ to: '/bugs', search: { bug: b.id } })}
                    className={cn(
                      'w-full px-4 py-3 text-left hover:bg-fg/[0.03]',
                      selected === b.id && 'bg-brand/[0.06]',
                    )}
                  >
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-xs text-muted">{b.code}</span>
                      <Badge tone={SEVERITY_TONE[b.severity]}>{b.severity}</Badge>
                      {b.ownerHint && <Badge tone={OWNER_TONE[b.ownerHint]}>{b.ownerHint}</Badge>}
                      {b.occurrences > 1 && <span className="text-xs text-muted">×{b.occurrences}</span>}
                      <span className="ml-auto text-xs text-muted">{label(b.status)}</span>
                    </div>
                    <p className="mt-0.5 line-clamp-2 text-sm">{b.title}</p>
                  </button>
                </li>
              ))}
            </ul>
          </Card>
          {selected && (
            <BugDetailView
              key={selected}
              id={selected}
              onDeleted={() => navigate({ to: '/bugs', search: {} })}
            />
          )}
        </div>
      )}
    </div>
  );
}
