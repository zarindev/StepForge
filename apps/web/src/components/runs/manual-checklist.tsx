import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Ban, Check, ImagePlus, Minus, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Textarea } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorState } from '@/components/ui/states';
import { toast, toastError } from '@/components/ui/toast';
import { api, artifactUrl } from '@/lib/api';
import { qk } from '@/lib/queries';
import { cn } from '@/lib/utils';

type Status = 'passed' | 'failed' | 'blocked' | 'skipped';
type Line = { number: string; text: string; depth: number; group: boolean };
type Result = { number: string; status: Status | 'pending'; note: string; screenshot?: string };
type Checklist = { lines: Line[]; results: Result[]; item: { status: string } };

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

/**
 * A manual run's checklist for one test: each step in plain English, marked passed / failed / blocked / skipped,
 * with a note and a screenshot. "Finish test" records the result (steps left open count as skipped).
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
  const [loaded, setLoaded] = useState(false);
  const fileFor = useRef<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (q.data && !loaded) {
      setResults(Object.fromEntries(q.data.results.map((r) => [r.number, r])));
      setLoaded(true);
    }
  }, [q.data, loaded]);

  const set = (number: string, patch: Partial<Result>) =>
    setResults((all) => ({
      ...all,
      [number]: { number, status: 'pending', note: '', ...all[number], ...patch } as Result,
    }));

  const save = useMutation({
    mutationFn: (done: boolean) =>
      api<Checklist>(`/api/run-items/${itemId}/manual`, {
        method: 'PUT',
        json: { results: Object.values(results), done },
      }),
    onSuccess: (_d, done) => {
      qc.invalidateQueries({ queryKey: qk.run(runId) });
      qc.invalidateQueries({ queryKey: qk.runItem(itemId) });
      qc.invalidateQueries({ queryKey: ['runs'] });
      toast(done ? 'Test finished' : 'Progress saved');
      if (done) onDone();
    },
    onError: toastError,
  });
  const attach = useMutation({
    mutationFn: async ({ number, file }: { number: string; file: File }) => {
      const dataUrl = await readFile(file);
      return {
        number,
        ...(await api<{ path: string }>(`/api/run-items/${itemId}/manual/attachments`, {
          method: 'POST',
          json: { number, dataUrl },
        })),
      };
    },
    onSuccess: ({ number, path }) => set(number, { screenshot: path }),
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
        <Button variant="outline" size="sm" disabled={save.isPending} onClick={() => save.mutate(false)}>
          Save progress
        </Button>
        <Button size="sm" disabled={save.isPending} onClick={() => save.mutate(true)}>
          Finish test
        </Button>
      </div>
      <input
        ref={fileInput}
        type="file"
        accept="image/png,image/jpeg"
        className="hidden"
        aria-label="Screenshot file"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file && fileFor.current) attach.mutate({ number: fileFor.current, file });
          e.target.value = '';
        }}
      />
      <ol className="space-y-1.5" aria-label="Steps to check">
        {q.data.lines.map((l) => {
          const r = results[l.number];
          const needsNote = r?.status === 'failed' || r?.status === 'blocked';
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
                {!l.group && (
                  <span className="flex gap-1">
                    {CHOICES.map((c) => (
                      <button
                        key={c.status}
                        type="button"
                        aria-label={`Step ${l.number}: ${c.label}`}
                        aria-pressed={r?.status === c.status}
                        title={c.label}
                        onClick={() => set(l.number, { status: c.status })}
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
                      title="Attach a screenshot"
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
              {!l.group && (needsNote || r?.note || r?.screenshot) && (
                <div className="mt-2 flex flex-wrap items-start gap-3 pl-14">
                  <Textarea
                    aria-label={`Step ${l.number}: note`}
                    rows={2}
                    className="min-w-60 flex-1 text-xs"
                    placeholder={needsNote ? 'What happened? (shown in the report)' : 'Note'}
                    value={r?.note ?? ''}
                    onChange={(e) => set(l.number, { note: e.target.value })}
                  />
                  {r?.screenshot && (
                    <img
                      src={artifactUrl(r.screenshot)}
                      alt={`Screenshot for step ${l.number}`}
                      className="max-h-24 rounded border border-border"
                    />
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </Card>
  );
}
