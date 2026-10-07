import { describeStep } from '@stepforge/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import {
  Circle,
  Disc3,
  FilePlus2,
  FolderOpen,
  KeyRound,
  MonitorSmartphone,
  Save,
  Square,
  Trash2,
  Undo2,
  Webhook,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { EditorProvider } from '@/components/editor/context';
import { fromDrafts, toDrafts, type DraftStep } from '@/components/editor/drafts';
import { StepList } from '@/components/editor/step-list';
import { PageHeader } from '@/components/shell/layout';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, Input, Select, Switch } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { toast, toastError } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { useLiveEvent, type LiveEvent } from '@/lib/live';
import { qk, useCurrentApp, useEnvironments, useScenario, useTree } from '@/lib/queries';
import { groupOf, LAYER } from '@/lib/steps';
import { flattenModules } from '@/lib/tree';
import type { StepRecord } from '@/lib/types';
import { cn } from '@/lib/utils';

type Captured = { id: number; method: string; url: string; status: number; durationMs?: number };
/** Set when the recording was started from the Test Explorer. */
type Target = {
  scenarioId?: string;
  scenarioName?: string;
  existingSteps?: number;
  moduleId?: string;
} | null;
type Recording = {
  id: string;
  applicationId: string;
  environmentId: string;
  baseUrl: string;
  state: 'recording' | 'paused' | 'stopped';
  startUrl: string;
  steps: (Partial<Omit<StepRecord, 'id'>> & { type: string; id?: number | string; describe?: string })[];
  network: Captured[];
  secretKeys: string[];
  target?: Target;
} | null;

const RECORDER_KEY = ['recorder'] as const;
const pathOf = (u: string) => {
  try {
    const x = new URL(u);
    return `${x.pathname}${x.search}`;
  } catch {
    return u;
  }
};

export function RecorderPage() {
  const qc = useQueryClient();
  const recording = useQuery({ queryKey: RECORDER_KEY, queryFn: () => api<Recording>('/api/recorder') });
  const onEvent = useCallback(
    (e: LiveEvent) => {
      if (e.type === 'recorder.updated') qc.setQueryData(RECORDER_KEY, e.recording as Recording);
    },
    [qc],
  );
  useLiveEvent(onEvent);

  const r = recording.data;
  return (
    <>
      <PageHeader
        title="Recorder"
        description="Click through your app in a real browser. Steps, checks, secrets and network calls are captured as you go."
      />
      {recording.isPending ? (
        <Skeleton className="h-64" />
      ) : recording.isError ? (
        <ErrorState error={recording.error} onRetry={() => void recording.refetch()} />
      ) : !r ? (
        <StartPanel />
      ) : r.state === 'stopped' ? (
        <ReviewPanel rec={r} />
      ) : (
        <LivePanel rec={r} />
      )}
    </>
  );
}

function StartPanel() {
  const { app: current, apps } = useCurrentApp();
  const search = useSearch({ from: '/recorder' });
  // Opened from the Test Explorer: record into that scenario, or into that module.
  const targetScenario = useScenario(search.scenario);
  const app = apps.data?.find((a) => a.id === targetScenario.data?.applicationId) ?? current;
  const tree = useTree(app?.id);
  const targetModule = search.module
    ? tree.data && flattenModules(tree.data).find((m) => m.id === search.module)
    : undefined;
  const target = targetScenario.data
    ? { scenarioId: targetScenario.data.id }
    : targetModule
      ? { moduleId: targetModule.id }
      : {};
  const envs = useEnvironments(app?.id);
  const [envId, setEnvId] = useState('');
  const [path, setPath] = useState('/');
  const qc = useQueryClient();
  useEffect(() => {
    if (!envId && envs.data?.length) setEnvId((envs.data.find((e) => !e.isProduction) ?? envs.data[0]!).id);
  }, [envs.data, envId]);
  const start = useMutation({
    mutationFn: () =>
      api<Recording>('/api/recorder/start', {
        method: 'POST',
        json: { applicationId: app!.id, environmentId: envId, startPath: path, ...target },
      }),
    onSuccess: (rec) => qc.setQueryData(RECORDER_KEY, rec),
    onError: toastError,
  });

  if (apps.data?.length === 0) {
    return (
      <EmptyState
        icon={Disc3}
        title="Create an application first"
        description="Recordings are saved into an application's test tree."
      />
    );
  }
  const env = envs.data?.find((e) => e.id === envId);
  return (
    <div className="grid gap-5 lg:grid-cols-[1fr_380px]">
      <Card data-tour="recorder-start">
        <CardHeader>
          <CardTitle>New recording{app ? ` in ${app.name}` : ''}</CardTitle>
        </CardHeader>
        <CardBody className="space-y-4">
          {targetScenario.data ? (
            <TargetNote icon={FilePlus2}>
              Recording steps for <b className="text-fg">{targetScenario.data.name}</b>.{' '}
              {targetScenario.data.steps.length
                ? `They are added after its ${targetScenario.data.steps.length} existing step(s); you review them before saving.`
                : 'You review them before saving.'}
            </TargetNote>
          ) : targetModule ? (
            <TargetNote icon={FolderOpen}>
              The recording is saved as a new scenario in{' '}
              <b className="text-fg">{targetModule.label.trim()}</b>.
            </TargetNote>
          ) : null}
          <div className="grid gap-3 md:grid-cols-2">
            <Field label="Environment">
              <Select aria-label="Environment" value={envId} onChange={(e) => setEnvId(e.target.value)}>
                {envs.data?.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.name} · {e.baseUrl}
                  </option>
                ))}
              </Select>
            </Field>
            <Field
              label="Start page"
              hint={
                env
                  ? `Opens ${env.baseUrl.replace(/\/$/, '')}${path.startsWith('/') ? path : `/${path}`}`
                  : undefined
              }
            >
              <Input
                aria-label="Start page"
                value={path}
                onChange={(e) => setPath(e.target.value)}
                className="font-mono"
              />
            </Field>
          </div>
          {envs.data?.length === 0 && (
            <p className="text-sm text-fail">Add an environment to this application first.</p>
          )}
          <Button
            data-tour="recorder-button"
            disabled={!envId || start.isPending}
            onClick={() => start.mutate()}
          >
            <Circle className="h-3.5 w-3.5 fill-current text-fail" />{' '}
            {start.isPending ? 'Opening browser…' : 'Start recording'}
          </Button>
        </CardBody>
      </Card>
      <Card data-tour="recorder-tips">
        <CardHeader>
          <CardTitle>How it works</CardTitle>
        </CardHeader>
        <CardBody>
          <ol className="list-decimal space-y-2 pl-4 text-sm text-muted">
            <li>A Chromium window opens with the StepForge toolbar at the top.</li>
            <li>
              Use your app normally. Clicks, typing (one step per field), selects, checkboxes and Enter become
              steps.
            </li>
            <li>
              <b className="text-fg">Assert</b> adds a check on the element you click;{' '}
              <b className="text-fg">Extract</b> saves its text in a variable.
            </li>
            <li>
              Password fields are stored as encrypted secrets automatically; <b className="text-fg">Mask</b>{' '}
              does the same for any other field.
            </li>
            <li>
              Press <b className="text-fg">Stop</b> to review, edit and save the scenario. Captured API calls
              can become an API scenario.
            </li>
          </ol>
        </CardBody>
      </Card>
    </div>
  );
}

function TargetNote({ icon: Icon, children }: { icon: typeof Disc3; children: ReactNode }) {
  return (
    <div className="flex items-start gap-2.5 rounded-lg border border-brand/30 bg-brand/5 px-3 py-2.5 text-sm text-muted">
      <Icon className="mt-0.5 h-4 w-4 shrink-0 text-brand" />
      <span>{children}</span>
    </div>
  );
}

function StepLine({
  step,
  index,
}: {
  step: Partial<Omit<StepRecord, 'id'>> & { type: string };
  index: number;
}) {
  const L = LAYER[groupOf(step.type)];
  return (
    <li className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm">
      <span className="w-5 text-right font-mono text-xs text-muted">{index + 1}</span>
      <L.icon className="h-3.5 w-3.5 shrink-0" style={{ color: L.color }} />
      <span className="truncate">
        {step.label || describeStep({ ...step, params: step.params ?? {}, locators: step.locators ?? [] })}
      </span>
      {step.locators?.[0] && (
        <Badge className="ml-auto shrink-0 font-mono">{step.locators[0].strategy}</Badge>
      )}
    </li>
  );
}

function LivePanel({ rec }: { rec: NonNullable<Recording> }) {
  const qc = useQueryClient();
  const call = useMutation({
    mutationFn: (cmd: 'stop' | 'undo' | 'discard') =>
      api<Recording>(`/api/recorder/${cmd}`, { method: 'POST' }),
    onSuccess: (data, cmd) => qc.setQueryData(RECORDER_KEY, cmd === 'discard' ? null : data),
    onError: toastError,
  });
  return (
    <div className="grid gap-5 lg:grid-cols-[1fr_360px]">
      <Card>
        <div className="flex flex-wrap items-center gap-3 border-b border-border px-5 py-3">
          <span
            className={cn(
              'flex items-center gap-2 text-sm font-medium',
              rec.state === 'paused' ? 'text-warn' : 'text-fail',
            )}
          >
            <span
              className={cn(
                'h-2.5 w-2.5 rounded-full',
                rec.state === 'paused' ? 'bg-warn' : 'animate-pulse bg-fail',
              )}
            />
            {rec.state === 'paused' ? 'Paused' : 'Recording'}
          </span>
          <span className="truncate font-mono text-xs text-muted">{rec.startUrl}</span>
          {rec.target?.scenarioName && (
            <Badge className="shrink-0">Adding to “{rec.target.scenarioName}”</Badge>
          )}
          <div className="ml-auto flex gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => call.mutate('undo')}
              disabled={rec.steps.length <= 1}
            >
              <Undo2 className="h-3.5 w-3.5" /> Undo
            </Button>
            <Button variant="ghost" size="sm" onClick={() => call.mutate('discard')}>
              <Trash2 className="h-3.5 w-3.5" /> Discard
            </Button>
            <Button size="sm" onClick={() => call.mutate('stop')}>
              <Square className="h-3.5 w-3.5 fill-current" /> Stop &amp; review
            </Button>
          </div>
        </div>
        <ol className="max-h-[60vh] overflow-y-auto p-3" aria-label="Recorded steps" aria-live="polite">
          {rec.steps.map((s, i) => (
            <StepLine key={String(s.id ?? i)} step={s} index={i} />
          ))}
        </ol>
      </Card>
      <div className="space-y-4">
        <Card className="p-4 text-sm">
          <div className="flex items-center gap-2 font-medium">
            <MonitorSmartphone className="h-4 w-4 text-brand" /> The browser window is recording
          </div>
          <p className="mt-1 text-muted">
            Use the toolbar inside it to pause, add checks, save values, mask fields or stop.
          </p>
        </Card>
        <Card className="p-4 text-sm">
          <div className="flex items-center gap-2 font-medium">
            <Webhook className="h-4 w-4 text-indigo" /> {rec.network.length} API call(s) captured
          </div>
          <ul className="mt-2 max-h-48 space-y-1 overflow-y-auto font-mono text-xs text-muted">
            {rec.network.slice(-12).map((n) => (
              <li key={n.id} className="truncate">
                {n.method} {pathOf(n.url)}{' '}
                <span className={n.status >= 400 ? 'text-fail' : 'text-pass'}>{n.status}</span>
              </li>
            ))}
          </ul>
        </Card>
        {rec.secretKeys.length > 0 && (
          <Card className="p-4 text-sm">
            <div className="flex items-center gap-2 font-medium">
              <KeyRound className="h-4 w-4 text-warn" /> Secrets captured
            </div>
            <p className="mt-1 font-mono text-xs text-muted">
              {rec.secretKeys.map((k) => `{{secret.${k}}}`).join(', ')}
            </p>
          </Card>
        )}
      </div>
    </div>
  );
}

function ReviewPanel({ rec }: { rec: NonNullable<Recording> }) {
  const tree = useTree(rec.applicationId);
  const modules = useMemo(() => (tree.data ? flattenModules(tree.data) : []), [tree.data]);
  const [moduleId, setModuleId] = useState(rec.target?.moduleId ?? '');
  const [name, setName] = useState('Recorded scenario');
  // Started from a scenario: add the steps to it, unless the user chooses a new scenario instead.
  const [append, setAppend] = useState(!!rec.target?.scenarioId);
  const appendTo = append && rec.target?.scenarioId ? rec.target : null;
  const [steps, setSteps] = useState<DraftStep[]>(() =>
    toDrafts(
      rec.steps.map(({ id: _id, describe: _d, ...s }) => ({
        enabled: true,
        continueOnFail: false,
        retries: 0,
        locators: [],
        assertions: [],
        ...s,
        params: s.params ?? {},
      })),
    ),
  );
  const [saveSecrets, setSaveSecrets] = useState(true);
  const unique = useMemo(() => {
    const seen = new Set<string>();
    return rec.network.filter((n) => {
      const key = `${n.method} ${pathOf(n.url)
        .split('?')[0]!
        .replace(/\/\d+(?=\/|$)/g, '/{id}')}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [rec.network]);
  const [picked, setPicked] = useState<Set<number>>(() => new Set(unique.map((n) => n.id)));
  const [makeApi, setMakeApi] = useState(unique.length > 0);
  const qc = useQueryClient();
  const navigate = useNavigate();
  useEffect(() => {
    if (!moduleId && modules.length) setModuleId(modules[0]!.id);
  }, [modules, moduleId]);

  const save = useMutation({
    mutationFn: () =>
      api<{ scenario: { id: string } }>('/api/recorder/save', {
        method: 'POST',
        json: {
          ...(appendTo ? { scenarioId: appendTo.scenarioId } : { moduleId, name }),
          steps: fromDrafts(steps),
          saveSecrets,
          ...(makeApi && picked.size
            ? {
                apiScenario: {
                  name: `${appendTo?.scenarioName ?? name} — API calls`,
                  requestIds: [...picked],
                },
              }
            : {}),
        },
      }),
    onSuccess: (r) => {
      qc.setQueryData(RECORDER_KEY, null);
      qc.invalidateQueries({ queryKey: qk.tree(rec.applicationId) });
      qc.invalidateQueries({ queryKey: qk.scenario(r.scenario.id) });
      toast(
        appendTo ? `Added ${steps.length} recorded step(s) to the scenario` : 'Recording saved as a scenario',
      );
      navigate({ to: '/explorer', search: { scenario: r.scenario.id, tab: 'steps' } });
    },
    onError: toastError,
  });
  const discard = useMutation({
    mutationFn: () => api('/api/recorder/discard', { method: 'POST' }),
    onSuccess: () => qc.setQueryData(RECORDER_KEY, null),
  });

  return (
    <div className="grid gap-5 lg:grid-cols-[1fr_380px]">
      <Card>
        <CardHeader>
          <CardTitle>Review {steps.length} recorded steps</CardTitle>
          <Badge tone="pass">Stopped</Badge>
        </CardHeader>
        <CardBody>
          <EditorProvider applicationId={rec.applicationId}>
            <StepList steps={steps} onChange={setSteps} />
          </EditorProvider>
        </CardBody>
      </Card>
      <div className="space-y-4">
        <Card>
          <CardBody className="space-y-3 pt-5">
            {appendTo ? (
              <>
                <TargetNote icon={FilePlus2}>
                  The {steps.length} recorded step(s) are added to{' '}
                  <Link
                    to="/explorer"
                    search={{ scenario: appendTo.scenarioId }}
                    className="font-medium text-fg hover:underline"
                  >
                    {appendTo.scenarioName}
                  </Link>
                  {appendTo.existingSteps ? `, after its ${appendTo.existingSteps} existing step(s)` : ''}.
                </TargetNote>
                <button className="text-xs text-muted hover:text-fg" onClick={() => setAppend(false)}>
                  Save as a new scenario instead
                </button>
              </>
            ) : (
              <>
                <Field label="Scenario name">
                  <Input aria-label="Scenario name" value={name} onChange={(e) => setName(e.target.value)} />
                </Field>
                <Field label="Save into module">
                  <Select
                    aria-label="Save into module"
                    value={moduleId}
                    onChange={(e) => setModuleId(e.target.value)}
                  >
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
                {rec.target?.scenarioId && (
                  <button className="text-xs text-muted hover:text-fg" onClick={() => setAppend(true)}>
                    Add to “{rec.target.scenarioName}” instead
                  </button>
                )}
              </>
            )}
            {rec.secretKeys.length > 0 && (
              <label className="flex items-start gap-2 text-sm">
                <Switch checked={saveSecrets} onChange={setSaveSecrets} label="Store captured secrets" />
                <span>
                  Store{' '}
                  {rec.secretKeys.map((k) => (
                    <code key={k} className="mx-0.5 text-xs">
                      {k}
                    </code>
                  ))}{' '}
                  as encrypted secret(s) in this environment
                </span>
              </label>
            )}
            <div className="flex gap-2 pt-1">
              <Button
                disabled={(!appendTo && (!moduleId || !name.trim())) || steps.length === 0 || save.isPending}
                onClick={() => save.mutate()}
              >
                <Save className="h-4 w-4" /> {appendTo ? 'Add to scenario' : 'Save scenario'}
              </Button>
              <Button variant="ghost" onClick={() => discard.mutate()}>
                Discard
              </Button>
            </div>
          </CardBody>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Captured API calls</CardTitle>
            <span className="text-xs text-muted">{unique.length} unique</span>
          </CardHeader>
          <CardBody className="space-y-2">
            {unique.length === 0 ? (
              <p className="text-sm text-muted">No XHR/fetch calls were made while recording.</p>
            ) : (
              <>
                <label className="flex items-center gap-2 text-sm">
                  <Switch checked={makeApi} onChange={setMakeApi} label="Create API tests" /> Create API tests
                  from {picked.size} selected request(s)
                </label>
                <ul className="max-h-56 space-y-1 overflow-y-auto">
                  {unique.map((n) => (
                    <li key={n.id}>
                      <label className="flex items-center gap-2 font-mono text-xs">
                        <input
                          type="checkbox"
                          className="accent-[#F97316]"
                          checked={picked.has(n.id)}
                          onChange={() =>
                            setPicked((p) => {
                              const next = new Set(p);
                              if (next.has(n.id)) next.delete(n.id);
                              else next.add(n.id);
                              return next;
                            })
                          }
                        />
                        <span className="w-12 font-semibold">{n.method}</span>
                        <span className="flex-1 truncate">{pathOf(n.url)}</span>
                        <span className={n.status >= 400 ? 'text-fail' : 'text-pass'}>{n.status}</span>
                      </label>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </CardBody>
        </Card>
      </div>
    </div>
  );
}
