import { createHash } from 'node:crypto';

/**
 * Node only (kept out of the package's main entry, which the dashboard also loads). Downloads a GitHub release asset
 * and refuses it unless its SHA-256 matches: the hash pinned in StepForge for the default version, or, for another
 * version chosen through an environment variable, the digest GitHub publishes for that asset.
 */
export type ReleaseAsset = {
  /** owner/name, e.g. axllent/mailpit */
  repo: string;
  tag: string;
  asset: string;
  /** Pinned SHA-256 (hex). When missing, GitHub's published digest for the asset is used. */
  sha256?: string;
  timeoutMs?: number;
  /** For tests: where releases and the GitHub API are served. */
  site?: string;
  api?: string;
};

export async function downloadRelease(a: ReleaseAsset): Promise<Buffer> {
  const site = a.site ?? 'https://github.com';
  const url = `${site}/${a.repo}/releases/download/${a.tag}/${a.asset}`;
  const want = (a.sha256 ?? (await publishedDigest(a))).toLowerCase();
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(a.timeoutMs ?? 180_000) });
  if (!res.ok) throw new Error(`Download failed (${res.status}) from ${url}`);
  const body = Buffer.from(await res.arrayBuffer());
  const got = createHash('sha256').update(body).digest('hex');
  if (got !== want)
    throw new Error(
      `${a.asset} did not match its checksum (expected sha256 ${want}, got ${got}); nothing was installed`,
    );
  return body;
}

async function publishedDigest(a: ReleaseAsset): Promise<string> {
  const api = a.api ?? 'https://api.github.com';
  const res = await fetch(`${api}/repos/${a.repo}/releases/tags/${encodeURIComponent(a.tag)}`, {
    headers: { accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok)
    throw new Error(`Could not read the checksum of ${a.repo} ${a.tag} from GitHub (${res.status})`);
  const release = (await res.json()) as { assets?: { name: string; digest?: string | null }[] };
  const digest = release.assets?.find((x) => x.name === a.asset)?.digest;
  const hex = digest?.startsWith('sha256:') ? digest.slice('sha256:'.length) : '';
  if (!/^[0-9a-f]{64}$/i.test(hex))
    throw new Error(
      `GitHub publishes no SHA-256 for ${a.asset} (${a.repo} ${a.tag}), so it cannot be checked`,
    );
  return hex;
}
