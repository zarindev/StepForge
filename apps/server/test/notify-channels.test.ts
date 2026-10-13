import type { FastifyInstance } from 'fastify';
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { H, testServer } from './helpers.ts';

/** Slack, Teams and webhook channels: the webhook URL is a secret, and "Send test" posts to it. */
let app: FastifyInstance;
let hook: Server;
let base = '';
const got: { path: string; body: Record<string, unknown> }[] = [];

async function ok<T = Record<string, unknown> & { id: string }>(
  method: string,
  url: string,
  payload?: unknown,
) {
  const res = await app.inject({
    method: method as 'GET',
    url,
    headers: H,
    ...(payload !== undefined && { payload: payload as object }),
  });
  if (res.statusCode >= 300) throw new Error(`${method} ${url} → ${res.statusCode}: ${res.body}`);
  return (res.body ? res.json() : undefined) as T;
}

beforeAll(async () => {
  ({ app } = await testServer());
  hook = createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      got.push({ path: req.url ?? '', body: JSON.parse(b) as Record<string, unknown> });
      res.writeHead(200).end('ok');
    });
  });
  await new Promise<void>((r) => hook.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(hook.address() as { port: number }).port}`;
});
afterAll(async () => {
  await app.close();
  hook.close();
});

describe('webhook notification channels', () => {
  it('stores the URL encrypted, never returns it, and sends a test message', async () => {
    const slack = await ok('POST', '/api/notify-channels', {
      kind: 'slack',
      name: '#qa',
      config: { mention: '<!here>' },
      secret: `${base}/services/T1/B2/TOKEN123`,
    });
    const teams = await ok('POST', '/api/notify-channels', {
      kind: 'teams',
      name: 'QA channel',
      config: {},
      secret: `${base}/workflows/abc?sig=SIG456`,
    });
    const list = await ok<unknown[]>('GET', '/api/notify-channels');
    expect(JSON.stringify(list)).not.toContain('TOKEN123');
    expect(JSON.stringify(list)).not.toContain('SIG456');
    expect(list).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: slack.id, kind: 'slack', hasSecret: true })]),
    );

    expect(await ok('POST', `/api/notify-channels/${slack.id}/test`)).toMatchObject({
      ok: true,
      message: 'Test message sent to #qa',
    });
    expect(await ok('POST', `/api/notify-channels/${teams.id}/test`)).toMatchObject({ ok: true });
    expect(got.map((g) => g.path)).toEqual(['/services/T1/B2/TOKEN123', '/workflows/abc?sig=SIG456']);
    expect(JSON.stringify(got[0]!.body)).toContain('StepForge · Test message: passed');
    expect(got[1]!.body).toMatchObject({ type: 'message' });

    // Not a URL: refused.
    const bad = await app.inject({
      method: 'POST',
      url: '/api/notify-channels',
      headers: H,
      payload: { kind: 'teams', name: 'x', config: {}, secret: 'not a url' },
    });
    expect(bad.statusCode).toBe(400);
  });
});
