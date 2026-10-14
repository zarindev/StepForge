import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AppContext } from '../src/context.ts';
import { H, testServer } from './helpers.ts';

/** The run queue: one run at a time; waiting runs start by priority, then oldest first; "Run next" jumps ahead. */
let app: FastifyInstance;
let ctx: AppContext;
let appId = '';
let envId = '';
let slowId = '';
let quickId = '';

async function call(method: string, url: string, payload?: unknown) {
  return app.inject({
    method: method as 'GET',
    url,
    headers: H,
    ...(payload !== undefined && { payload: payload as object }),
  });
}
async function ok<T = Record<string, unknown> & { id: string }>(
  method: string,
  url: string,
  payload?: unknown,
) {
  const res = await call(method, url, payload);
  if (res.statusCode >= 300) throw new Error(`${method} ${url} → ${res.statusCode}: ${res.body}`);
  return (res.body ? res.json() : undefined) as T;
}
type Run = {
  id: string;
  status: string;
  priority: number;
  startedAt: string | null;
  finishedAt: string | null;
};
const start = (scenarioId: string, priority?: string) =>
  ok<Run>('POST', '/api/runs', {
    applicationId: appId,
    environmentId: envId,
    scope: { type: 'scenarios', ids: [scenarioId] },
    ...(priority && { options: { priority } }),
  });

beforeAll(async () => {
  ({ app, ctx } = await testServer());
  appId = (await ok('POST', '/api/applications', { name: 'Queue', slug: 'queue' })).id;
  envId = (
    await ok('POST', `/api/applications/${appId}/environments`, {
      name: 'Local',
      baseUrl: 'http://127.0.0.1:9',
    })
  ).id;
  const mod = (await ok('POST', `/api/applications/${appId}/modules`, { name: 'Q' })).id;
  slowId = (
    await ok('POST', `/api/modules/${mod}/scenarios`, {
      name: 'Slow',
      steps: [{ type: 'util.wait', params: { ms: 1500 } }],
    })
  ).id;
  quickId = (
    await ok('POST', `/api/modules/${mod}/scenarios`, {
      name: 'Quick',
      steps: [{ type: 'util.log', params: { message: 'hi' } }],
    })
  ).id;
});
afterAll(async () => {
  await app.close();
});

describe('run queue priorities', () => {
  it('starts waiting runs by priority, then oldest; "next" jumps ahead; only waiting runs can be reordered', async () => {
    // The order runs really start in, from the live events.
    const startedOrder: string[] = [];
    ctx.bus.on('event', (e: { type: string; run?: { id: string; status: string } }) => {
      if (e.type === 'run.updated' && e.run?.status === 'running' && !startedOrder.includes(e.run.id))
        startedOrder.push(e.run.id);
    });
    const blocker = await start(slowId);
    const low = await start(quickId, 'low');
    const normal = await start(quickId);
    const high = await start(quickId, 'high');
    expect([low.priority, normal.priority, high.priority]).toEqual([-1, 0, 1]);

    const queue = await ok<{ active: Run | null; waiting: Run[] }>('GET', '/api/runs/queue');
    expect(queue.active?.id).toBe(blocker.id);
    expect(queue.waiting.map((r) => r.id)).toEqual([high.id, normal.id, low.id]);

    await ok('POST', `/api/runs/${low.id}/priority`, { priority: 'next' });
    expect((await ok<{ waiting: Run[] }>('GET', '/api/runs/queue')).waiting.map((r) => r.id)).toEqual([
      low.id,
      high.id,
      normal.id,
    ]);

    await ctx.runs.idle();
    const runs = await Promise.all([low, high, normal].map((r) => ok<Run>('GET', `/api/runs/${r.id}`)));
    expect(runs.map((r) => r.status)).toEqual(['passed', 'passed', 'passed']);
    expect(startedOrder).toEqual([blocker.id, low.id, high.id, normal.id]);
    expect((await call('POST', `/api/runs/${low.id}/priority`, { priority: 'high' })).statusCode).toBe(409);
  }, 30_000);
});
