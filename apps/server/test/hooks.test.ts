import type { FastifyInstance } from 'fastify';
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AppContext } from '../src/context.ts';
import { H, testServer } from './helpers.ts';

/** Setup/teardown hooks: blocks run before / after every test of a module (and its sub-modules) or one scenario. */
let app: FastifyInstance;
let ctx: AppContext;
let target: Server;
let appId = '';
let envId = '';
const mods: Record<string, string> = {};
const blocks: Record<string, string> = {};

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
type Step = {
  stepId: string;
  type: string;
  label: string;
  status: string;
  message: string | null;
  responseJson: { path?: string };
};
async function runOne(scenarioId: string) {
  const r = await ok<{ id: string }>('POST', '/api/runs', {
    applicationId: appId,
    environmentId: envId,
    scope: { type: 'scenarios', ids: [scenarioId] },
  });
  await ctx.runs.idle();
  const run = await ok<{ items: { id: string; status: string; failedStepId: string | null }[] }>(
    'GET',
    `/api/runs/${r.id}`,
  );
  const item = run.items[0]!;
  const detail = await ok<{ steps: Step[] }>('GET', `/api/run-items/${item.id}`);
  return { item, steps: detail.steps };
}
const log = (message: string) => ({ type: 'util.log', params: { message } });
const status = (code: number) => ({
  type: 'api.request',
  label: `GET /status/${code}`,
  params: { url: `/status/${code}` },
  assertions: [{ target: 'status', operator: 'equals', expected: 200 }],
});
/** "<path> <message or label>" for the leaf steps, in run order. */
const trace = (steps: Step[]) =>
  steps
    .filter((s) => s.type !== 'util.useBlock')
    .map((s) => `${s.responseJson?.path} ${s.status} ${s.message ?? s.label}`);

beforeAll(async () => {
  ({ app, ctx } = await testServer());
  target = createServer((req, res) => {
    const code = Number(req.url?.split('/').pop()) || 200;
    res.writeHead(code, { 'content-type': 'application/json' }).end('{}');
  });
  await new Promise<void>((r) => target.listen(0, '127.0.0.1', r));
  appId = (await ok('POST', '/api/applications', { name: 'Hooks', slug: 'hooks' })).id;
  envId = (
    await ok('POST', `/api/applications/${appId}/environments`, {
      name: 'Local',
      baseUrl: `http://127.0.0.1:${(target.address() as { port: number }).port}`,
    })
  ).id;
  mods.outer = (await ok('POST', `/api/applications/${appId}/modules`, { name: 'Outer' })).id;
  mods.inner = (
    await ok('POST', `/api/applications/${appId}/modules`, { name: 'Inner', parentId: mods.outer })
  ).id;
  for (const [key, msg] of [
    ['outerBefore', 'outer before'],
    ['outerAfter', 'outer after'],
    ['innerBefore', 'inner before'],
    ['innerAfter', 'inner after'],
    ['ownBefore', 'own before'],
    ['ownAfter', 'own after'],
  ] as const)
    blocks[key] = (
      await ok('POST', `/api/applications/${appId}/blocks`, { name: msg, steps: [log(msg)] })
    ).id;
  blocks.broken = (
    await ok('POST', `/api/applications/${appId}/blocks`, { name: 'Broken setup', steps: [status(500)] })
  ).id;
  await ok('PATCH', `/api/modules/${mods.outer}`, {
    setupBlockId: blocks.outerBefore,
    teardownBlockId: blocks.outerAfter,
  });
  await ok('PATCH', `/api/modules/${mods.inner}`, {
    setupBlockId: blocks.innerBefore,
    teardownBlockId: blocks.innerAfter,
  });
}, 30_000);
afterAll(async () => {
  await app.close();
  target.close();
});

describe('setup/teardown hooks', () => {
  it('runs module hooks (outer first) and the scenario’s own around the test; the test keeps its step numbers', async () => {
    const s = await ok<{ id: string }>('POST', `/api/modules/${mods.inner}/scenarios`, {
      name: 'Has every hook',
      steps: [log('test step 1'), log('test step 2')],
      setupBlockId: blocks.ownBefore,
      teardownBlockId: blocks.ownAfter,
    });
    const { item, steps } = await runOne(s.id);
    expect(item.status).toBe('passed');
    expect(trace(steps)).toEqual([
      'before.1.1 passed outer before',
      'before.2.1 passed inner before',
      'before.3.1 passed own before',
      '1 passed test step 1',
      '2 passed test step 2',
      'after.1.1 passed own after',
      'after.2.1 passed inner after',
      'after.3.1 passed outer after',
    ]);
    expect(steps.find((x) => x.responseJson?.path === 'before.1')!.label).toBe(
      'Before each test: outer before (module Outer)',
    );
    expect(steps.find((x) => x.responseJson?.path === 'after.1')!.label).toBe(
      'After each test: own after (this scenario)',
    );
  });

  it('after-hooks run even when the test fails; a failing before-hook skips the test', async () => {
    const failing = await ok<{ id: string }>('POST', `/api/modules/${mods.outer}/scenarios`, {
      name: 'Fails in the middle',
      steps: [status(500), log('never reached')],
    });
    const a = await runOne(failing.id);
    expect(a.item.status).toBe('failed');
    expect(trace(a.steps)).toEqual([
      'before.1.1 passed outer before',
      expect.stringMatching(/^1 failed /),
      '2 skipped Skipped after an earlier failure',
      'after.1.1 passed outer after',
    ]);

    const s = await ok<{ id: string }>('POST', `/api/modules/${mods.outer}/scenarios`, {
      name: 'Setup breaks',
      steps: [log('the test itself')],
      setupBlockId: blocks.broken,
    });
    const b = await runOne(s.id);
    expect(b.item.status).toBe('failed');
    expect(trace(b.steps)).toEqual([
      'before.1.1 passed outer before',
      expect.stringMatching(/^before\.2\.1 failed /),
      '1 skipped Skipped after an earlier failure',
      'after.1.1 passed outer after',
    ]);
    // The failure is inside the hook's block: a fix goes there (it repairs every test using the hook).
    const owner = await ok<{ kind: string; name: string }>(
      'GET',
      `/api/run-items/${b.item.id}/step-owner?stepId=${encodeURIComponent(b.item.failedStepId!)}`,
    );
    expect(owner).toMatchObject({ kind: 'block', name: 'Broken setup' });
  });

  it('counts hook users, refuses another application’s block, and clears hooks when the block is deleted', async () => {
    const usage = await ok<{ modules: { name: string; setup: boolean }[]; affectedScenarios: number }>(
      'GET',
      `/api/blocks/${blocks.outerBefore}/usage`,
    );
    expect(usage.modules).toEqual([expect.objectContaining({ name: 'Outer', setup: true })]);
    expect(usage.affectedScenarios).toBe(3); // every test under Outer, also in Inner

    const other = (await ok('POST', '/api/applications', { name: 'Other', slug: 'other-hooks' })).id;
    const foreign = (await ok('POST', `/api/applications/${other}/blocks`, { name: 'Foreign' })).id;
    expect((await call('PATCH', `/api/modules/${mods.outer}`, { setupBlockId: foreign })).statusCode).toBe(
      400,
    );

    // Export/import keeps module hooks; exported code inlines them.
    const exported = await ok<Record<string, unknown>>('GET', `/api/applications/${appId}/export`);
    const imported = await ok<{ applicationId: string }>(
      'POST',
      '/api/applications/import?slug=hooks-copy',
      exported,
    );
    const tree = await ok<{ modules: { name: string; setupBlockId: string | null }[] }>(
      'GET',
      `/api/applications/${imported.applicationId}/tree`,
    );
    const copiedOuter = tree.modules.find((m) => m.name === 'Outer')!;
    expect(copiedOuter.setupBlockId).toBeTruthy();
    expect(copiedOuter.setupBlockId).not.toBe(blocks.outerBefore);

    const preview = await ok<{ files: { path: string; content?: string }[] }>(
      'POST',
      `/api/applications/${appId}/codegen/preview`,
      { target: 'playwright-ts' },
    );
    const spec = preview.files.find((f) => f.path.endsWith('has-every-hook.spec.ts'))!.content!;
    expect(spec).toContain('// Before each test — block: outer before');
    expect(spec.indexOf('// Before each test — block: outer before')).toBeLessThan(
      spec.indexOf("'test step 1'"),
    );
    expect(spec.indexOf('// After each test — block: outer after')).toBeGreaterThan(
      spec.indexOf("'test step 2'"),
    );

    await ok('DELETE', `/api/blocks/${blocks.outerAfter}`);
    const after = await ok<{ modules: { id: string; teardownBlockId: string | null }[] }>(
      'GET',
      `/api/applications/${appId}/tree`,
    );
    expect(after.modules.find((m) => m.id === mods.outer)!.teardownBlockId).toBeNull();
  });
});
