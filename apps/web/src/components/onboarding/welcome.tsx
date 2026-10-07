import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { AppWindow, CheckCircle2, Loader2, Play, Rocket, Sparkles } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { toastError } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { setCurrentAppId } from '@/lib/current-app';
import { qk } from '@/lib/queries';
import { startRecorderTour } from './tour';

type DemoStatus = {
  available: boolean;
  loaded: boolean;
  applicationId: string | null;
  clinic: { running: boolean; url: string | null };
};
type Loaded = {
  applicationId: string;
  clinicUrl: string;
  applications: { key: string; name: string; applicationId: string; url: string }[];
  mailpit: boolean;
  created: boolean;
  warnings: string[];
};

const LOADED_KEY = 'stepforge.demoLoaded';
/** The "demo is ready" panel stays on Home (this browser session) until the first results arrive. */
export function readLoaded(): Loaded | null {
  try {
    return JSON.parse(sessionStorage.getItem(LOADED_KEY) ?? 'null') as Loaded | null;
  } catch {
    return null;
  }
}
function saveLoaded(r: Loaded) {
  try {
    sessionStorage.setItem(LOADED_KEY, JSON.stringify(r));
  } catch {
    // storage unavailable: the panel shows until the page reloads
  }
}

/** First-run onboarding: load the demo workspace, or create your own application and take the recorder tour. */
export function Welcome() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const demo = useQuery({ queryKey: ['demo'], queryFn: () => api<DemoStatus>('/api/demo') });
  const [result, setResult] = useState<Loaded | null>(readLoaded);
  const load = useMutation({
    mutationFn: () => api<Loaded>('/api/demo/load', { method: 'POST' }),
    onSuccess: (r) => {
      setResult(r);
      saveLoaded(r);
      setCurrentAppId(r.applicationId);
      void qc.invalidateQueries();
    },
    onError: toastError,
  });
  // One run per demo app; the first opens (the other is on the Runs page).
  const run = useMutation({
    mutationFn: async () => {
      const ids: string[] = [];
      for (const a of result!.applications ?? [{ applicationId: result!.applicationId }]) {
        const envs = await api<{ id: string }[]>(`/api/applications/${a.applicationId}/environments`);
        const r = await api<{ id: string }>('/api/runs', {
          method: 'POST',
          json: {
            applicationId: a.applicationId,
            environmentId: envs[0]!.id,
            scope: { type: 'application' },
          },
        });
        ids.push(r.id);
      }
      return ids;
    },
    onSuccess: (ids) => void navigate({ to: '/runs/$runId', params: { runId: ids[0]! }, search: {} }),
    onError: toastError,
  });

  return (
    <div className="mt-6" data-testid="welcome">
      <div className="mb-5 text-center">
        <div className="mx-auto mb-3 grid h-12 w-12 place-items-center rounded-xl bg-brand/10 text-brand">
          <Sparkles className="h-6 w-6" />
        </div>
        <h2 className="text-lg font-semibold">Welcome to StepForge</h2>
        <p className="mx-auto mt-1 max-w-xl text-sm text-muted">
          A local QA studio for UI, API, database, email and performance tests. Everything stays on this
          computer. How would you like to start?
        </p>
      </div>
      <div className="mx-auto grid max-w-4xl gap-4 md:grid-cols-2">
        <Card className="flex flex-col p-5">
          <div className="mb-2 flex items-center gap-2 font-semibold">
            <Rocket className="h-4 w-4 text-brand" /> Load the demo workspace
          </div>
          {result ? (
            <div className="flex flex-1 flex-col text-sm" data-testid="demo-loaded">
              {(result.applications ?? [{ key: 'clinic', name: 'CareClinic', url: result.clinicUrl }]).map(
                (a) => (
                  <p key={a.key} className="flex items-center gap-2 text-pass">
                    <CheckCircle2 className="h-4 w-4" /> {a.name} is ready at{' '}
                    <a className="font-mono underline" href={a.url} target="_blank" rel="noreferrer">
                      {a.url}
                    </a>
                  </p>
                ),
              )}
              <p className="mt-2 text-muted">
                45 scenarios across UI, API, database, email, business rules and performance. Some fail on
                purpose: the demo apps have real defects for StepForge to find and explain.
              </p>
              {result.warnings.map((w) => (
                <p key={w} className="mt-2 text-xs text-warn">
                  {w}
                </p>
              ))}
              <p className="mt-2 text-xs text-muted">
                Demo sign-in: CareClinic reception@careclinic.test / Reception123! · ShopDesk
                cashier@shopdesk.test / Cashier123! (admins: admin@… / Admin123!)
              </p>
              <div className="mt-auto flex flex-wrap gap-2 pt-4">
                <Button disabled={run.isPending} onClick={() => run.mutate()}>
                  <Play className="h-3.5 w-3.5 fill-current" /> Run all tests
                </Button>
                <Link to="/explorer" search={{}}>
                  <Button variant="outline">Explore the tests</Button>
                </Link>
              </div>
            </div>
          ) : (
            <div className="flex flex-1 flex-col text-sm">
              <p className="text-muted">
                Starts two demo apps (CareClinic, a clinic, and ShopDesk, a shop back office) and the local
                email catcher, then adds 45 ready scenarios, database connections and quality gates. About a
                minute to your first results.
              </p>
              <div className="mt-auto pt-4">
                <Button disabled={!demo.data?.available || load.isPending} onClick={() => load.mutate()}>
                  {load.isPending ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" /> Starting the demo apps and importing…
                    </>
                  ) : (
                    'Load demo workspace'
                  )}
                </Button>
              </div>
            </div>
          )}
        </Card>
        <Card className="flex flex-col p-5">
          <div className="mb-2 flex items-center gap-2 font-semibold">
            <AppWindow className="h-4 w-4 text-indigo" /> Create your first application
          </div>
          <p className="text-sm text-muted">
            Add the app you want to test, point an environment at it and record your first scenario. A short
            tour shows the way.
          </p>
          <div className="mt-auto pt-4">
            <Button
              variant="outline"
              onClick={() => {
                startRecorderTour();
                void qc.invalidateQueries({ queryKey: qk.applications });
                void navigate({ to: '/applications', search: { new: true } });
              }}
            >
              Create an application
            </Button>
          </div>
        </Card>
      </div>
    </div>
  );
}
