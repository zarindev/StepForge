import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

type Tone = 'neutral' | 'brand' | 'indigo' | 'pass' | 'fail' | 'warn' | 'skip';
const tones: Record<Tone, string> = {
  neutral: 'bg-fg/[0.06] text-muted',
  brand: 'bg-brand/12 text-brand',
  indigo: 'bg-indigo/12 text-indigo dark:text-indigo-300',
  pass: 'bg-pass/12 text-pass',
  fail: 'bg-fail/12 text-fail',
  warn: 'bg-warn/15 text-yellow-600 dark:text-warn',
  skip: 'bg-skip/15 text-skip',
};

export function Badge({
  tone = 'neutral',
  className,
  ...p
}: HTMLAttributes<HTMLSpanElement> & { tone?: Tone }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium leading-4',
        tones[tone],
        className,
      )}
      {...p}
    />
  );
}

export const PRIORITY_TONE: Record<string, Tone> = { P1: 'fail', P2: 'warn', P3: 'indigo', P4: 'skip' };
export const STATUS_TONE: Record<string, Tone> = {
  draft: 'neutral',
  ready: 'pass',
  deprecated: 'skip',
  active: 'pass',
  skipped: 'skip',
};
