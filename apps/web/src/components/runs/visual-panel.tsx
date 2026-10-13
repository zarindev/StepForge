import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { toast, toastError } from '@/components/ui/toast';
import { api, artifactUrl } from '@/lib/api';

export type StepVisual = {
  key: string;
  baseline: string;
  actual: string;
  diff?: string;
  diffPercent?: number;
  maxDiffPercent: number;
  status: 'new' | 'match' | 'changed' | 'sizeChanged';
  accepted?: boolean;
};

/** A visual checkpoint: approved baseline, this run's screenshot and the difference — and accepting a change. */
export function VisualPanel({
  stepResultId,
  visual,
  onShot,
}: {
  stepResultId?: string;
  visual: StepVisual;
  onShot: (url: string) => void;
}) {
  const [accepted, setAccepted] = useState(!!visual.accepted);
  const accept = useMutation({
    mutationFn: () => api(`/api/step-results/${stepResultId}/accept-baseline`, { method: 'POST' }),
    onSuccess: () => {
      setAccepted(true);
      toast('This screenshot is now the approved baseline');
    },
    onError: toastError,
  });
  const changed = visual.status === 'changed' || visual.status === 'sizeChanged';
  const images = [
    // Shown as the baseline before this run: when the run created it, it is the same image as the screenshot.
    ...(visual.status === 'new' ? [] : [{ label: 'Approved baseline', path: visual.baseline }]),
    {
      label: visual.status === 'new' ? 'Screenshot (saved as the baseline)' : 'This run',
      path: visual.actual,
    },
    ...(visual.diff ? [{ label: 'Difference (red)', path: visual.diff }] : []),
  ];
  return (
    <div className="space-y-2" data-testid="visual-panel">
      <div className="grid gap-2 md:grid-cols-3">
        {images.map((img) => (
          <figure key={img.label} className="space-y-1">
            <figcaption className="text-[11px] text-muted">{img.label}</figcaption>
            <img
              src={artifactUrl(img.path)}
              alt={img.label}
              className="max-h-56 cursor-zoom-in rounded border border-border bg-bg"
              onClick={() => onShot(artifactUrl(img.path))}
            />
          </figure>
        ))}
      </div>
      {changed && stepResultId && (
        <div className="flex items-center gap-2">
          {accepted ? (
            <p className="text-xs text-pass">Accepted: the next run compares with this screenshot.</p>
          ) : (
            <>
              <Button
                size="sm"
                variant="secondary"
                disabled={accept.isPending}
                onClick={() => accept.mutate()}
              >
                Accept as new baseline
              </Button>
              <span className="text-xs text-muted">If the page changed on purpose</span>
            </>
          )}
        </div>
      )}
    </div>
  );
}
