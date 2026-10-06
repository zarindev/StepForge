import { useNavigate } from '@tanstack/react-router';
import { Check, ChevronsUpDown, Plus, ShieldAlert } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { setCurrentAppId } from '@/lib/current-app';
import { useCurrentApp } from '@/lib/queries';
import { cn } from '@/lib/utils';

export function AppSwitcher() {
  const { app, apps } = useCurrentApp();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        aria-label="Switch application"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex h-9 min-w-48 items-center gap-2 rounded-lg border border-border bg-surface px-3 text-sm transition-colors hover:border-fg/15"
      >
        <span className="h-2.5 w-2.5 rounded-full" style={{ background: app?.color ?? '#64748B' }} />
        <span className={cn('max-w-40 truncate', !app && 'text-muted')}>{app?.name ?? 'No application'}</span>
        {app?.hasProduction && (
          <ShieldAlert className="h-3.5 w-3.5 text-fail" aria-label="Has production environment" />
        )}
        <ChevronsUpDown className="ml-auto h-3.5 w-3.5 text-muted" />
      </button>
      {open && (
        <div
          role="listbox"
          className="absolute left-0 z-40 mt-1 w-72 rounded-lg border border-border bg-elevated p-1 shadow-xl"
        >
          {apps.data?.map((a) => (
            <button
              key={a.id}
              role="option"
              aria-selected={a.id === app?.id}
              onClick={() => {
                setCurrentAppId(a.id);
                setOpen(false);
              }}
              className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm hover:bg-fg/5"
            >
              <span className="h-2.5 w-2.5 rounded-full" style={{ background: a.color }} />
              <span className="flex-1 truncate">{a.name}</span>
              <span className="text-xs text-muted">{a.counts.scenarios} scenarios</span>
              {a.id === app?.id && <Check className="h-3.5 w-3.5 text-brand" />}
            </button>
          ))}
          {apps.data?.length === 0 && <p className="px-2.5 py-2 text-sm text-muted">No applications yet</p>}
          <div className="my-1 border-t border-border" />
          <button
            onClick={() => {
              setOpen(false);
              navigate({ to: '/applications' });
            }}
            className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm text-muted hover:bg-fg/5 hover:text-fg"
          >
            <Plus className="h-3.5 w-3.5" /> Manage applications
          </button>
        </div>
      )}
    </div>
  );
}
