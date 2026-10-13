import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AppContext } from '../src/context.ts';
import { H, testServer } from './helpers.ts';

/** Block maintenance: where a block is used, turning steps into a block, inputs, and exporting them. */
let app: FastifyInstance;
let ctx: AppContext;
let appId = '';
let envId = '';
let moduleId = '';

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
): Promise<T> {
  const res = await call(method, url, payload);
  if (res.statusCode >= 300) throw new Error(`${method} ${url} → ${res.statusCode}: ${res.body}`);
  return (res.body ? res.json() : undefined) as T;
}
const log = (message: string) => ({ type: 'util.log', params: { message } });

beforeAll(async () => {
  ({ app, ctx } = await testServer());
  appId = (await ok('POST', '/api/applications', { name: 'Blocks', slug: 'blocks' })).id;
  envId = (
    await ok('POST', `/api/applications/${appId}/environments`, { name: 'Local', baseUrl: 'http://x.test' })
  ).id;
  moduleId = (await ok('POST', `/api/applications/${appId}/modules`, { name: 'Flows' })).id;
});
afterAll(() => app.close());

describe('block maintenance', () => {
  it('turns consecutive steps into a block; the scenario then uses it (a new version)', async () => {
    const s = await ok<{ id: string; steps: { id: string }[] }>(
      'POST',
      `/api/modules/${moduleId}/scenarios`,
      {
        name: 'Checkout',
        steps: [log('open'), log('add to cart'), log('pay'), log('done')],
      },
    );
    const [, two, three, four] = s.steps.map((x) => x.id);
    const gap = await call('POST', `/api/scenarios/${s.id}/extract-block`, {
      stepIds: [two, four],
      name: 'X',
    });
    expect(gap.statusCode).toBe(400);
    expect(gap.json().message).toMatch(/next to each other/);

    const r = await ok<{
      block: { id: string; name: string; steps: { params: { message: string } }[] };
      scenario: {
        version: number;
        steps: { type: string; label?: string; params: Record<string, unknown> }[];
      };
    }>('POST', `/api/scenarios/${s.id}/extract-block`, { stepIds: [three, two], name: 'Buy the cart' });
    expect(r.block.steps.map((x) => x.params.message)).toEqual(['add to cart', 'pay']);
    expect(r.scenario.version).toBe(2);
    expect(r.scenario.steps.map((x) => x.type)).toEqual(['util.log', 'util.useBlock', 'util.log']);
    expect(r.scenario.steps[1]).toMatchObject({ label: 'Buy the cart', params: { blockId: r.block.id } });

    // Running it still logs the same four messages.
    const run = await ok<{ id: string }>('POST', '/api/runs', {
      applicationId: appId,
      environmentId: envId,
      scope: { type: 'scenarios', ids: [s.id] },
    });
    await ctx.runs.idle();
    const done = await ok<{ status: string }>('GET', `/api/runs/${run.id}`);
    expect(done.status).toBe('passed');
  });

  it('counts uses inside conditions and loops, and through blocks that use the block', async () => {
    const inner = await ok<{ id: string }>('POST', `/api/applications/${appId}/blocks`, {
      name: 'Inner',
      steps: [log('inner')],
    });
    const outer = await ok<{ id: string }>('POST', `/api/applications/${appId}/blocks`, {
      name: 'Outer',
      steps: [{ type: 'util.useBlock', params: { blockId: inner.id } }],
    });
    await ok('POST', `/api/modules/${moduleId}/scenarios`, {
      name: 'Loops over the inner block',
      steps: [
        {
          type: 'util.loop',
          params: { count: 2, steps: [{ type: 'util.useBlock', params: { blockId: inner.id } }] },
        },
        { type: 'util.useBlock', params: { blockId: inner.id } },
      ],
    });
    await ok('POST', `/api/modules/${moduleId}/scenarios`, {
      name: 'Uses the outer block',
      steps: [{ type: 'util.useBlock', params: { blockId: outer.id } }],
    });
    const usage = await ok<{
      scenarios: { name: string; uses: number }[];
      blocks: { name: string; uses: number }[];
      affectedScenarios: number;
    }>('GET', `/api/blocks/${inner.id}/usage`);
    expect(usage.scenarios).toEqual([
      expect.objectContaining({ name: 'Loops over the inner block', uses: 2 }),
    ]);
    expect(usage.blocks).toEqual([expect.objectContaining({ name: 'Outer', uses: 1 })]);
    expect(usage.affectedScenarios).toBe(2); // directly, and through "Outer"
    const list = await ok<{ name: string; usedBy: number }[]>('GET', `/api/applications/${appId}/blocks`);
    expect(list.find((b) => b.name === 'Inner')!.usedBy).toBe(2);
  });

  it('passes inputs to a block (defaults, required ones) and exports them as variables', async () => {
    const bad = await call('POST', `/api/applications/${appId}/blocks`, {
      name: 'Bad',
      inputs: [{ name: 'first name' }],
    });
    expect(bad.statusCode).toBe(400);
    const greet = await ok<{ id: string }>('POST', `/api/applications/${appId}/blocks`, {
      name: 'Greet',
      inputs: [{ name: 'who' }, { name: 'greeting', default: 'Hello' }],
      steps: [log('{{vars.greeting}}, {{vars.who}}!')],
    });
    const s = await ok<{ id: string }>('POST', `/api/modules/${moduleId}/scenarios`, {
      name: 'Greets twice',
      steps: [
        { type: 'util.useBlock', params: { blockId: greet.id, inputs: { who: 'Ana' } } },
        { type: 'util.useBlock', params: { blockId: greet.id, inputs: { who: 'Ben', greeting: 'Hi' } } },
      ],
    });
    const missing = await ok<{ id: string }>('POST', `/api/modules/${moduleId}/scenarios`, {
      name: 'Forgets the input',
      steps: [{ type: 'util.useBlock', params: { blockId: greet.id } }],
    });
    const run = await ok<{ id: string; items: { id: string }[] }>('POST', '/api/runs', {
      applicationId: appId,
      environmentId: envId,
      scope: { type: 'scenarios', ids: [s.id, missing.id] },
    });
    await ctx.runs.idle();
    const done = await ok<{
      items: { id: string; status: string; errorMessage: string | null; labelJson: { scenario: string } }[];
    }>('GET', `/api/runs/${run.id}`);
    const byName = (n: string) => done.items.find((i) => i.labelJson.scenario === n)!;
    expect(byName('Greets twice').status).toBe('passed');
    const item = await ok<{ steps: { type: string; message: string | null }[] }>(
      'GET',
      `/api/run-items/${byName('Greets twice').id}`,
    );
    expect(item.steps.filter((x) => x.type === 'util.log').map((x) => x.message)).toEqual([
      'Hello, Ana!',
      'Hi, Ben!',
    ]);
    expect(byName('Forgets the input').status).toBe('broken');
    expect(byName('Forgets the input').errorMessage).toMatch(/needs a value for its input "who"/);

    const preview = await ok<{ files: { path: string; content?: string }[] }>(
      'POST',
      `/api/applications/${appId}/codegen/preview`,
      { target: 'playwright-ts', scope: { type: 'scenarios', ids: [s.id] } },
    );
    const spec = preview.files.find((f) => f.path.endsWith('greets-twice.spec.ts'))!.content!;
    expect(spec).toContain('// Block: Greet');
    expect(spec).toMatch(/vars\.who = 'Ana'/);
    expect(spec).toMatch(/vars\.greeting = 'Hello'/);
    expect(spec).toMatch(/vars\.greeting = 'Hi'/);
  });
});
