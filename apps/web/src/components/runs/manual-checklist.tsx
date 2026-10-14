import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import {
  Ban,
  Bug,
  Check,
  Clapperboard,
  ExternalLink,
  ImagePlus,
  Minus,
  MonitorPlay,
  PenLine,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Select, Textarea } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorState } from '@/components/ui/states';
import { toast, toastError } from '@/components/ui/toast';
import { api, artifactUrl } from '@/lib/api';
import { useLiveEvent } from '@/lib/live';
import { qk } from '@/lib/queries';
import { cn } from '@/lib/utils';
import { Annotator } from './annotator';

type Status = 'passed' | 'failed' | 'blocked' | 'skipped';
type Line = { number: string; text: string; depth: number; group: boolean };
type Clip = { startMs: number; endMs: number; video?: string };
type Result = {
  number: string;
  status: Status | 'pending';
  note: string;
  screenshots: string[];
  clips: Clip[];
  bug?: { id: string; code: string };
};
type Checklist = {
  lines: Line[];
  results: Result[];
  item: { status: string };
  video: string | null;
  browserOpen: boolean;
};

const CHOICES: { status: Status; label: string; icon: typeof Check; on: string }[] = [
  { status: 'passed', label: 'Passed', icon: Check, on: 'bg-pass/20 text-pass border-pass/40' },
  { status: 'failed', label: 'Failed', icon: X, on: 'bg-fail/20 text-fail border-fail/40' },
  {
    status: 'blocked',
    label: 'Blocked',
    icon: Ban,
    on: 'bg-orange-400/20 text-orange-400 border-orange-400/40',
  },
  { status: 'skipped', label: 'Skipped', icon: Minus, on: 'bg-fg/10 text-fg border-border' },
];

const readFile = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error('Could not read the image'));
    r.readAsDataURL(file);
  });
const time = (ms: number) =>
  `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')}`;
const split = (text: string): [string, string] => {
  const i = text.indexOf(' — expect: ');
  return i < 0 ? [text, ''] : [text.slice(0, i), text.slice(i + 11)];
};

/** Files a bug from a failed or blocked step: how it should behave, how it behaves, severity. */
function BugDialog({
  itemId,
  line,
  result,
  onClose,
}: {
  itemId: string;
  line: Line | null;
  result?: Result;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [what, expect] = line ? split(line.text) : ['', ''];
  const [f, setF] = useState({ title: '', expected: '', actual: '', severity: 'major' });
  useEffect(() => {
    if (line)
      setF({
        title: `${what}: ${result?.note?.split('\n')[0] || 'does not work as expected'}`.slice(0, 160),
        expected: expect,
        actual: result?.note ?? '',
        severity: 'major',
      });
  }, [line, what, expect, result]);
  const file = useMutation({
    mutationFn: () =>
      api<{ code: string }>(`/api/run-items/${itemId}/manual/bug`, {
        method: 'POST',
        json: { number: line!.number, ...f },
      }),
    onSuccess: (bug) => {
      toast(`${bug.code} filed`);
      void qc.invalidateQueries({ queryKey: ['manual', itemId] });
      onClose();
    },
    onError: toastError,
  });
  return (
    <Dialog
      open={!!line}
      onClose={onClose}
      title={`Report a bug — step ${line?.number ?? ''}`}
      description="Its screenshots, the steps to reproduce and the environment go with it. It appears on the Bugs page."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={f.title.trim().length < 3 || file.isPending} onClick={() => file.mutate()}>
            <Bug className="h-4 w-4" /> File the bug
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-sm">
        <Field label="Title">
          <Input
            aria-label="Bug title"
            value={f.title}
            onChange={(e) => setF({ ...f, title: e.target.value })}
          />
        </Field>
        <Field label="How it should behave (expected)">
          <Textarea
            aria-label="Expected behaviour"
            rows={2}
            value={f.expected}
            onChange={(e) => setF({ ...f, expected: e.target.value })}
          />
        </Field>
        <Field label="How it behaves (actual)">
          <Textarea
            aria-label="Actual behaviour"
            rows={3}
            value={f.actual}
            onChange={(e) => setF({ ...f, actual: e.target.value })}
          />
        </Field>
        <Field label="Severity">
          <Select
            aria-label="Severity"
            value={f.severity}
            onChange={(e) => setF({ ...f, severity: e.target.value })}
          >
            <option value="critical">Critical</option>
            <option value="major">Major</option>
            <option value="minor">Minor</option>
            <option value="trivial">Trivial</option>
          </Select>
        </Field>
      </div>
    </Dialog>
  );
}

/**
 * A manual run's checklist for one test. The tester works in the browser StepForge opens (with the steps in a panel
 * on top) or right here: each step in plain English, marked passed / failed / blocked / skipped, with notes,
 * screenshots (marked up with boxes, arrows, pen and text), screen-recording clips and bug reports.
 */
export function ManualChecklist({
  runId,
  itemId,
  onDone,
}: {
  runId: string;
  itemId: string;
  onDone: () => void;
}) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['manual', itemId],
    queryFn: () => api<Checklist>(`/api/run-items/${itemId}/manual`),
  });
  const [results, setResults] = useState<Record<string, Result>>({});
  const [synced, setSynced] = useState<Checklist | undefined>(undefined);
  const [annotating, setAnnotating] = useState<{ number: string; path: string } | null>(null);
  const [bugFor, setBugFor] = useState<Line | null>(null);
  const fileFor = useRef<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  // The note being typed (not saved yet) survives updates from the server.
  const [editing, setEditing] = useState<string | null>(null);
  // The server's results win whenever they change (the browser panel saves there).
  if (q.data && q.data !== synced) {
    setSynced(q.data);
    const fresh: Record<string, Result> = Object.fromEntries(q.data.results.map((r) => [r.number, r]));
    const typing = editing ? results[editing] : undefined;
    if (editing && typing) fresh[editing] = { ...(fresh[editing] ?? typing), note: typing.note };
    setResults(fresh);
  }
  const onEvent = useCallback(
    (e: { type: string; itemId?: unknown }) => {
      if ((e.type === 'manual.updated' || e.type === 'manual.browser') && e.itemId === itemId)
        void qc.invalidateQueries({ queryKey: ['manual', itemId] });
    },
    [qc, itemId],
  );
  useLiveEvent(onEvent);

  const blank = (number: string): Result => ({
    number,
    status: 'pending',
    note: '',
    screenshots: [],
    clips: [],
  });
  const set = (number: string, patch: Partial<Result>) =>
    setResults((all) => ({ ...all, [number]: { ...blank(number), ...all[number], ...patch } }));

  const save = useMutation({
    mutationFn: ({ done, list }: { done: boolean; list?: Result[] }) =>
      api<Checklist>(`/api/run-items/${itemId}/manual`, {
        method: 'PUT',
        json: { results: list ?? Object.values(results), done },
      }),
    onSuccess: (_d, { done, list }) => {
      qc.invalidateQueries({ queryKey: qk.run(runId) });
      qc.invalidateQueries({ queryKey: qk.runItem(itemId) });
      qc.invalidateQueries({ queryKey: ['runs'] });
      qc.invalidateQueries({ queryKey: ['manual', itemId] });
      if (!list) toast(done ? 'Test finished' : 'Progress saved');
      if (done) onDone();
    },
    onError: toastError,
  });
  /** Adds (or replaces) a screenshot of a step and saves at once. */
  const keepShot = (number: string, path: string, replace?: string) => {
    const r = { ...blank(number), ...results[number] };
    const screenshots = replace
      ? r.screenshots.map((p) => (p === replace ? path : p))
      : [...r.screenshots, path];
    const next = { ...results, [number]: { ...r, screenshots } };
    setResults(next);
    save.mutate({ done: false, list: Object.values(next) });
  };
  const upload = useMutation({
    mutationFn: async ({ number, dataUrl }: { number: string; dataUrl: string; replace?: string }) =>
      api<{ path: string }>(`/api/run-items/${itemId}/manual/attachments`, {
        method: 'POST',
        json: { number, dataUrl },
      }),
    onSuccess: ({ path }, { number, replace }) => {
      keepShot(number, path, replace);
      setAnnotating(null);
      if (replace) toast('Marked-up screenshot saved');
    },
    onError: toastError,
  });
  const browser = useMutation({
    mutationFn: (open: boolean) =>
      open
        ? api(`/api/run-items/${itemId}/manual/browser`, { method: 'POST' })
        : api(`/api/run-items/${itemId}/manual/browser`, { method: 'DELETE' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['manual', itemId] }),
    onError: toastError,
  });

  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  if (q.isPending) return <Skeleton className="h-64" />;
  const checkable = q.data.lines.filter((l) => !l.group);
  const checked = checkable.filter((l) => (results[l.number]?.status ?? 'pending') !== 'pending').length;

  return (
    <Card className="space-y-3 p-5" aria-label="Manual checklist">
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold">Do each step and record what happened</h3>
          <p className="text-xs text-muted">
            {checked} of {checkable.length} steps recorded · steps left open count as skipped when you finish
          </p>
        </div>
        {q.data.browserOpen ? (
          <>
            <Badge tone="indigo">
              <MonitorPlay className="mr-1 inline h-3 w-3" /> Browser open · recording
            </Badge>
            <Button
              variant="ghost"
              size="sm"
              disabled={browser.isPending}
              onClick={() => browser.mutate(false)}
            >
              Close browser
            </Button>
          </>
        ) : (
          <Button
            variant="outline"
            size="sm"
            disabled={browser.isPending}
            onClick={() => browser.mutate(true)}
          >
            <MonitorPlay className="h-3.5 w-3.5" /> Open browser
          </Button>
        )}
        <Button
          variant="outline"
          size="sm"
          disabled={save.isPending}
          onClick={() => save.mutate({ done: false })}
        >
          Save progress
        </Button>
        <Button size="sm" disabled={save.isPending} onClick={() => save.mutate({ done: true })}>
          Finish test
        </Button>
      </div>
      {q.data.browserOpen && (
        <p className="rounded-lg border border-indigo/30 bg-indigo/5 px-3 py-2 text-xs">
          The browser shows the steps in a StepForge panel: mark them there (or here), take screenshots and
          record clips. The whole session is recorded; it is kept when the browser closes.
        </p>
      )}
      <input
        ref={fileInput}
        type="file"
        accept="image/png,image/jpeg"
        className="hidden"
        aria-label="Screenshot file"
        onChange={async (e) => {
          const file = e.target.files?.[0];
          if (file && fileFor.current)
            upload.mutate({ number: fileFor.current, dataUrl: await readFile(file) });
          e.target.value = '';
        }}
      />
      <ol className="space-y-1.5" aria-label="Steps to check">
        {q.data.lines.map((l) => {
          const r = results[l.number];
          const bad = r?.status === 'failed' || r?.status === 'blocked';
          const shots = r?.screenshots ?? [];
          const clips = r?.clips ?? [];
          return (
            <li
              key={l.number}
              style={{ paddingLeft: l.depth * 22 }}
              className={cn(!l.group && 'rounded-lg border border-border bg-surface px-3 py-2')}
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="w-12 shrink-0 text-right font-mono text-xs text-muted">{l.number}</span>
                <span className={cn('min-w-0 flex-1 text-sm', l.group && 'font-medium text-muted')}>
                  {l.text}
                </span>
                {r?.bug && (
                  <Link to="/bugs" search={{ bug: r.bug.id }} className="text-xs text-fail hover:underline">
                    {r.bug.code}
                  </Link>
                )}
                {!l.group && (
                  <span className="flex gap-1">
                    {CHOICES.map((c) => (
                      <button
                        key={c.status}
                        type="button"
                        aria-label={`Step ${l.number}: ${c.label}`}
                        aria-pressed={r?.status === c.status}
                        title={c.label}
                        onClick={() => {
                          // Saved at once, so the browser panel and the dashboard stay the same.
                          const next = {
                            ...results,
                            [l.number]: { ...blank(l.number), ...results[l.number], status: c.status },
                          };
                          setResults(next);
                          save.mutate({ done: false, list: Object.values(next) });
                        }}
                        className={cn(
                          'inline-flex h-7 items-center gap-1 rounded-md border px-2 text-xs',
                          r?.status === c.status ? c.on : 'border-transparent text-muted hover:bg-fg/5',
                        )}
                      >
                        <c.icon className="h-3.5 w-3.5" />
                        <span className="hidden xl:inline">{c.label}</span>
                      </button>
                    ))}
                    <button
                      type="button"
                      aria-label={`Step ${l.number}: attach a screenshot`}
                      title="Attach a screenshot from this computer"
                      onClick={() => {
                        fileFor.current = l.number;
                        fileInput.current?.click();
                      }}
                      className="inline-flex h-7 items-center rounded-md px-2 text-muted hover:bg-fg/5"
                    >
                      <ImagePlus className="h-3.5 w-3.5" />
                    </button>
                  </span>
                )}
              </div>
              {!l.group && (bad || r?.note || shots.length > 0 || clips.length > 0) && (
                <div className="mt-2 space-y-2 pl-14">
                  <Textarea
                    aria-label={`Step ${l.number}: note`}
                    rows={2}
                    className="text-xs"
                    placeholder={bad ? 'What happened? (shown in the report)' : 'Note'}
                    value={r?.note ?? ''}
                    onChange={(e) => set(l.number, { note: e.target.value })}
                    onFocus={() => setEditing(l.number)}
                    onBlur={() => {
                      setEditing(null);
                      save.mutate({ done: false, list: Object.values(results) });
                    }}
                  />
                  {shots.length > 0 && (
                    <div className="flex flex-wrap gap-2">
                      {shots.map((p, i) => (
                        <figure key={p} className="group relative">
                          <img
                            src={artifactUrl(p)}
                            alt={`Screenshot ${i + 1} for step ${l.number}`}
                            className="max-h-28 cursor-pointer rounded border border-border"
                            onClick={() => setAnnotating({ number: l.number, path: p })}
                          />
                          <Button
                            size="sm"
                            variant="secondary"
                            className="absolute bottom-1 right-1"
                            aria-label={`Mark up screenshot ${i + 1} of step ${l.number}`}
                            onClick={() => setAnnotating({ number: l.number, path: p })}
                          >
                            <PenLine className="h-3 w-3" /> Mark up
                          </Button>
                        </figure>
                      ))}
                    </div>
                  )}
                  {clips.length > 0 && (
                    <div className="flex flex-wrap gap-2 text-xs">
                      {clips.map((c, i) =>
                        c.video && !q.data.browserOpen ? (
                          <a
                            key={i}
                            href={`${artifactUrl(c.video)}#t=${c.startMs / 1000},${c.endMs / 1000}`}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 hover:bg-fg/5"
                          >
                            <Clapperboard className="h-3 w-3" /> Clip {i + 1} · {time(c.startMs)}–
                            {time(c.endMs)}
                            <ExternalLink className="h-3 w-3 text-muted" />
                          </a>
                        ) : (
                          <span
                            key={i}
                            className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-muted"
                          >
                            <Clapperboard className="h-3 w-3" /> Clip {i + 1} · {time(c.startMs)}–
                            {time(c.endMs)} (playable when the browser closes)
                          </span>
                        ),
                      )}
                    </div>
                  )}
                  {bad && !r?.bug && (
                    <Button size="sm" variant="danger" onClick={() => setBugFor(l)}>
                      <Bug className="h-3.5 w-3.5" /> Report a bug
                    </Button>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ol>
      <Annotator
        src={annotating ? artifactUrl(annotating.path) : null}
        saving={upload.isPending}
        onClose={() => setAnnotating(null)}
        onSave={(dataUrl) =>
          annotating && upload.mutate({ number: annotating.number, dataUrl, replace: annotating.path })
        }
      />
      <BugDialog
        itemId={itemId}
        line={bugFor}
        result={bugFor ? results[bugFor.number] : undefined}
        onClose={() => setBugFor(null)}
      />
    </Card>
  );
}
