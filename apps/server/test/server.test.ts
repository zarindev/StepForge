import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { isAllowedHost, tokensMatch } from '../src/security.ts';

const TOKEN = 'test-token-123';
const H = { host: '127.0.0.1:4400', 'x-stepforge-token': TOKEN };
let app: Awaited<ReturnType<typeof buildApp>>['app'];

beforeAll(async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'sf-server-'));
  ({ app } = await buildApp({
    token: TOKEN,
    config: {
      dataDir,
      dbFile: ':memory:',
      artifactsDir: join(dataDir, 'a'),
      keyFile: join(dataDir, '.key'),
      webDist: join(dataDir, 'no-web'),
    },
  }));
});
afterAll(async () => app.close());

describe('server security', () => {
  it('health is public', async () => {
    const res = await app.inject({ url: '/api/health', headers: { host: 'localhost:4400' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, name: 'StepForge' });
  });

  it('rejects requests without a token', async () => {
    const res = await app.inject({ url: '/api/system', headers: { host: '127.0.0.1' } });
    expect(res.statusCode).toBe(401);
  });

  it('rejects foreign Host headers (DNS rebinding)', async () => {
    const res = await app.inject({ url: '/api/health', headers: { host: 'evil.example.com' } });
    expect(res.statusCode).toBe(403);
  });

  it('accepts token via header or query', async () => {
    expect((await app.inject({ url: '/api/system', headers: H })).statusCode).toBe(200);
    const q = await app.inject({ url: `/api/system?token=${TOKEN}`, headers: { host: 'localhost' } });
    expect(q.statusCode).toBe(200);
  });

  it('helpers behave', () => {
    expect(tokensMatch('abc', 'abc')).toBe(true);
    expect(tokensMatch('abc', 'abd')).toBe(false);
    expect(tokensMatch('abc', undefined)).toBe(false);
    expect(isAllowedHost('localhost:1')).toBe(true);
    expect(isAllowedHost('127.0.0.1.nip.io')).toBe(false);
  });
});

describe('system + settings', () => {
  it('reports counts and the step catalogue', async () => {
    const body = (await app.inject({ url: '/api/system', headers: H })).json();
    expect(body.counts).toMatchObject({ applications: 0, runs: 0 });
    expect(body.stepCatalogue.ui).toContain('click');
  });

  it('returns defaults and validates updates', async () => {
    const s = (await app.inject({ url: '/api/settings', headers: H })).json();
    expect(s.theme).toBe('dark');
    const ok = await app.inject({
      method: 'PUT',
      url: '/api/settings/theme',
      headers: H,
      payload: { value: 'light' },
    });
    expect(ok.statusCode).toBe(200);
    const bad = await app.inject({
      method: 'PUT',
      url: '/api/settings/theme',
      headers: H,
      payload: { value: 'pink' },
    });
    expect(bad.statusCode).toBe(400);
    const unknown = await app.inject({
      method: 'PUT',
      url: '/api/settings/nope',
      headers: H,
      payload: { value: 1 },
    });
    expect(unknown.statusCode).toBe(404);
    expect((await app.inject({ url: '/api/settings', headers: H })).json().theme).toBe('light');
  });

  it('serves a helpful page when the UI is not built', async () => {
    const res = await app.inject({ url: '/', headers: { host: '127.0.0.1' } });
    expect(res.body).toContain('not built yet');
  });
});
