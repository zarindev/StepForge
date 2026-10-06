import { Outlet, useNavigate } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { Toaster } from '@/components/ui/toast';
import { NAV } from '@/lib/nav';
import { useLiveInvalidation } from '@/lib/queries';
import { CommandPalette } from './command-palette';
import { Rail } from './rail';
import { ShortcutsOverlay } from './shortcuts-overlay';
import { Topbar } from './topbar';

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return !!el && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName));
}

export function Layout() {
  const [palette, setPalette] = useState(false);
  const [shortcuts, setShortcuts] = useState(false);
  const navigate = useNavigate();
  const chord = useRef<number | null>(null);
  useLiveInvalidation();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPalette((p) => !p);
        return;
      }
      if (e.key === 'Escape') {
        setPalette(false);
        setShortcuts(false);
        return;
      }
      if (isTyping(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === '?') {
        setShortcuts((s) => !s);
        return;
      }
      // "G then X" navigation chords
      if (chord.current && Date.now() - chord.current < 1200) {
        chord.current = null;
        const target = NAV.find((n) => n.shortcut === `G ${e.key.toUpperCase()}`);
        if (target) navigate({ to: target.to });
        return;
      }
      if (e.key.toLowerCase() === 'g') chord.current = Date.now();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navigate]);

  return (
    <div className="flex h-full">
      <Rail />
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar onOpenPalette={() => setPalette(true)} />
        <main className="flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-[1400px] px-6 py-6 lg:px-8">
            <Outlet />
          </div>
        </main>
      </div>
      <CommandPalette open={palette} onClose={() => setPalette(false)} />
      <ShortcutsOverlay open={shortcuts} onClose={() => setShortcuts(false)} />
      <Toaster />
    </div>
  );
}

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: React.ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {description && <p className="mt-1 text-sm text-muted">{description}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}
