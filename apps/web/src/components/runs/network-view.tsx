import { formatBytes, summarizeNetwork, type NetworkEntry, type NetworkGroup } from '@stepforge/core';
import { useMemo, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Input, Select } from '@/components/ui/input';
import { cn } from '@/lib/utils';

const path = (url: string) => url.replace(/^https?:\/\/[^/]+/, '') || '/';
const host = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
};

function Bars({
  title,
  groups,
  total,
  third,
}: {
  title: string;
  groups: NetworkGroup[];
  total: number;
  third?: Set<string>;
}) {
  return (
    <div className="min-w-0 rounded-lg border border-border p-3">
      <p className="mb-2 text-xs font-medium text-muted">{title}</p>
      <ul className="space-y-1.5 text-xs">
        {groups.slice(0, 8).map((g) => (
          <li key={g.key} className="space-y-0.5">
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate font-mono" title={g.key}>
                {g.key}
              </span>
              {third?.has(g.key) && <Badge tone="warn">third party</Badge>}
              <span className="tabular-nums text-muted">
                {g.requests} · {formatBytes(g.bytes)}
              </span>
            </div>
            <div className="h-1.5 rounded-full bg-fg/5">
              <div
                className="h-1.5 rounded-full bg-brand/70"
                style={{ width: `${total ? Math.max(2, (g.bytes / total) * 100) : 0}%` }}
              />
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * A test's network traffic: a breakdown (totals, by type, by host with third parties marked, slowest, largest,
 * failures) and the full request list with filters.
 */
export function NetworkView({ entries }: { entries: NetworkEntry[] }) {
  const [view, setView] = useState<'breakdown' | 'requests'>('breakdown');
  const [type, setType] = useState('');
  const [hostFilter, setHostFilter] = useState('');
  const [query, setQuery] = useState('');
  const [errorsOnly, setErrorsOnly] = useState(false);
  const s = useMemo(() => summarizeNetwork(entries), [entries]);
  const third = useMemo(() => new Set(s.byHost.filter((h) => h.thirdParty).map((h) => h.key)), [s]);
  const rows = entries.filter(
    (n) =>
      (!type || n.resourceType === type) &&
      (!hostFilter || host(n.url) === hostFilter) &&
      (!query || n.url.toLowerCase().includes(query.toLowerCase())) &&
      (!errorsOnly || n.failure || (n.status ?? 0) >= 400),
  );
  const tile = (label: string, value: string, tone?: string) => (
    <div className="rounded-lg border border-border px-3 py-2">
      <p className="text-[11px] text-muted">{label}</p>
      <p className={cn('text-lg font-semibold tabular-nums', tone)}>{value}</p>
    </div>
  );
  const list = (title: string, items: NetworkEntry[], value: (n: NetworkEntry) => string) => (
    <div className="min-w-0 rounded-lg border border-border p-3">
      <p className="mb-2 text-xs font-medium text-muted">{title}</p>
      {items.length ? (
        <ul className="space-y-1 font-mono text-xs">
          {items.map((n, i) => (
            <li key={i} className="flex gap-2" title={n.url}>
              <span className="min-w-0 flex-1 truncate">{path(n.url)}</span>
              <span className="shrink-0 text-muted">{value(n)}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-muted">None</p>
      )}
    </div>
  );

  return (
    <div className="space-y-3" data-testid="network-view">
      <div className="flex gap-1" role="tablist" aria-label="Network view">
        {(['breakdown', 'requests'] as const).map((v) => (
          <button
            key={v}
            role="tab"
            aria-selected={view === v}
            onClick={() => setView(v)}
            className={cn(
              'rounded-md px-2.5 py-1 text-xs capitalize',
              view === v ? 'bg-brand/12 text-brand' : 'text-muted hover:text-fg',
            )}
          >
            {v === 'breakdown' ? 'Breakdown' : `Requests (${entries.length})`}
          </button>
        ))}
      </div>

      {view === 'breakdown' ? (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
            {tile('Requests', String(s.requests))}
            {tile('Transferred', formatBytes(s.bytes))}
            {tile('Failed', String(s.failed), s.failed ? 'text-fail' : undefined)}
            {tile(
              'Third-party hosts',
              String(s.thirdPartyHosts),
              s.thirdPartyHosts ? 'text-warn' : undefined,
            )}
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            <Bars title="By type" groups={s.byType} total={s.bytes} />
            <Bars title="By host" groups={s.byHost} total={s.bytes} third={third} />
            {list('Slowest', s.slowest, (n) => `${n.durationMs} ms`)}
            {list('Largest', s.largest, (n) => formatBytes(n.bytes ?? 0))}
          </div>
          {s.errors.length > 0 &&
            list('Failed requests', s.errors, (n) => String(n.status ?? n.failure ?? ''))}
        </div>
      ) : (
        <>
          <div className="flex flex-wrap gap-2">
            <Input
              aria-label="Filter requests"
              placeholder="Filter by URL"
              className="h-8 max-w-60 text-xs"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <Select
              aria-label="Type"
              className="h-8 max-w-40 text-xs"
              value={type}
              onChange={(e) => setType(e.target.value)}
            >
              <option value="">All types</option>
              {s.byType.map((g) => (
                <option key={g.key}>{g.key}</option>
              ))}
            </Select>
            <Select
              aria-label="Host"
              className="h-8 max-w-56 text-xs"
              value={hostFilter}
              onChange={(e) => setHostFilter(e.target.value)}
            >
              <option value="">All hosts</option>
              {s.byHost.map((h) => (
                <option key={h.key}>{h.key}</option>
              ))}
            </Select>
            <label className="flex items-center gap-1.5 text-xs">
              <input type="checkbox" checked={errorsOnly} onChange={(e) => setErrorsOnly(e.target.checked)} />{' '}
              Errors only
            </label>
          </div>
          <div className="max-h-96 overflow-auto rounded-lg border border-border">
            <table className="w-full font-mono text-xs">
              <thead className="sticky top-0 bg-surface text-left text-muted">
                <tr>
                  <th className="px-3 py-1.5">Step</th>
                  <th className="px-3 py-1.5">Method</th>
                  <th className="px-3 py-1.5">Status</th>
                  <th className="px-3 py-1.5">URL</th>
                  <th className="px-3 py-1.5">Type</th>
                  <th className="px-3 py-1.5 text-right">Size</th>
                  <th className="px-3 py-1.5 text-right">Time</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((n, i) => (
                  <tr
                    key={i}
                    className={cn(
                      'border-t border-border',
                      ((n.status ?? 0) >= 400 || n.failure) && 'bg-fail/5 text-fail',
                    )}
                  >
                    <td className="px-3 py-1 text-muted">{n.step !== undefined ? n.step + 1 : ''}</td>
                    <td className="px-3 py-1">{n.method}</td>
                    <td className="px-3 py-1">{n.status ?? n.failure ?? '—'}</td>
                    <td className="max-w-md truncate px-3 py-1" title={n.url}>
                      {third.has(host(n.url)) ? <span className="text-warn">{host(n.url)}</span> : null}
                      {path(n.url)}
                    </td>
                    <td className="px-3 py-1">
                      <Badge>{n.resourceType}</Badge>
                    </td>
                    <td className="px-3 py-1 text-right">{n.bytes ? formatBytes(n.bytes) : ''}</td>
                    <td className="px-3 py-1 text-right">
                      {n.durationMs !== undefined ? `${n.durationMs} ms` : ''}
                    </td>
                  </tr>
                ))}
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={7} className="px-3 py-4 text-center text-muted">
                      No requests match.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
