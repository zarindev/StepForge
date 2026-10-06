import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { AnimatePresence, motion } from 'motion/react';
import { AppWindow, CornerDownLeft, FileCheck2, Layers, Search } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/api';
import { setCurrentAppId } from '@/lib/current-app';
import { NAV } from '@/lib/nav';
import type { SearchHit } from '@/lib/types';
import { cn } from '@/lib/utils';

type Command = {
  id: string;
  label: string;
  hint: string;
  icon: (typeof NAV)[number]['icon'];
  run: () => void;
  section: string;
};

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

const HIT_ICON = { application: AppWindow, scenario: Layers, testCase: FileCheck2 } as const;

export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const q = useDebounced(query.trim(), 150);
  const hits = useQuery({
    queryKey: ['search', q],
    queryFn: () => api<SearchHit[]>(`/api/search?q=${encodeURIComponent(q)}`),
    enabled: open && q.length >= 2,
    placeholderData: (prev) => prev,
  });

  const commands = useMemo<Command[]>(() => {
    const nav: Command[] = NAV.map((n) => ({
      id: n.to,
      label: `Go to ${n.label}`,
      hint: n.description,
      icon: n.icon,
      section: 'Navigation',
      run: () => navigate({ to: n.to }),
    }));
    const found: Command[] =
      q.length >= 2
        ? (hits.data ?? []).map((h) => ({
            id: `${h.kind}:${h.id}`,
            label: h.title,
            hint: h.subtitle,
            icon: HIT_ICON[h.kind],
            section: 'Results',
            run: () => {
              setCurrentAppId(h.applicationId);
              if (h.kind === 'application') navigate({ to: '/applications/$appId', params: { appId: h.id } });
              else
                navigate({
                  to: '/explorer',
                  search: { scenario: h.scenarioId, tab: h.kind === 'testCase' ? 'testCases' : undefined },
                });
            },
          }))
        : [];
    const ql = query.trim().toLowerCase();
    const navFiltered = ql ? nav.filter((c) => `${c.label} ${c.hint}`.toLowerCase().includes(ql)) : nav;
    return [...found, ...navFiltered];
  }, [navigate, hits.data, q, query]);

  useEffect(() => {
    if (open) {
      setQuery('');
      setIndex(0);
    }
  }, [open]);
  useEffect(() => setIndex(0), [query]);

  const choose = (c: Command | undefined) => {
    if (!c) return;
    c.run();
    onClose();
  };

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 pt-[14vh] backdrop-blur-sm"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onMouseDown={onClose}
        >
          <motion.div
            role="dialog"
            aria-label="Command palette"
            className="w-full max-w-xl overflow-hidden rounded-xl border border-border bg-elevated shadow-2xl"
            initial={{ y: -8, scale: 0.98 }}
            animate={{ y: 0, scale: 1 }}
            exit={{ y: -8, scale: 0.98 }}
            transition={{ duration: 0.14 }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2 border-b border-border px-4">
              <Search className="h-4 w-4 text-muted" />
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    setIndex((i) => Math.min(i + 1, commands.length - 1));
                  }
                  if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    setIndex((i) => Math.max(i - 1, 0));
                  }
                  if (e.key === 'Enter') choose(commands[index]);
                  if (e.key === 'Escape') onClose();
                }}
                placeholder="Search scenarios, test cases, applications, screens…"
                className="h-12 flex-1 bg-transparent text-sm outline-none placeholder:text-muted"
              />
            </div>
            <ul className="max-h-96 overflow-y-auto p-2" role="listbox">
              {commands.length === 0 && (
                <li className="px-3 py-6 text-center text-sm text-muted">No matches</li>
              )}
              {commands.map((c, i) => (
                <li key={c.id}>
                  {(i === 0 || commands[i - 1]!.section !== c.section) && (
                    <div className="px-3 pt-2 pb-1 text-[11px] font-medium tracking-wide text-muted uppercase">
                      {c.section}
                    </div>
                  )}
                  <div
                    role="option"
                    aria-selected={i === index}
                    onMouseEnter={() => setIndex(i)}
                    onClick={() => choose(c)}
                    className={cn(
                      'flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2 text-sm',
                      i === index && 'bg-brand/10',
                    )}
                  >
                    <c.icon className={cn('h-4 w-4 shrink-0 text-muted', i === index && 'text-brand')} />
                    <span className="truncate font-medium">{c.label}</span>
                    <span className="truncate text-xs text-muted">{c.hint}</span>
                    {i === index && <CornerDownLeft className="ml-auto h-3.5 w-3.5 shrink-0 text-muted" />}
                  </div>
                </li>
              ))}
            </ul>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
