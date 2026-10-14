import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { Play, ShieldAlert } from 'lucide-react';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Select, Switch } from '@/components/ui/input';
import { toastError } from '@/components/ui/toast';
import { api, type Settings } from '@/lib/api';
import { useApplications, useEnvironments, useTags, useTree } from '@/lib/queries';
import type { Run, RunOptionsForm, RunScope } from '@/lib/types';
import { flattenModules } from '@/lib/tree';

type Request = { applicationId: string; scope?: RunScope; label?: string; mode?: 'auto' | 'manual' };
let current: Request | null = null;
const listeners = new Set<() => void>();
/** Opens the run dialog from anywhere (Explorer, bulk bar, top bar, command palette). */
export function openRunDialog(r: Request | null): void {
  current = r;
  listeners.forEach((l) => l());
}
const close = () => openRunDialog(null);

const OPTIONS_KEY = 'stepforge.runOptions';
const DEFAULTS: RunOptionsForm = {
  browser: 'chromium',
  viewport: 'desktop',
  headed: false,
  workers: 1,
  retries: 0,
  stopOnFirstFailure: false,
  video: 'onFailure',
  trace: 'onFailure',
  screenshots: 'everyStep',
  pageMetrics: false,
};
/** Saved choices from the last run win; otherwise Settings → Runner defaults. */
function loadOptions(settings?: Partial<Settings>): RunOptionsForm {
  const base: RunOptionsForm = {
    ...DEFAULTS,
    ...(settings?.defaultBrowser && { browser: settings.defaultBrowser }),
    ...(settings?.defaultViewport && { viewport: settings.defaultViewport }),
    ...(settings?.workers && { workers: Math.min(8, settings.workers) }),
  };
  try {
    return { ...base, ...JSON.parse(localStorage.getItem(OPTIONS_KEY) ?? '{}') };
  } catch {
    return base;
  }
}

export function RunDialogHost() {
  const req = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    },
    () => current,
  );
  return req ? <RunDialog key={JSON.stringify(req)} req={req} /> : null;
}

function RunDialog({ req }: { req: Request }) {
  const envs = useEnvironments(req.applicationId);
  // Phone apps are not opened with the panel yet: the tester uses the phone, emulator or simulator and marks steps here.
  const platform = useApplications().data?.find((a) => a.id === req.applicationId)?.platform;
  const phone = platform === 'android' || platform === 'ios';
  const tree = useTree(req.scope ? null : req.applicationId);
  const tags = useTags(req.scope ? null : req.applicationId);
  const [envId, setEnvId] = useState('');
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => api<Settings>('/api/settings') });
  const [opts, setOpts] = useState<RunOptionsForm>(() => loadOptions(settings.data));
  const [settled, setSettled] = useState(!!settings.data);
  useEffect(() => {
    if (!settled && settings.data) {
      setOpts(loadOptions(settings.data));
      setSettled(true);
    }
  }, [settings.data, settled]);
  const [scopeChoice, setScopeChoice] = useState('application');
  const [mode, setMode] = useState<'auto' | 'manual'>(req.mode ?? 'auto');
  const [openBrowser, setOpenBrowser] = useState(true);
  const navigate = useNavigate();
  const qc = useQueryClient();

  useEffect(() => {
    if (!envId && envs.data?.length) setEnvId((envs.data.find((e) => !e.isProduction) ?? envs.data[0]!).id);
  }, [envs.data, envId]);

  const scope: RunScope =
    req.scope ??
    (scopeChoice === 'application'
      ? { type: 'application' }
      : scopeChoice.startsWith('tag:')
        ? { type: 'tag', id: scopeChoice.slice(4) }
        : { type: 'module', id: scopeChoice.slice(7) });
  const env = envs.data?.find((e) => e.id === envId);
  const set = (p: Partial<RunOptionsForm>) => setOpts((o) => ({ ...o, ...p }));

  const start = useMutation({
    mutationFn: () => {
      try {
        localStorage.setItem(OPTIONS_KEY, JSON.stringify(opts));
      } catch {
        /* storage unavailable */
      }
      return api<Run>('/api/runs', {
        method: 'POST',
        json: { applicationId: req.applicationId, environmentId: envId, scope, options: opts, mode },
      });
    },
    onSuccess: async (run) => {
      qc.invalidateQueries({ queryKey: ['runs'] });
      close();
      navigate({ to: '/runs/$runId', params: { runId: run.id } });
      // A manual run opens the tester's browser on the first test right away.
      if (mode === 'manual' && openBrowser && !phone) {
        try {
          const detail = await api<{ items: { id: string }[] }>(`/api/runs/${run.id}`);
          const first = detail.items[0];
          if (first) await api(`/api/run-items/${first.id}/manual/browser`, { method: 'POST' });
        } catch (err) {
          toastError(err);
        }
      }
    },
  });

  return (
    <Dialog
      open
      onClose={close}
      title="Run tests"
      description={req.label ?? 'Choose what to run and how.'}
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button disabled={!envId || start.isPending} onClick={() => start.mutate()}>
            <Play className="h-4 w-4 fill-current" /> {mode === 'manual' ? 'Start manual run' : 'Start run'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field
          label="How"
          hint={
            mode === 'manual'
              ? 'Nothing runs automatically: you follow each test’s steps and record passed, failed or blocked'
              : undefined
          }
        >
          <Select
            aria-label="How"
            value={mode}
            onChange={(e) => setMode(e.target.value as 'auto' | 'manual')}
          >
            <option value="auto">Automated — StepForge runs the steps</option>
            <option value="manual">Manual — a person follows the steps and records results</option>
          </Select>
        </Field>
        {mode === 'manual' && phone && (
          <p className="text-xs text-muted">
            Use the app on your phone, emulator or simulator and mark each step on the run page.
          </p>
        )}
        {mode === 'manual' && !phone && (
          <label className="flex items-center gap-2 text-sm">
            <Switch checked={openBrowser} onChange={setOpenBrowser} label="Open the browser now" /> Open the
            browser now, with the steps beside the app
          </label>
        )}
        {!req.scope && (
          <Field label="Scope">
            <Select aria-label="Scope" value={scopeChoice} onChange={(e) => setScopeChoice(e.target.value)}>
              <option value="application">Whole application</option>
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
                  {flattenModules(tree.data).map((m) => (
                    <option key={m.id} value={`module:${m.id}`}>
                      {m.label}
                    </option>
                  ))}
                </optgroup>
              ) : null}
            </Select>
          </Field>
        )}
        <Field label="Environment">
          <Select aria-label="Environment" value={envId} onChange={(e) => setEnvId(e.target.value)}>
            {envs.data?.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name} · {e.baseUrl}
                {e.isProduction ? ' (production)' : ''}
              </option>
            ))}
          </Select>
        </Field>
        {envs.data?.length === 0 && (
          <p className="text-sm text-fail">Add an environment to this application first.</p>
        )}
        {env?.isProduction && (
          <div
            className="flex items-center gap-2 rounded-lg border border-fail/40 bg-fail/10 px-3 py-2 text-sm text-fail"
            role="alert"
          >
            <ShieldAlert className="h-4 w-4" /> You are about to run against production.
          </div>
        )}
        {mode === 'auto' && (
          <>
            <div className="grid grid-cols-3 gap-3">
              <Field label="Browser">
                <Select
                  aria-label="Browser"
                  value={opts.browser}
                  onChange={(e) => set({ browser: e.target.value as RunOptionsForm['browser'] })}
                >
                  <option value="chromium">Chromium</option>
                  <option value="firefox">Firefox</option>
                  <option value="webkit">WebKit</option>
                </Select>
              </Field>
              <Field label="Viewport">
                <Select
                  aria-label="Viewport"
                  value={opts.viewport}
                  onChange={(e) => set({ viewport: e.target.value as RunOptionsForm['viewport'] })}
                >
                  <option value="desktop">Desktop 1440</option>
                  <option value="tablet">Tablet 768</option>
                  <option value="mobile">Mobile 390</option>
                </Select>
              </Field>
              <Field label="Priority">
                <Select
                  aria-label="Priority"
                  value={opts.priority ?? 'normal'}
                  onChange={(e) => set({ priority: e.target.value as RunOptionsForm['priority'] })}
                >
                  <option value="high">High — before other waiting runs</option>
                  <option value="normal">Normal</option>
                  <option value="low">Low — after other waiting runs</option>
                </Select>
              </Field>
              <Field label="Workers">
                <Select
                  aria-label="Workers"
                  value={opts.workers}
                  onChange={(e) => set({ workers: Number(e.target.value) })}
                >
                  {[1, 2, 3, 4, 6, 8].map((n) => (
                    <option key={n}>{n}</option>
                  ))}
                </Select>
              </Field>
              <Field label="Retries">
                <Select
                  aria-label="Retries"
                  value={opts.retries}
                  onChange={(e) => set({ retries: Number(e.target.value) })}
                >
                  {[0, 1, 2, 3].map((n) => (
                    <option key={n}>{n}</option>
                  ))}
                </Select>
              </Field>
              <Field label="Video">
                <Select
                  aria-label="Video"
                  value={opts.video}
                  onChange={(e) => set({ video: e.target.value as RunOptionsForm['video'] })}
                >
                  <option value="off">Off</option>
                  <option value="onFailure">On failure</option>
                  <option value="always">Always</option>
                </Select>
              </Field>
              <Field label="Trace">
                <Select
                  aria-label="Trace"
                  value={opts.trace}
                  onChange={(e) => set({ trace: e.target.value as RunOptionsForm['trace'] })}
                >
                  <option value="off">Off</option>
                  <option value="onFailure">On failure</option>
                  <option value="always">Always</option>
                </Select>
              </Field>
            </div>
            <div className="flex flex-wrap gap-5 text-sm">
              <label className="flex items-center gap-2">
                <Switch checked={opts.headed} onChange={(headed) => set({ headed })} label="Show browser" />{' '}
                Show browser (headed)
              </label>
              <label className="flex items-center gap-2">
                <Switch
                  checked={opts.stopOnFirstFailure}
                  onChange={(stopOnFirstFailure) => set({ stopOnFirstFailure })}
                  label="Stop on first failure"
                />{' '}
                Stop on first failure
              </label>
              <label className="flex items-center gap-2">
                <Switch
                  checked={!!opts.pageMetrics}
                  onChange={(pageMetrics) => set({ pageMetrics })}
                  label="Collect page metrics"
                />
                Collect page metrics (Web Vitals)
              </label>
              <label className="flex items-center gap-2">
                <Switch
                  checked={opts.screenshots === 'everyStep'}
                  onChange={(on) => set({ screenshots: on ? 'everyStep' : 'onFailure' })}
                  label="Screenshot every step"
                />
                Screenshot every step
              </label>
            </div>
          </>
        )}
        {start.error && <p className="text-sm text-fail">{start.error.message}</p>}
      </div>
    </Dialog>
  );
}
