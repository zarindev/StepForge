/** One request a test's browser made (as kept in a run's network.json). */
export type NetworkEntry = {
  method: string;
  url: string;
  status?: number;
  resourceType: string;
  durationMs?: number;
  /** Bytes received (headers + body); 0 or missing when unknown (cache, failure). */
  bytes?: number;
  failure?: string;
  startedAt?: number;
  /** The step (position) that was running when the request started. */
  step?: number;
};

export type NetworkGroup = { key: string; requests: number; bytes: number; timeMs: number };
export type NetworkSummary = {
  requests: number;
  bytes: number;
  failed: number;
  /** Requests answered 4xx/5xx or never answered. */
  errors: NetworkEntry[];
  byType: NetworkGroup[];
  byHost: (NetworkGroup & { thirdParty: boolean })[];
  thirdPartyRequests: number;
  thirdPartyHosts: number;
  slowest: NetworkEntry[];
  largest: NetworkEntry[];
};

const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
};
/** example.co.uk and www.example.co.uk are the same site; cdn.example.com belongs to example.com. */
const site = (host: string) => {
  const h = host.replace(/:\d+$/, '');
  if (/^[\d.]+$/.test(h) || h === 'localhost' || !h.includes('.')) return h;
  const parts = h.split('.');
  const twoLevel = parts.length > 2 && parts.at(-2)!.length <= 3 && parts.at(-1)!.length === 2;
  return parts.slice(twoLevel ? -3 : -2).join('.');
};

function group<T extends NetworkEntry>(list: T[], keyOf: (e: T) => string): NetworkGroup[] {
  const m = new Map<string, NetworkGroup>();
  for (const e of list) {
    const key = keyOf(e) || '(unknown)';
    const g = m.get(key) ?? { key, requests: 0, bytes: 0, timeMs: 0 };
    g.requests++;
    g.bytes += e.bytes ?? 0;
    g.timeMs += e.durationMs ?? 0;
    m.set(key, g);
  }
  return [...m.values()].sort((a, b) => b.bytes - a.bytes || b.requests - a.requests);
}

/**
 * The breakdown of a test's network traffic: totals, by resource type, by host (first or third party, compared with
 * the application's base URL), the slowest and largest requests, and the errors. `data:` and `blob:` URLs are left out.
 */
export function summarizeNetwork(entries: NetworkEntry[], baseUrl?: string): NetworkSummary {
  const list = entries.filter((e) => /^https?:/.test(e.url));
  const own = site(hostOf(baseUrl ?? '') || hostOf(list[0]?.url ?? ''));
  const isThird = (host: string) => !!own && site(host) !== own;
  const errors = list.filter((e) => e.failure || (e.status ?? 0) >= 400);
  const byHost = group(list, (e) => hostOf(e.url)).map((g) => ({ ...g, thirdParty: isThird(g.key) }));
  const third = byHost.filter((h) => h.thirdParty);
  const top = (key: (e: NetworkEntry) => number) =>
    [...list]
      .filter((e) => key(e) > 0)
      .sort((a, b) => key(b) - key(a))
      .slice(0, 5);
  return {
    requests: list.length,
    bytes: list.reduce((n, e) => n + (e.bytes ?? 0), 0),
    failed: errors.length,
    errors,
    byType: group(list, (e) => e.resourceType),
    byHost,
    thirdPartyRequests: third.reduce((n, h) => n + h.requests, 0),
    thirdPartyHosts: third.length,
    slowest: top((e) => e.durationMs ?? 0),
    largest: top((e) => e.bytes ?? 0),
  };
}

/** Readable byte counts: 950 B, 12.4 kB, 3.1 MB. */
export function formatBytes(n: number): string {
  if (n < 1000) return `${n} B`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)} kB`;
  return `${(n / 1_000_000).toFixed(1)} MB`;
}
