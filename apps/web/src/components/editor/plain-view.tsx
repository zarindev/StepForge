import { describeSteps } from '@stepforge/core';
import { Copy } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import type { StepRecord } from '@/lib/types';

/** The scenario as readable, numbered sentences (also used for docs and bug reports). */
export function PlainView({ steps, title }: { steps: StepRecord[]; title?: string }) {
  const lines = describeSteps(steps);
  const text = [title, ...lines.map((l) => `${'  '.repeat(l.depth)}${l.number}. ${l.text}`)]
    .filter(Boolean)
    .join('\n');
  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            void navigator.clipboard.writeText(text).then(() => toast('Copied as text'));
          }}
        >
          <Copy className="h-3.5 w-3.5" /> Copy as text
        </Button>
      </div>
      {lines.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted">No enabled steps.</p>
      ) : (
        <ol
          className="space-y-1.5 rounded-lg border border-border bg-surface p-4 text-sm"
          aria-label="Plain English steps"
        >
          {lines.map((l) => (
            <li key={l.number} className="flex gap-3" style={{ paddingLeft: l.depth * 20 }}>
              <span className="w-10 shrink-0 text-right font-mono text-xs leading-5 text-muted">
                {l.number}.
              </span>
              <span>{l.text}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
