import { useNavigate, useRouterState } from '@tanstack/react-router';
import { Compass, X } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useSyncExternalStore } from 'react';
import { Button } from '@/components/ui/button';
import { getCurrentAppId } from '@/lib/current-app';

/**
 * The guided recorder tour (first-run onboarding): a small coach card that walks through the first recorded test and
 * outlines the control it talks about. Started after "Create your first application"; can be skipped at any time.
 */
type Step = { route: string | (() => string); target?: string; title: string; text: string };

const STEPS: Step[] = [
  {
    route: () => `/applications/${getCurrentAppId() ?? ''}`,
    target: '[data-tour="environments"]',
    title: '1 · Point it at your app',
    text: 'Add an environment with the base URL your tests run against (for example http://localhost:3000). Secrets for this environment go in the Secrets tab and are stored encrypted.',
  },
  {
    route: '/recorder',
    target: '[data-tour="recorder-start"]',
    title: '2 · Choose where to start',
    text: 'Pick the environment and the page the recording starts on.',
  },
  {
    route: '/recorder',
    target: '[data-tour="recorder-button"]',
    title: '3 · Record',
    text: 'A real browser opens with the StepForge toolbar. Click and type through your app: every action becomes a step with ranked locators. Use the toolbar to add checks, extract values and mask secrets; API calls are captured too.',
  },
  {
    route: '/recorder',
    target: '[data-tour="recorder-tips"]',
    title: '4 · Save and run',
    text: 'Stop the recording, review the steps and save them as a scenario. Then run it from the Test Explorer (or the Run button at the top) and watch the result live, with screenshots, video and a diagnosis if it fails.',
  },
];

const KEY = 'stepforge.tour';
const listeners = new Set<() => void>();
/** "pending" until the first application exists; then the step number. */
function raw(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}
function read(): number | null {
  const v = raw();
  return v === null || v === 'pending' ? null : Number(v);
}
function write(step: number | 'pending' | null) {
  try {
    if (step === null) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, String(step));
  } catch {
    // storage unavailable: the tour just does not persist
  }
  listeners.forEach((l) => l());
}

/** "Create your first application": the tour starts once the application is created. */
export const startRecorderTour = () => write('pending');
export const continueTourAfterCreate = () => {
  if (raw() === 'pending') write(0);
};

export function RecorderTour() {
  const step = useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    read,
    () => null,
  );
  const navigate = useNavigate();
  const path = useRouterState({ select: (s) => s.location.pathname });
  const current = step !== null ? STEPS[step] : undefined;
  const route = current ? (typeof current.route === 'function' ? current.route() : current.route) : '';

  useEffect(() => {
    if (current && path !== route) void navigate({ to: route });
  }, [current, route, path, navigate]);

  // Outline the control the step talks about.
  useEffect(() => {
    if (!current?.target) return;
    let el: Element | null = null;
    const t = setInterval(() => {
      const found = document.querySelector(current.target!);
      if (found && found !== el) {
        el?.classList.remove('tour-target');
        el = found;
        el.classList.add('tour-target');
        el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }
    }, 200);
    return () => {
      clearInterval(t);
      el?.classList.remove('tour-target');
    };
  }, [current, path]);

  return (
    <AnimatePresence>
      {current && step !== null && (
        <motion.aside
          key="tour"
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 12 }}
          role="dialog"
          aria-label="Recorder tour"
          className="fixed right-6 bottom-6 z-40 w-[360px] rounded-xl border border-brand/40 bg-surface p-4 shadow-2xl"
        >
          <div className="mb-2 flex items-center gap-2 text-xs font-medium text-brand">
            <Compass className="h-4 w-4" /> Your first recorded test · {step + 1} of {STEPS.length}
            <button
              className="ml-auto text-muted hover:text-fg"
              aria-label="Close the tour"
              onClick={() => write(null)}
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <h3 className="text-sm font-semibold">{current.title}</h3>
          <p className="mt-1 text-sm text-muted">{current.text}</p>
          <div className="mt-4 flex items-center gap-2">
            <Button size="sm" variant="ghost" onClick={() => write(null)}>
              Skip tour
            </Button>
            <div className="ml-auto flex gap-2">
              {step > 0 && (
                <Button size="sm" variant="outline" onClick={() => write(step - 1)}>
                  Back
                </Button>
              )}
              <Button size="sm" onClick={() => write(step + 1 < STEPS.length ? step + 1 : null)}>
                {step + 1 < STEPS.length ? 'Next' : 'Done'}
              </Button>
            </div>
          </div>
        </motion.aside>
      )}
    </AnimatePresence>
  );
}
