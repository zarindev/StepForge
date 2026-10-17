import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { buildApp } from '../src/app.ts';
import { isAllowedHost, tokensMatch } from '../src/security.ts';
import { H, TOKEN, testServer } from './helpers.ts';

let app: Awaited<ReturnType<typeof buildApp>>['app'];

beforeAll(async () => {
  ({ app } = await testServer());
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

  it('needs the token however the /api path is written (percent-encoded, %2F)', async () => {
    for (const url of ['/%61pi/system', '/%61%70%69/applications', '/api%2Fsystem', '/%61pi/demo'])
      expect((await app.inject({ url, headers: { host: '127.0.0.1' } })).statusCode, url).not.toBe(200);
    const post = await app.inject({
      method: 'POST',
      url: '/%61pi/maintenance/prune',
      headers: { host: '127.0.0.1', 'content-type': 'text/plain' },
      payload: 'x',
    });
    expect([401, 404]).toContain(post.statusCode);
    expect((await app.inject({ url: '/%61pi/system', headers: H })).statusCode).toBe(200);
    expect((await app.inject({ url: '/%E0%A4%A', headers: { host: '127.0.0.1' } })).statusCode).toBe(400);
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
    // Object.prototype members are not settings (they used to answer 500).
    for (const key of ['constructor', '__proto__', 'toString'])
      expect(
        (await app.inject({ method: 'PUT', url: `/api/settings/${key}`, headers: H, payload: { value: 1 } }))
          .statusCode,
        key,
      ).toBe(404);
    expect((await app.inject({ url: '/api/settings', headers: H })).json().theme).toBe('light');
  });

  it('bad query values are ignored, not a server error; duplicating a manual test keeps it manual', async () => {
    const appId = (
      await app.inject({
        method: 'POST',
        url: '/api/applications',
        headers: H,
        payload: { name: 'Q', slug: 'q-1' },
      })
    ).json().id;
    for (const days of ['abc', '-5', '0'])
      expect(
        (await app.inject({ url: `/api/applications/${appId}/analytics?days=${days}`, headers: H }))
          .statusCode,
        days,
      ).toBe(200);
    const mod = (
      await app.inject({
        method: 'POST',
        url: `/api/applications/${appId}/modules`,
        headers: H,
        payload: { name: 'M' },
      })
    ).json().id;
    const manual = (
      await app.inject({
        method: 'POST',
        url: `/api/modules/${mod}/scenarios`,
        headers: H,
        payload: {
          name: 'Check by hand',
          execution: 'manual',
          steps: [{ type: 'util.manual', params: { instruction: 'Look' } }],
        },
      })
    ).json();
    const copy = (
      await app.inject({ method: 'POST', url: `/api/scenarios/${manual.id}/duplicate`, headers: H })
    ).json();
    expect(copy.execution).toBe('manual');
  });

  it('serves a helpful page when the UI is not built', async () => {
    const res = await app.inject({ url: '/', headers: { host: '127.0.0.1' } });
    expect(res.body).toContain('not built yet');
  });
});
