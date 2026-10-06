import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { Download, ExternalLink, Gauge, Play, Save, ShieldAlert, ShieldCheck, Square } from 'lucide-react';
import { useCallback, useState } from 'react';
import { LoadReportView, LoadTimeline } from '@/components/perf/load-report';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Select, Textarea } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { Tabs } from '@/components/ui/tabs';
import { toast, toastError } from '@/components/ui/toast';
import { api, ApiError, artifactUrl } from '@/lib/api';
import type { LiveEvent } from '@/lib/live';
import { useLiveEvent } from '@/lib/live';
import { qk, useCurrentApp, useEnvironments, useTree } from '@/lib/queries';
import { flattenModules } from '@/lib/tree';
import type {
  Application,
  Environment,
  LighthouseResult,
  LoadProfile,
  LoadReport,
  LoadThresholds,
  LoadTick,
  PerfInfo,
  ScenarioDetail,
} from '@/lib/types';

type LoadRequestDraft = {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
  auth?: Record<string, unknown>;
};
type Design = {
  source: 'endpoint' | 'scenario';
  method: string;
  url: string;
  bearer: string;
  headers: string;
  body: string;
  scenarioId: string;
  profile: LoadProfile;
  vus: string;
  durationS: string;
  rampS: string;
  p95Ms: string;
  p99Ms: string;
  maxErrorRatePct: string;
  minRps: string;
  engine: 'builtin' | 'k6';
};

const num = (v: string) => (v.trim() === '' ? undefined : Number(v));

function parseJson(text: string, what: string): unknown {
  if (!text.trim()) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${what} is not valid JSON`);
  }
}

/** The perf.loadTest params for a design (requests keep their {{…}} placeholders; the server resolves them). */
function toParams(d: Design, scenario: ScenarioDetail | undefined) {
  let requests: LoadRequestDraft[];
  if (d.source === 'scenario') {
    requests = (scenario?.steps ?? [])
      .filter((s) => s.type === 'api.request' && s.enabled)
      .map((s) => {
        const p = s.params as Record<string, unknown>;
        return {
          method: String(p.method ?? 'GET'),
          url: String(p.url ?? ''),
          ...(p.headers ? { headers: p.headers as Record<string, string> } : {}),
          ...(p.body !== undefined ? { body: p.body } : {}),
          ...(p.auth ? { auth: p.auth as Record<string, unknown> } : {}),
        };
      });
    if (!requests.length) throw new Error('The chosen scenario has no api.request steps');
  } else {
    requests = [
      {
        method: d.method,
        url: d.url,
        ...(d.headers.trim() && { headers: parseJson(d.headers, 'Headers') as Record<string, string> }),
        ...(d.body.trim() && { body: parseJson(d.body, 'Body') }),
        ...(d.bearer.trim() && { auth: { type: 'bearer', token: d.bearer.trim() } }),
      },
    ];
  }
  const thresholds: LoadThresholds = {
    ...(num(d.p95Ms) !== undefined && { p95Ms: num(d.p95Ms) }),
    ...(num(d.p99Ms) !== undefined && { p99Ms: num(d.p99Ms) }),
    ...(num(d.maxErrorRatePct) !== undefined && { maxErrorRatePct: num(d.maxErrorRatePct) }),
    ...(num(d.minRps) !== undefined && { minRps: num(d.minRps) }),
  };
  return {
    requests,
    profile: d.profile,
    vus: Number(d.vus) || 1,
    durationS: Number(d.durationS) || 10,
    ...(d.profile === 'load' && num(d.rampS) !== undefined && { rampS: num(d.rampS) }),
    thresholds,
    engine: d.engine,
  };
}

function AuthorizationGate({ app, info }: { app: Application; info: PerfInfo }) {
  const qc = useQueryClient();
  const [checked, setChecked] = useState(false);
  const key = ['load-authorization', app.id];
  const auth = useQuery({
    queryKey: key,
    queryFn: () =>
      api<{ authorization: { at: string } | null }>(`/api/applications/${app.id}/load-authorization`),
  });
  const set = useMutation({
    mutationFn: (on: boolean) =>
      on
        ? api(`/api/applications/${app.id}/load-authorization`, { method: 'POST', json: { confirm: true } })
        : api(`/api/applications/${app.id}/load-authorization`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: key }),
    onError: toastError,
  });
  if (auth.isPending) return <Skeleton className="h-16" />;
  const a = auth.data?.authorization;
  if (a)
    return (
      <p className="flex items-center gap-2 text-xs text-muted" data-testid="load-authorized">
        <ShieldCheck className="h-3.5 w-3.5 text-pass" /> You confirmed you own or are authorized to test{' '}
        {app.name} on {new Date(a.at).toLocaleString()}.
        <button type="button" className="text-brand hover:underline" onClick={() => set.mutate(false)}>
          Withdraw
        </button>
      </p>
    );
  return (
    <div role="alert" className="space-y-2 rounded-lg border border-warn/40 bg-warn/10 p-3 text-sm">
      <p className="flex items-center gap-2 font-medium">
        <ShieldAlert className="h-4 w-4" /> Only load-test systems you own or are authorized to test.
      </p>
      <p className="text-muted">
        Load tests send many requests quickly. Running them against systems you do not control can be illegal
        and can harm others. Your own computer also limits how much load it can generate.
      </p>
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          className="accent-brand"
          checked={checked}
          onChange={(e) => setChecked(e.target.checked)}
        />
        {info.authorizationStatement.replace('this system', app.name)}
      </label>
      <Button size="sm" disabled={!checked || set.isPending} onClick={() => set.mutate(true)}>
        Confirm for {app.name}
      </Button>
    </div>
  );
}

function SaveLoadTestDialog({
  app,
  params,
  onClose,
}: {
  app: Application;
  params: Record<string, unknown>;
  onClose: () => void;
}) {
  const tree = useTree(app.id);
  const modules = tree.data ? flattenModules(tree.data) : [];
  const [moduleId, setModuleId] = useState('');
  const [name, setName] = useState(`Load test (${String(params.profile)}, ${String(params.vus)} VUs)`);
  const qc = useQueryClient();
  const navigate = useNavigate();
  const target = moduleId || modules[0]?.id || '';
  const save = useMutation({
    mutationFn: () =>
      api<ScenarioDetail>(`/api/modules/${target}/scenarios`, {
        method: 'POST',
        json: { name, steps: [{ type: 'perf.loadTest', params }] },
      }),
    onSuccess: (s) => {
      void qc.invalidateQueries({ queryKey: qk.tree(app.id) });
      toast('Saved as a load test');
      navigate({ to: '/explorer', search: { scenario: s.id } });
    },
    onError: toastError,
  });
  return (
    <Dialog
      open
      onClose={onClose}
      title="Save as load test"
      description="Creates a scenario with a perf.loadTest step; its thresholds decide pass or fail when it runs."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!target || !name.trim() || save.isPending} onClick={() => save.mutate()}>
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="Name">
          <Input aria-label="Test name" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Module">
          <Select aria-label="Save into module" value={target} onChange={(e) => setModuleId(e.target.value)}>
            {modules.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </Select>
        </Field>
        {modules.length === 0 && (
          <p className="text-sm text-fail">Create a module in the Test Explorer first.</p>
        )}
      </div>
    </Dialog>
  );
}

function LoadDesigner({ app, env, info }: { app: Application; env: Environment; info: PerfInfo }) {
  const tree = useTree(app.id);
  const [d, setD] = useState<Design>({
    source: 'endpoint',
    method: 'GET',
    url: '/',
    bearer: '',
    headers: '',
    body: '',
    scenarioId: '',
    profile: 'load',
    vus: '10',
    durationS: '30',
    rampS: '5',
    p95Ms: '800',
    p99Ms: '',
    maxErrorRatePct: '1',
    minRps: '',
    engine: 'builtin',
  });
  const set = (p: Partial<Design>) => setD((x) => ({ ...x, ...p }));
  const scenario = useQuery({
    queryKey: qk.scenario(d.scenarioId),
    queryFn: () => api<ScenarioDetail>(`/api/scenarios/${d.scenarioId}`),
    enabled: d.source === 'scenario' && !!d.scenarioId,
  });
  const [loadId, setLoadId] = useState<string | null>(null);
  const [ticks, setTicks] = useState<LoadTick[]>([]);
  const [report, setReport] = useState<LoadReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState<Record<string, unknown> | null>(null);

  const onEvent = useCallback(
    (e: LiveEvent) => {
      if (!loadId || e.loadId !== loadId) return;
      if (e.type === 'load.tick') setTicks((t) => [...t, e.tick as LoadTick]);
      if (e.type === 'load.finished')
        void api<{ status: string; report?: LoadReport; error?: string }>(`/api/perf/load/${loadId}`).then(
          (r) => {
            setLoadId(null);
            if (r.report) setReport(r.report);
            if (r.error) setError(r.error);
          },
        );
    },
    [loadId],
  );
  useLiveEvent(onEvent);

  const params = () => {
    try {
      return toParams(d, scenario.data);
    } catch (err) {
      setError((err as Error).message);
      return null;
    }
  };
  const start = useMutation({
    mutationFn: (confirm?: string) => {
      const p = toParams(d, scenario.data);
      return api<{ id: string }>('/api/perf/load', {
        method: 'POST',
        json: { applicationId: app.id, environmentId: env.id, params: p, ...(confirm && { confirm }) },
      });
    },
    onMutate: () => {
      setTicks([]);
      setReport(null);
      setError(null);
    },
    onSuccess: (r) => setLoadId(r.id),
    onError: (err) => {
      if (err instanceof ApiError && err.code === 'confirmation_required') setConfirming(true);
      else setError(err.message);
    },
  });
  const cancel = useMutation({
    mutationFn: () => api(`/api/perf/load/${loadId}/cancel`, { method: 'POST' }),
  });
  const exportK6 = useMutation({
    mutationFn: () => {
      const p = toParams(d, scenario.data);
      return api<{ script: string }>('/api/perf/k6-export', {
        method: 'POST',
        json: { environmentId: env.id, name: `${app.name} load test`, params: p },
      });
    },
    onSuccess: ({ script }) => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([script], { type: 'text/javascript' }));
      a.download = `${app.slug}-load-test.js`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      toast('k6 script downloaded');
    },
    onError: toastError,
  });

  const profileHelp = info.profiles.find((p) => p.id === d.profile)?.help;
  const apiScenarios = (tree.data?.scenarios ?? []).filter((s) => s.kind === 'api' || s.kind === 'hybrid');

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,420px)_1fr]">
      <Card>
        <CardBody className="space-y-4">
          <Tabs
            value={d.source}
            onChange={(source) => set({ source })}
            tabs={[
              { value: 'endpoint', label: 'Endpoint' },
              { value: 'scenario', label: 'From an API scenario' },
            ]}
          />
          {d.source === 'endpoint' ? (
            <div className="space-y-3">
              <div className="flex gap-2">
                <Select
                  aria-label="Method"
                  className="w-28"
                  value={d.method}
                  onChange={(e) => set({ method: e.target.value })}
                >
                  {['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((m) => (
                    <option key={m}>{m}</option>
                  ))}
                </Select>
                <Input
                  aria-label="URL"
                  className="font-mono text-xs"
                  value={d.url}
                  onChange={(e) => set({ url: e.target.value })}
                  placeholder="/api/products"
                />
              </div>
              <Field
                label="Bearer token (optional)"
                hint="Use a secret, e.g. {{secret.apiToken}} — resolved on the server"
              >
                <Input
                  className="font-mono text-xs"
                  value={d.bearer}
                  onChange={(e) => set({ bearer: e.target.value })}
                />
              </Field>
              <Field label="Headers (JSON, optional)">
                <Textarea
                  className="font-mono text-xs"
                  rows={2}
                  value={d.headers}
                  onChange={(e) => set({ headers: e.target.value })}
                />
              </Field>
              {d.method !== 'GET' && (
                <Field label="Body (JSON, optional)">
                  <Textarea
                    className="font-mono text-xs"
                    rows={3}
                    value={d.body}
                    onChange={(e) => set({ body: e.target.value })}
                  />
                </Field>
              )}
            </div>
          ) : (
            <Field label="API scenario" hint="Each virtual user repeats its api.request steps in order">
              <Select value={d.scenarioId} onChange={(e) => set({ scenarioId: e.target.value })}>
                <option value="">Choose…</option>
                {apiScenarios.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </Select>
            </Field>
          )}

          <div className="grid grid-cols-2 gap-3">
            <Field label="Profile" className="col-span-2" hint={profileHelp}>
              <Select
                aria-label="Profile"
                value={d.profile}
                onChange={(e) => set({ profile: e.target.value as LoadProfile })}
              >
                {info.profiles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.id}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Virtual users">
              <Input
                aria-label="Virtual users"
                inputMode="numeric"
                value={d.vus}
                onChange={(e) => set({ vus: e.target.value.replace(/\D/g, '') })}
              />
            </Field>
            <Field label="Duration (s)">
              <Input
                aria-label="Duration"
                inputMode="numeric"
                value={d.durationS}
                onChange={(e) => set({ durationS: e.target.value.replace(/\D/g, '') })}
              />
            </Field>
            {d.profile === 'load' && (
              <Field label="Ramp-up (s)">
                <Input
                  aria-label="Ramp-up"
                  inputMode="numeric"
                  value={d.rampS}
                  onChange={(e) => set({ rampS: e.target.value.replace(/\D/g, '') })}
                />
              </Field>
            )}
            <Field label="Engine">
              <Select
                aria-label="Engine"
                value={d.engine}
                onChange={(e) => set({ engine: e.target.value as Design['engine'] })}
              >
                <option value="builtin">Built-in (autocannon)</option>
                <option value="k6" disabled={!info.k6.available}>
                  k6{info.k6.available ? '' : ' (not installed)'}
                </option>
              </Select>
            </Field>
          </div>
          <div>
            <p className="mb-2 text-xs font-medium text-muted">Thresholds (empty = not checked)</p>
            <div className="grid grid-cols-2 gap-3">
              <Field label="p95 below (ms)">
                <Input
                  aria-label="p95 threshold"
                  inputMode="numeric"
                  value={d.p95Ms}
                  onChange={(e) => set({ p95Ms: e.target.value })}
                />
              </Field>
              <Field label="p99 below (ms)">
                <Input
                  aria-label="p99 threshold"
                  inputMode="numeric"
                  value={d.p99Ms}
                  onChange={(e) => set({ p99Ms: e.target.value })}
                />
              </Field>
              <Field label="Error rate below (%)">
                <Input
                  aria-label="Error rate threshold"
                  inputMode="decimal"
                  value={d.maxErrorRatePct}
                  onChange={(e) => set({ maxErrorRatePct: e.target.value })}
                />
              </Field>
              <Field label="At least (req/s)">
                <Input
                  aria-label="Throughput threshold"
                  inputMode="numeric"
                  value={d.minRps}
                  onChange={(e) => set({ minRps: e.target.value })}
                />
              </Field>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            {loadId ? (
              <Button variant="outline" onClick={() => cancel.mutate()}>
                <Square className="h-4 w-4" /> Stop
              </Button>
            ) : (
              <Button disabled={start.isPending} onClick={() => start.mutate(undefined)}>
                <Play className="h-4 w-4" /> Run load test
              </Button>
            )}
            <Button variant="outline" disabled={exportK6.isPending} onClick={() => exportK6.mutate()}>
              <Download className="h-4 w-4" /> Export k6 script
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                const p = params();
                if (p) setSaving(p);
              }}
            >
              <Save className="h-4 w-4" /> Save as test
            </Button>
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{loadId ? 'Running…' : report ? 'Report' : 'Results'}</CardTitle>
        </CardHeader>
        <CardBody>
          {error && (
            <p
              role="alert"
              className="mb-3 rounded-lg border border-fail/40 bg-fail/10 px-3 py-2 text-sm text-fail"
            >
              {error}
            </p>
          )}
          {loadId && (
            <div className="space-y-2" data-testid="load-live">
              <p className="text-sm text-muted">
                {ticks.length} s · {ticks.at(-1)?.totalRequests ?? 0} requests · {ticks.at(-1)?.vus ?? 0} VUs
                · {ticks.reduce((s, t) => s + t.errors, 0)} errors
              </p>
              <LoadTimeline points={ticks} />
            </div>
          )}
          {report && <LoadReportView report={report} />}
          {!loadId && !report && !error && (
            <EmptyState
              icon={Gauge}
              title="No load test yet"
              description="Design a test on the left and run it. Results stream in live."
            />
          )}
        </CardBody>
      </Card>

      <ConfirmDialog
        open={confirming}
        onClose={() => setConfirming(false)}
        title="Load-test a production environment?"
        description={`${env.name} is marked as production. Type the application name to start.`}
        confirmLabel="Start load test"
        typeToConfirm={app.name}
        onConfirm={(typed) => {
          setConfirming(false);
          start.mutate(typed);
        }}
      />
      {saving && <SaveLoadTestDialog app={app} params={saving} onClose={() => setSaving(null)} />}
    </div>
  );
}

function scoreTone(n: number) {
  return n >= 90 ? 'text-pass' : n >= 50 ? 'text-warn' : 'text-fail';
}

function LighthousePanel({ env, info }: { env: Environment; info: PerfInfo }) {
  const [url, setUrl] = useState('/');
  const [formFactor, setFormFactor] = useState<'desktop' | 'mobile'>('desktop');
  const [cats, setCats] = useState<string[]>(info.lighthouseCategories);
  const run = useMutation({
    mutationFn: () =>
      api<LighthouseResult>('/api/perf/lighthouse', {
        method: 'POST',
        json: { environmentId: env.id, url, formFactor, categories: cats },
      }),
  });
  const r = run.data;
  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,420px)_1fr]">
      <Card>
        <CardBody className="space-y-3">
          <Field label="Page" hint={`Relative to ${env.baseUrl}`}>
            <Input
              aria-label="Page URL"
              className="font-mono text-xs"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
          </Field>
          <Field label="Device">
            <Select
              value={formFactor}
              onChange={(e) => setFormFactor(e.target.value as 'desktop' | 'mobile')}
            >
              <option value="desktop">Desktop</option>
              <option value="mobile">Mobile (throttled)</option>
            </Select>
          </Field>
          <div className="space-y-1">
            <p className="text-xs font-medium text-muted">Categories</p>
            {info.lighthouseCategories.map((c) => (
              <label key={c} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="accent-brand"
                  checked={cats.includes(c)}
                  onChange={(e) => setCats((x) => (e.target.checked ? [...x, c] : x.filter((y) => y !== c)))}
                />
                {c}
              </label>
            ))}
          </div>
          <Button disabled={!cats.length || run.isPending} onClick={() => run.mutate()}>
            <Gauge className="h-4 w-4" /> {run.isPending ? 'Running Lighthouse…' : 'Run Lighthouse'}
          </Button>
          <p className="text-xs text-muted">
            Lighthouse loads the page in a fresh browser (no login). For pages behind a login, use page
            metrics in a scenario.
          </p>
        </CardBody>
      </Card>
      <Card>
        <CardBody>
          {run.error && <ErrorState error={run.error} onRetry={() => run.mutate()} />}
          {run.isPending && <Skeleton className="h-40" />}
          {r && (
            <div className="space-y-4" data-testid="lighthouse-result">
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                {Object.entries(r.scores).map(([k, v]) => (
                  <div key={k} className="rounded-lg border border-border p-3 text-center">
                    <div className={`font-mono text-3xl font-semibold ${scoreTone(v)}`}>{v}</div>
                    <div className="text-xs text-muted">{k}</div>
                  </div>
                ))}
              </div>
              <p className="text-sm text-muted">
                {[
                  r.metrics.lcp !== undefined && `LCP ${Math.round(r.metrics.lcp)} ms`,
                  r.metrics.fcp !== undefined && `FCP ${Math.round(r.metrics.fcp)} ms`,
                  r.metrics.tbt !== undefined && `TBT ${Math.round(r.metrics.tbt)} ms`,
                  r.metrics.cls !== undefined && `CLS ${r.metrics.cls}`,
                ]
                  .filter(Boolean)
                  .join(' · ')}{' '}
                · {r.url} · {Math.round(r.durationMs / 1000)} s
              </p>
              {r.warnings.map((w) => (
                <p key={w} className="text-xs text-warn">
                  {w}
                </p>
              ))}
              {r.reportFile && (
                <a
                  href={artifactUrl(r.reportFile)}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-sm text-brand hover:underline"
                >
                  <ExternalLink className="h-3.5 w-3.5" /> Open the full Lighthouse report
                </a>
              )}
            </div>
          )}
          {!r && !run.isPending && !run.error && (
            <EmptyState
              icon={Gauge}
              title="Lighthouse"
              description="Scores for performance, accessibility, best practices and SEO, with the full report."
            />
          )}
        </CardBody>
      </Card>
    </div>
  );
}

export function PerformancePage() {
  const { app, apps } = useCurrentApp();
  const envs = useEnvironments(app?.id);
  const [envId, setEnvId] = useState<string | null>(null);
  const [tab, setTab] = useState<'load' | 'lighthouse'>('load');
  const info = useQuery({ queryKey: ['perf-info'], queryFn: () => api<PerfInfo>('/api/perf/info') });
  const env = envs.data?.find((e) => e.id === envId) ?? envs.data?.[0];

  if (apps.isPending || info.isPending) return <Skeleton className="h-64" />;
  if (info.isError) return <ErrorState error={info.error} onRetry={() => info.refetch()} />;
  if (!app)
    return (
      <EmptyState
        icon={Gauge}
        title="No application yet"
        description="Create an application with an environment to run load tests and Lighthouse."
        action={
          <Link to="/applications">
            <Button>Go to Applications</Button>
          </Link>
        }
      />
    );
  if (envs.isPending) return <Skeleton className="h-64" />;
  if (!env)
    return (
      <EmptyState
        icon={Gauge}
        title="Add an environment first"
        description="Performance tests run against an environment's base URL."
      />
    );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold tracking-tight">Performance</h1>
        <Select
          aria-label="Environment"
          className="w-56"
          value={env.id}
          onChange={(e) => setEnvId(e.target.value)}
        >
          {envs.data!.map((e) => (
            <option key={e.id} value={e.id}>
              {e.name}
              {e.isProduction ? ' (production)' : ''}
            </option>
          ))}
        </Select>
        <span className="font-mono text-xs text-muted">{env.baseUrl}</span>
        {env.isProduction && <Badge tone="fail">production</Badge>}
      </div>
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { value: 'load', label: 'Load Designer' },
          { value: 'lighthouse', label: 'Lighthouse' },
        ]}
      />
      {tab === 'load' ? (
        <>
          <AuthorizationGate app={app} info={info.data} />
          <LoadDesigner key={`${app.id}-${env.id}`} app={app} env={env} info={info.data} />
        </>
      ) : (
        <LighthousePanel env={env} info={info.data} />
      )}
    </div>
  );
}
