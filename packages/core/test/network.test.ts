import { describe, expect, it } from 'vitest';
import { formatBytes, summarizeNetwork, type NetworkEntry } from '../src/index.ts';

const e = (url: string, resourceType: string, extra: Partial<NetworkEntry> = {}): NetworkEntry => ({
  method: 'GET',
  url,
  resourceType,
  status: 200,
  ...extra,
});

describe('network breakdown', () => {
  it('totals, groups by type and host, tells first from third party, and lists errors, slowest and largest', () => {
    const s = summarizeNetwork(
      [
        e('https://shop.example.co.uk/', 'document', { bytes: 30_000, durationMs: 120 }),
        e('https://static.example.co.uk/app.js', 'script', { bytes: 250_000, durationMs: 300 }),
        e('https://www.example.co.uk/api/cart', 'fetch', { bytes: 800, durationMs: 900, status: 500 }),
        e('https://cdn.tracker.com/t.js', 'script', { bytes: 40_000, durationMs: 50 }),
        e('https://fonts.gstatic.com/a.woff2', 'font', { failure: 'net::ERR_BLOCKED_BY_CLIENT' }),
        e('data:image/png;base64,AAAA', 'image', { bytes: 10 }),
      ],
      'https://shop.example.co.uk',
    );
    expect(s).toMatchObject({
      requests: 5,
      bytes: 320_800,
      failed: 2,
      thirdPartyHosts: 2,
      thirdPartyRequests: 2,
    });
    expect(s.byType.map((g) => `${g.key}:${g.requests}:${g.bytes}`)).toEqual([
      'script:2:290000',
      'document:1:30000',
      'fetch:1:800',
      'font:1:0',
    ]);
    expect(
      s.byHost
        .filter((h) => h.thirdParty)
        .map((h) => h.key)
        .sort(),
    ).toEqual(['cdn.tracker.com', 'fonts.gstatic.com']);
    expect(s.byHost.find((h) => h.key === 'static.example.co.uk')!.thirdParty).toBe(false);
    expect(s.errors.map((x) => x.url)).toEqual([
      'https://www.example.co.uk/api/cart',
      'https://fonts.gstatic.com/a.woff2',
    ]);
    expect(s.slowest[0]!.url).toBe('https://www.example.co.uk/api/cart');
    expect(s.largest[0]!.url).toBe('https://static.example.co.uk/app.js');
  });

  it('a short domain under a country code is a site of its own; only known second levels are like co.uk', () => {
    const third = (base: string, ...urls: string[]) =>
      summarizeNetwork(
        urls.map((u) => e(u, 'script')),
        base,
      )
        .byHost.filter((h) => h.thirdParty)
        .map((h) => h.key);
    expect(third('https://www.bmw.de', 'https://cdn.bmw.de/a.js', 'https://sap.de/b.js')).toEqual(['sap.de']);
    expect(third('https://abc.io', 'https://static.abc.io/a.js')).toEqual([]);
    expect(
      third('https://shop.example.com.au', 'https://img.example.com.au/a.js', 'https://other.com.au/b.js'),
    ).toEqual(['other.com.au']);
    expect(third('http://localhost:3000', 'http://api.localhost:3001/a.js')).toEqual([]);
  });

  it('formats byte counts', () => {
    expect([950, 12_400, 3_100_000].map(formatBytes)).toEqual(['950 B', '12.4 kB', '3.1 MB']);
  });
});
