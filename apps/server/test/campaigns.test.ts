import { createClinicApp } from '@stepforge/demo-clinic';
import type { FastifyInstance } from 'fastify';
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AppContext } from '../src/context.ts';
import { H, testServer } from './helpers.ts';

/** Campaigns: one selection × environments × browsers × screen sizes, a combined report, rerun failed, one summary. */
let app: FastifyInstance;
let ctx: AppContext;
let clinic: ReturnType<typeof createClinicApp>;
let telegram: Server;
const received: { text: string }[] = [];
let appId = '';
let local = '';
let staging = '';
let channelId = '';
const mods: Record<string, string> = {};
const scen: Record<string, string> = {};

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
type Detail = {
  status: string;
  trigger: string;
  totals: { total: number; passed: number; failed: number };
  cells: { runId: string; environment: string; browser: string; viewport: string; status: string }[];
  grid: { name: string; results: Record<string, { status: string }> }[];
  parent: { id: string } | null;
};
const waitDone = async (id: string) => {
  await ctx.runs.idle();
  for (let i = 0; i < 50; i++) {
    const d = await ok<Detail & { finishedAt: string | null }>('GET', `/api/campaign-runs/${id}`);
    if (d.finishedAt) return d;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('campaign run did not finish');
};

beforeAll(async () => {
  ({ app, ctx } = await testServer());
  clinic = createClinicApp({ dbFile: ':memory:' });
  await clinic.listen({ host: '127.0.0.1', port: 0 });
  const clinicUrl = `http://127.0.0.1:${(clinic.server.address() as { port: number }).port}`;
  telegram = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received.push(JSON.parse(body || '{}'));
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true,"result":{}}');
    });
  });
  await new Promise<void>((r) => telegram.listen(0, '127.0.0.1', r));
  appId = (await ok('POST', '/api/applications', { name: 'CareClinic', slug: 'careclinic-camp' })).id;
  // Two environments of the same app; "Staging" points the health check at a page that does not exist.
  local = (
    await ok('POST', `/api/applications/${appId}/environments`, {
      name: 'Local',
      baseUrl: clinicUrl,
      variables: { healthPath: '/api/health' },
    })
  ).id;
  staging = (
    await ok('POST', `/api/applications/${appId}/environments`, {
      name: 'Staging',
      baseUrl: clinicUrl,
      variables: { healthPath: '/api/missing' },
    })
  ).id;
  for (const m of ['Smoke', 'Docs'])
    mods[m] = (await ok('POST', `/api/applications/${appId}/modules`, { name: m })).id;
  const api = (name: string, url: string, module = 'Smoke') =>
    ok<{ id: string }>('POST', `/api/modules/${mods[module]}/scenarios`, {
      name,
      steps: [
        {
          type: 'api.request',
          params: { url },
          assertions: [{ target: 'status', operator: 'equals', expected: 200 }],
        },
      ],
    });
  scen.health = (await api('Health answers', '{{env.healthPath}}')).id;
  scen.spec = (await api('API spec is served', '/api/openapi.json')).id;
  scen.docs = (await api('Not in the campaign', '/api/health', 'Docs')).id;
  channelId = (
    await ok('POST', '/api/notify-channels', {
      kind: 'telegram',
      name: 'QA chat',
      config: { chatId: '-1', apiBase: `http://127.0.0.1:${(telegram.address() as { port: number }).port}` },
      secret: 'BOT',
    })
  ).id;
}, 30_000);
afterAll(async () => {
  await app.close();
  await clinic.close();
  telegram.close();
});

describe('campaigns', () => {
  let campaignId = '';

  it('validates a campaign: environments of this application, a non-empty selection, unique names', async () => {
    const other = (await ok('POST', '/api/applications', { name: 'Other', slug: 'other-camp' })).id;
    const otherEnv = (
      await ok('POST', `/api/applications/${other}/environments`, { name: 'X', baseUrl: 'http://x.test' })
    ).id;
    const bad = await call('POST', `/api/applications/${appId}/campaigns`, {
      name: 'Bad',
      environmentIds: [otherEnv],
    });
    expect(bad.statusCode).toBe(400);
    expect(
      (await call('POST', `/api/applications/${appId}/campaigns`, { name: 'Bad', environmentIds: [] }))
        .statusCode,
    ).toBe(400);
    const empty = await call('POST', `/api/applications/${appId}/campaigns`, {
      name: 'Bad',
      environmentIds: [local],
      selection: { modules: [], tags: [], scenarios: [] },
    });
    expect(empty.statusCode).toBe(400);

    const c = await ok<{ id: string }>('POST', `/api/applications/${appId}/campaigns`, {
      name: 'Release check',
      selection: { modules: [mods.Smoke] },
      environmentIds: [local, staging],
      browsers: ['chromium'],
      viewports: ['desktop', 'mobile'],
      options: { workers: 2 },
      channelIds: [channelId],
    });
    campaignId = c.id;
    const dup = await call('POST', `/api/applications/${appId}/campaigns`, {
      name: 'Release check',
      environmentIds: [local],
    });
    expect(dup.statusCode).toBe(400);
    const got = await ok<{ matrix: unknown[] }>('GET', `/api/campaigns/${c.id}`);
    expect(got.matrix).toHaveLength(4); // 2 environments × 1 browser × 2 screen sizes
  });

  it('runs every combination, reports them together, and sends one summary at the end', async () => {
    received.length = 0;
    const started = await ok<{ id: string; status: string; runs: number }>(
      'POST',
      `/api/campaigns/${campaignId}/run`,
    );
    expect(started.runs).toBe(4);
    const d = await waitDone(started.id);
    expect(d.status).toBe('failed');
    expect(d.trigger).toBe('manual');
    expect(d.cells.map((c) => `${c.environment}/${c.viewport}:${c.status}`)).toEqual([
      'Local/desktop:passed',
      'Local/mobile:passed',
      'Staging/desktop:failed',
      'Staging/mobile:failed',
    ]);
    expect(d.totals).toMatchObject({ total: 8, passed: 6, failed: 2 });
    // Per-test grid: the failing test first; it fails only on Staging. "Not in the campaign" is not there.
    expect(d.grid.map((t) => t.name)).toEqual(['Health answers', 'API spec is served']);
    const health = d.grid[0]!;
    const byEnv = d.cells.map((c) => `${c.environment}:${health.results[c.runId]!.status}`);
    expect(byEnv).toEqual(['Local:passed', 'Local:passed', 'Staging:failed', 'Staging:failed']);

    // One notification for the whole campaign (not one per run).
    expect(received).toHaveLength(1);
    expect(received[0]!.text).toContain('CareClinic · 4 combinations: failed');
    expect(received[0]!.text).toContain('Campaign "Release check"');
    expect(received[0]!.text).toContain('Health answers — Staging · chromium · desktop');
    expect(received[0]!.text).toContain(`/campaign-runs/${started.id}`);

    // Rerun failed: only the failing test, only where it failed.
    const rerun = await ok<{ id: string; runs: number }>(
      'POST',
      `/api/campaign-runs/${started.id}/rerun-failed`,
    );
    expect(rerun.runs).toBe(2);
    const r = await waitDone(rerun.id);
    expect(r.trigger).toBe('rerun');
    expect(r.parent?.id).toBe(started.id);
    expect(r.cells.map((c) => c.environment)).toEqual(['Staging', 'Staging']);
    expect(r.totals.total).toBe(2);
    expect(r.grid.map((t) => t.name)).toEqual(['Health answers']);

    const runs = await ok<{ runs: { id: string; status: string }[] }>('GET', `/api/campaigns/${campaignId}`);
    expect(runs.runs.map((x) => x.id)).toEqual([rerun.id, started.id]);
    const list = await ok<{ name: string; lastRun: { id: string } }[]>(
      'GET',
      `/api/applications/${appId}/campaigns`,
    );
    expect(list[0]).toMatchObject({ name: 'Release check', lastRun: { id: rerun.id } });
  }, 60_000);

  it('passes everywhere after the environment is fixed; nothing left to rerun', async () => {
    await ok('PATCH', `/api/environments/${staging}`, { variables: { healthPath: '/api/health' } });
    const started = await ok<{ id: string }>('POST', `/api/campaigns/${campaignId}/run`);
    const d = await waitDone(started.id);
    expect(d.status).toBe('passed');
    const none = await call('POST', `/api/campaign-runs/${started.id}/rerun-failed`);
    expect(none.statusCode).toBe(400);
    expect(none.json().message).toMatch(/Nothing failed/);
  }, 60_000);

  it('a schedule can run the campaign; deleting the campaign removes its schedules', async () => {
    received.length = 0;
    const s = await ok<{ id: string; environmentId: string | null }>(
      'POST',
      `/api/applications/${appId}/schedules`,
      {
        name: 'Nightly matrix',
        cron: '0 2 * * *',
        campaignId,
        channelIds: [],
      },
    );
    expect(s.environmentId).toBeNull();
    const cr = (await ctx.scheduler.trigger(s.id)) as { id: string };
    const d = await waitDone(cr.id);
    expect(d.trigger).toBe('schedule');
    expect(d.cells).toHaveLength(4);
    expect(received).toHaveLength(1); // the campaign's channel, once
    expect(received[0]!.text).toContain('Schedule "Nightly matrix"');
    const history = await ok<{ id: string; scheduleId: string }[]>('GET', `/api/schedules/${s.id}/runs`);
    expect(history.length).toBeGreaterThanOrEqual(4);

    expect(
      (await call('POST', `/api/applications/${appId}/schedules`, { name: 'No target', cron: '0 2 * * *' }))
        .statusCode,
    ).toBe(400);
    await ok('DELETE', `/api/campaigns/${campaignId}`);
    expect((await call('GET', `/api/schedules/${s.id}/runs`)).statusCode).toBe(404);
  }, 60_000);

  it('a selection of manual tests only is refused before anything is queued', async () => {
    const manualMod = (await ok('POST', `/api/applications/${appId}/modules`, { name: 'Manual only' })).id;
    await ok('POST', `/api/modules/${manualMod}/scenarios`, {
      name: 'Looks right',
      execution: 'manual',
      steps: [{ type: 'util.manual', params: { instruction: 'Check the logo' } }],
    });
    const c = await ok<{ id: string }>('POST', `/api/applications/${appId}/campaigns`, {
      name: 'Manual campaign',
      selection: { modules: [manualMod] },
      environmentIds: [local, staging],
    });
    const res = await call('POST', `/api/campaigns/${c.id}/run`);
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/This campaign has no automated tests to run/);
    expect((await ok<{ runs: unknown[] }>('GET', `/api/campaigns/${c.id}`)).runs).toHaveLength(0);
  });

  it('deleting an environment takes it out of campaigns, which still launch', async () => {
    const extra = (
      await ok('POST', `/api/applications/${appId}/environments`, {
        name: 'Gone soon',
        baseUrl: 'http://x.test',
      })
    ).id;
    const c = await ok<{ id: string }>('POST', `/api/applications/${appId}/campaigns`, {
      name: 'With a doomed environment',
      selection: { scenarios: [scen.spec] },
      environmentIds: [local, extra],
    });
    await ok('DELETE', `/api/environments/${extra}`);
    const got = await ok<{ environmentIdsJson: string[] }>('GET', `/api/campaigns/${c.id}`);
    expect(got.environmentIdsJson).toEqual([local]);
    const started = await ok<{ id: string }>('POST', `/api/campaigns/${c.id}/run`);
    const d = await waitDone(started.id);
    expect(d.cells).toHaveLength(1);
    expect(d.status).toBe('passed');
  }, 60_000);
});
