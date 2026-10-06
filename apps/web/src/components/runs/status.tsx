import {
  Ban,
  CheckCircle2,
  CircleDashed,
  CircleSlash,
  Loader2,
  PauseCircle,
  Repeat,
  XCircle,
  Zap,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

const STATUS: Record<string, { icon: LucideIcon; color: string; label: string; spin?: boolean }> = {
  queued: { icon: CircleDashed, color: 'text-muted', label: 'Queued' },
  running: { icon: Loader2, color: 'text-sky-400', label: 'Running', spin: true },
  passed: { icon: CheckCircle2, color: 'text-pass', label: 'Passed' },
  failed: { icon: XCircle, color: 'text-fail', label: 'Failed' },
  broken: { icon: Zap, color: 'text-warn', label: 'Broken' },
  skipped: { icon: CircleSlash, color: 'text-skip', label: 'Skipped' },
  flaky: { icon: Repeat, color: 'text-warn', label: 'Flaky' },
  cancelled: { icon: Ban, color: 'text-skip', label: 'Cancelled' },
  interrupted: { icon: PauseCircle, color: 'text-warn', label: 'Interrupted' },
};

export function StatusIcon({ status, className }: { status: string; className?: string }) {
  const s = STATUS[status] ?? STATUS.queued!;
  return (
    <s.icon
      className={cn('h-4 w-4 shrink-0', s.color, s.spin && 'animate-spin', className)}
      aria-label={s.label}
    />
  );
}

export function StatusPill({ status }: { status: string }) {
  const s = STATUS[status] ?? STATUS.queued!;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border border-current/25 px-2 py-0.5 text-xs font-medium',
        s.color,
      )}
    >
      <s.icon className={cn('h-3.5 w-3.5', s.spin && 'animate-spin')} /> {s.label}
    </span>
  );
}

/** Stacked bar of passed / flaky / failed / broken / skipped. */
export function TotalsBar({
  totals,
  className,
}: {
  totals: { total: number; passed: number; failed: number; broken: number; skipped: number; flaky: number };
  className?: string;
}) {
  const parts = [
    ['bg-pass', totals.passed],
    ['bg-warn', totals.flaky],
    ['bg-fail', totals.failed],
    ['bg-orange-400', totals.broken],
    ['bg-skip', totals.skipped],
  ] as const;
  const total = Math.max(totals.total, 1);
  const done = parts.reduce((n, [, v]) => n + v, 0);
  return (
    <div
      className={cn('flex h-1.5 w-full overflow-hidden rounded-full bg-fg/[0.07]', className)}
      role="img"
      aria-label={`${done} of ${totals.total} finished`}
    >
      {parts.map(([c, v]) =>
        v > 0 ? <div key={c} className={c} style={{ width: `${(v / total) * 100}%` }} /> : null,
      )}
    </div>
  );
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—';
  if (ms < 1000) return `${ms} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)} s`;
  return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}

export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return '—';
  const diff = (Date.now() - Date.parse(iso)) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} h ago`;
  return new Date(iso).toLocaleDateString();
}
