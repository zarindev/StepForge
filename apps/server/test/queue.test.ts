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

describe('stopping StepForge during a run', () => {
  it('the test that was running runs again when the run is resumed (it is not lost as skipped)', async () => {
    type Item = { id: string; scenarioId: string; status: string };
    const run = await ok<Run>('POST', '/api/runs', {
      applicationId: appId,
      environmentId: envId,
      scope: { type: 'scenarios', ids: [quickId, slowId] },
    });
    // Wait until the slow test is the one running, then stop as StepForge does on shutdown.
    for (let i = 0; i < 100; i++) {
      const r = await ok<{ items: Item[] }>('GET', `/api/runs/${run.id}`);
      if (r.items.find((x) => x.scenarioId === slowId)?.status === 'running') break;
      await new Promise((res) => setTimeout(res, 50));
    }
    await ctx.runs.shutdown();
    const stopped = await ok<Run & { items: Item[] }>('GET', `/api/runs/${run.id}`);
    expect(stopped.status).toBe('interrupted');
    expect(stopped.items.find((x) => x.scenarioId === slowId)?.status).toBe('queued');

    await ok('POST', `/api/runs/${run.id}/resume`);
    await ctx.runs.idle();
    const done = await ok<Run & { items: Item[] }>('GET', `/api/runs/${run.id}`);
    expect(done.status).toBe('passed');
    expect(done.items.map((x) => x.status)).toEqual(['passed', 'passed']);
  }, 30_000);
});

describe('deleting an application during its run', () => {
  it('stops its run and the queue goes on with the other applications', async () => {
    const other = (await ok('POST', '/api/applications', { name: 'Doomed', slug: 'doomed' })).id;
    const otherEnv = (
      await ok('POST', `/api/applications/${other}/environments`, {
        name: 'Local',
        baseUrl: 'http://127.0.0.1:9',
      })
    ).id;
    const mod = (await ok('POST', `/api/applications/${other}/modules`, { name: 'D' })).id;
    const slow = (
      await ok('POST', `/api/modules/${mod}/scenarios`, {
        name: 'Long',
        steps: [{ type: 'util.wait', params: { ms: 3000 } }],
      })
    ).id;
    await ok('POST', '/api/runs', {
      applicationId: other,
      environmentId: otherEnv,
      scope: { type: 'scenarios', ids: [slow] },
    });
    const waiting = await start(quickId);
    await new Promise((r) => setTimeout(r, 300));
    const del = await call('DELETE', `/api/applications/${other}`, { confirm: 'Doomed' });
    expect(del.statusCode).toBe(204);
    await ctx.runs.idle();
    expect((await ok<Run>('GET', `/api/runs/${waiting.id}`)).status).toBe('passed');
  }, 30_000);
});
