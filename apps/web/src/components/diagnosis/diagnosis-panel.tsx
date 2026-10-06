import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Bug, CheckCircle2, History, MapPin, RefreshCw, Sparkles, UserRound, Wrench } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { toast, toastError } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { qk } from '@/lib/queries';
import type { Diagnosis, Owner, RunItemDetail } from '@/lib/types';

export const OWNER_LABEL: Record<Owner, string> = {
  app: 'Application bug',
  test: 'Test needs updating',
  environment: 'Environment problem',
  data: 'Test data problem',
};
export const OWNER_TONE: Record<Owner, 'fail' | 'warn' | 'indigo' | 'skip'> = {
  app: 'fail',
  test: 'indigo',
  environment: 'warn',
  data: 'skip',
};

const describe = (l: { strategy: string; value: string; name?: string }) =>
  l.strategy === 'role' ? `role=${l.value}${l.name ? ` "${l.name}"` : ''}` : `${l.strategy}=${l.value}`;

/** Where / Why / Whose / How to fix for a failed test, with evidence and the comparison with the last pass. */
export function DiagnosisPanel({ item }: { item: RunItemDetail }) {
  const d = item.diagnosisJson as Diagnosis;
  const qc = useQueryClient();
  const ai = useQuery({
    queryKey: ['ai-status'],
    queryFn: () => api<{ available: boolean }>('/api/ai/status'),
    staleTime: 60_000,
  });
  const explain = useMutation({
    mutationFn: () => api<{ text: string }>(`/api/run-items/${item.id}/explain`, { method: 'POST' }),
    onError: toastError,
  });
  const rediagnose = useMutation({
    mutationFn: () => api(`/api/run-items/${item.id}/diagnose`, { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.runItem(item.id) }),
    onError: toastError,
  });
  const failedStep =
    item.steps.find((s) => s.stepId === item.failedStepId) ?? item.steps.find((s) => s.status === 'failed');
  const accept = useMutation({
    mutationFn: () =>
      api(`/api/run-items/${item.id}/accept-locator`, {
        method: 'POST',
        json: { stepId: failedStep?.stepId, locator: d.suggestedLocator },
      }),
    onSuccess: () => toast(`Step updated to use ${describe(d.suggestedLocator!)} — run it again to confirm`),
    onError: toastError,
  });

  return (
    <section
      aria-label="Diagnosis"
      className="mb-4 space-y-3 rounded-lg border border-brand/30 bg-brand/[0.04] p-4"
      data-testid="diagnosis"
    >
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={OWNER_TONE[d.owner]}>{OWNER_LABEL[d.owner]}</Badge>
        <Badge>{d.category.replace(/_/g, ' ')}</Badge>
        <span className="text-xs text-muted">confidence {Math.round(d.confidence * 100)}%</span>
        <span className="ml-auto flex items-center gap-1">
          {item.bug && (
            <Link
              to="/bugs"
              search={{ bug: item.bug.id }}
              className="inline-flex items-center gap-1 text-xs text-brand hover:underline"
            >
              <Bug className="h-3.5 w-3.5" /> {item.bug.code}
              {item.bug.occurrences > 1 && ` · seen ${item.bug.occurrences}×`}
            </Link>
          )}
          <Button
            variant="ghost"
            size="sm"
            disabled={rediagnose.isPending}
            onClick={() => rediagnose.mutate()}
            title="Diagnose again with the current rules"
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </Button>
        </span>
      </div>
      <dl className="grid gap-x-4 gap-y-2 text-sm sm:grid-cols-[150px_1fr]">
        <dt className="flex items-center gap-1.5 text-muted">
          <MapPin className="h-3.5 w-3.5" /> Where
        </dt>
        <dd>
          {d.where.path ? `Step ${d.where.path} — ` : ''}
          {d.where.step}
        </dd>
        <dt className="flex items-center gap-1.5 text-muted">
          <Sparkles className="h-3.5 w-3.5" /> Why (likely)
        </dt>
        <dd>
          <p className="font-medium">{d.title}</p>
          <p className="text-muted">{d.explanation}</p>
        </dd>
        <dt className="flex items-center gap-1.5 text-muted">
          <UserRound className="h-3.5 w-3.5" /> Whose issue
        </dt>
        <dd>{OWNER_LABEL[d.owner]}</dd>
        <dt className="flex items-center gap-1.5 text-muted">
          <Wrench className="h-3.5 w-3.5" /> How to fix
        </dt>
        <dd>
          {d.fix}
          {d.suggestedLocator && failedStep?.stepId && (
            <div className="mt-2">
              <Button
                size="sm"
                disabled={accept.isPending || accept.isSuccess}
                onClick={() => accept.mutate()}
              >
                <CheckCircle2 className="h-3.5 w-3.5" />
                {accept.isSuccess ? 'Locator updated' : `Use ${describe(d.suggestedLocator)}`}
              </Button>
            </div>
          )}
        </dd>
      </dl>
      {d.evidence.length > 0 && (
        <table className="w-full text-xs" aria-label="Diagnosis evidence">
          <tbody>
            {d.evidence.map((e) => (
              <tr key={e.label} className="border-t border-border/60">
                <th className="w-40 py-1 pr-3 text-left font-normal text-muted">{e.label}</th>
                <td className="py-1 font-mono break-all">{e.value}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {d.lastGreen && (
        <div className="text-xs">
          <p className="flex items-center gap-1.5 text-muted">
            <History className="h-3.5 w-3.5" /> Last passed {new Date(d.lastGreen.at).toLocaleString()}
            {d.lastGreen.changes.length === 0 && ' — no differences found in the stored results'}
          </p>
          {d.lastGreen.changes.length > 0 && (
            <ul className="mt-1 ml-5 list-disc">
              {d.lastGreen.changes.map((c) => (
                <li key={c.what}>
                  {c.what}: <span className="font-mono">{c.before}</span> →{' '}
                  <span className="font-mono">{c.after}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {d.alternatives.length > 0 && (
        <p className="text-xs text-muted">
          Also possible:{' '}
          {d.alternatives.map((a) => `${a.title} (${Math.round(a.confidence * 100)}%)`).join(' · ')}
        </p>
      )}
      {ai.data?.available && (
        <div className="text-sm">
          {explain.data ? (
            <p className="rounded-lg bg-fg/[0.04] p-3">{explain.data.text}</p>
          ) : (
            <Button variant="outline" size="sm" disabled={explain.isPending} onClick={() => explain.mutate()}>
              <Sparkles className="h-3.5 w-3.5" />{' '}
              {explain.isPending ? 'Asking the local model…' : 'Explain in plain English'}
            </Button>
          )}
        </div>
      )}
    </section>
  );
}
