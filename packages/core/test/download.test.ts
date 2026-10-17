import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { downloadRelease } from '../src/download.ts';

/** Release downloads are refused unless their SHA-256 matches the pinned hash or GitHub's published digest. */
const body = Buffer.from('pretend this is mailpit');
const sha = createHash('sha256').update(body).digest('hex');
let server: Server;
let base = '';

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === '/o/tool/releases/download/v1/tool.tar.gz') return res.end(body);
    if (req.url === '/repos/o/tool/releases/tags/v1')
      return res.end(
        JSON.stringify({
          assets: [
            { name: 'tool.tar.gz', digest: `sha256:${sha}` },
            { name: 'old.tar.gz', digest: null },
          ],
        }),
      );
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => server.close());

describe('downloadRelease', () => {
  const asset = (over: Record<string, unknown> = {}) => ({
    repo: 'o/tool',
    tag: 'v1',
    asset: 'tool.tar.gz',
    site: base,
    api: base,
    ...over,
  });

  it('accepts a download that matches the pinned hash', async () => {
    expect(await downloadRelease(asset({ sha256: sha.toUpperCase() }))).toEqual(body);
  });

  it('refuses one that does not', async () => {
    await expect(downloadRelease(asset({ sha256: '0'.repeat(64) }))).rejects.toThrow(
      /tool\.tar\.gz did not match its checksum .*nothing was installed/,
    );
  });

  it('without a pinned hash, checks against the digest GitHub publishes', async () => {
    expect(await downloadRelease(asset())).toEqual(body);
  });

  it('refuses an asset GitHub publishes no digest for, or a release it cannot read', async () => {
    await expect(downloadRelease(asset({ asset: 'old.tar.gz' }))).rejects.toThrow(/publishes no SHA-256/);
    await expect(downloadRelease(asset({ tag: 'v2' }))).rejects.toThrow(/Could not read the checksum .*404/);
  });
});
