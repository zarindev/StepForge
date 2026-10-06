import { Play, Search } from 'lucide-react';
import { AppSwitcher } from './app-switcher';
import { Button } from '@/components/ui/button';
import { Kbd } from '@/components/ui/kbd';
import { useLiveConnected } from '@/lib/live';
import { cn } from '@/lib/utils';

export function Topbar({ onOpenPalette }: { onOpenPalette: () => void }) {
  const connected = useLiveConnected();
  return (
    <header className="glass sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-border px-5">
      <AppSwitcher />

      <button
        onClick={onOpenPalette}
        className="ml-2 flex h-9 w-full max-w-md items-center gap-2 rounded-lg border border-border bg-surface px-3 text-sm text-muted transition-colors hover:border-fg/15"
      >
        <Search className="h-4 w-4" />
        <span className="flex-1 text-left">Jump to anything…</span>
        <Kbd>Ctrl K</Kbd>
      </button>

      <div className="ml-auto flex items-center gap-3">
        <span
          className="flex items-center gap-1.5 text-xs text-muted"
          title={connected ? 'Live connection to the local server' : 'Reconnecting to the local server…'}
        >
          <span className={cn('h-2 w-2 rounded-full', connected ? 'bg-pass' : 'animate-pulse bg-warn')} />
          {connected ? 'Local' : 'Offline'}
        </span>
        <Button size="sm" disabled title="Runner arrives in Phase 3">
          <Play className="h-3.5 w-3.5 fill-current" /> Run
        </Button>
      </div>
    </header>
  );
}
