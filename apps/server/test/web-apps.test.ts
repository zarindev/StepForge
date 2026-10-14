import type { FastifyInstance } from 'fastify';
import { readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AppContext } from '../src/context.ts';
import { H, testServer } from './helpers.ts';

/** Sites behind basic auth or needing headers (environment browser settings), and visual checkpoints end to end. */
let app: FastifyInstance;
let ctx: AppContext;
let target: Server;
let appId = '';
let envId = '';
let moduleId = '';

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
type Step = {
  id: string;
  type: string;
  status: string;
  message: string | null;
  responseJson: { visual?: { baseline: string; status: string } };
};
async function runOne(scenarioId: string) {
  const r = await ok<{ id: string }>('POST', '/api/runs', {
    applicationId: appId,
    environmentId: envId,
    scope: { type: 'scenarios', ids: [scenarioId] },
  });
  await ctx.runs.idle();
  const run = await ok<{ items: { id: string; status: string }[] }>('GET', `/api/runs/${r.id}`);
  const item = run.items[0]!;
  return { item, steps: (await ok<{ steps: Step[] }>('GET', `/api/run-items/${item.id}`)).steps };
}

beforeAll(async () => {
  ({ app, ctx } = await testServer());
  target = createServer((req, res) => {
    if (req.headers.authorization !== `Basic ${Buffer.from('qa:hunter2').toString('base64')}`)
      return res.writeHead(401, { 'www-authenticate': 'Basic realm="staging"' }).end('login required');
    res
      .writeHead(200, { 'content-type': 'text/html' })
      .end(
        `<title>Staging</title><p id="flag">${String(req.headers['x-feature'] ?? 'none')}</p><div id="box" style="width:80px;height:40px;background:#2a7"></div>`,
      );
  });
  await new Promise<void>((r) => target.listen(0, '127.0.0.1', r));
  appId = (await ok('POST', '/api/applications', { name: 'Web apps', slug: 'web-apps' })).id;
  envId = (
    await ok('POST', `/api/applications/${appId}/environments`, {
      name: 'Staging',
      baseUrl: `http://127.0.0.1:${(target.address() as { port: number }).port}`,
      browserDefaults: {
        browser: 'chromium',
        headless: true,
        settings: {
          httpCredentials: { username: 'qa', password: '{{secret.basicPassword}}' },
          extraHTTPHeaders: { 'X-Feature': '{{env.flag}}' },
          locale: 'en-GB',
        },
      },
      variables: { flag: 'new-checkout' },
    })
  ).id;
  await ok('PUT', `/api/environments/${envId}/secrets`, { key: 'basicPassword', value: 'hunter2' });
  moduleId = (await ok('POST', `/api/applications/${appId}/modules`, { name: 'Pages' })).id;
}, 30_000);
afterAll(async () => {
  await app.close();
  target.close();
});

describe('web apps', () => {
  it('opens a site behind basic auth with extra headers from the environment (secrets resolved at run time)', async () => {
    const s = await ok('POST', `/api/modules/${moduleId}/scenarios`, {
      name: 'Behind a login prompt',
      steps: [
        { type: 'ui.navigate', params: { url: '/' } },
        {
          type: 'ui.assert',
          params: { check: 'text', expected: 'new-checkout' },
          locators: [{ strategy: 'css', value: '#flag' }],
        },
      ],
    });
    const { item, steps } = await runOne(s.id);
    expect(item.status, steps.map((x) => x.message).join('\n')).toBe('passed');
    // The stored environment keeps the placeholder, never the password.
    const envs = await ok<
      { id: string; browserDefaultsJson: { settings: { httpCredentials: { password: string } } } }[]
    >('GET', `/api/applications/${appId}/environments`);
    const env = envs.find((e) => e.id === envId)!;
    expect(env.browserDefaultsJson.settings.httpCredentials.password).toBe('{{secret.basicPassword}}');
  }, 60_000);

  it('visual checkpoint: baseline on the first run, a change fails, and accepting makes it the new baseline', async () => {
    const s = await ok('POST', `/api/modules/${moduleId}/scenarios`, {
      name: 'Looks right',
      steps: [
        { type: 'ui.navigate', params: { url: '/' } },
        { type: 'ui.visualCheckpoint', locators: [{ strategy: 'css', value: '#box' }] },
      ],
    });
    const first = await runOne(s.id);
    expect(first.item.status).toBe('passed');
    const visual = first.steps.at(-1)!.responseJson.visual!;
    expect(visual.status).toBe('new');
    // Baselines are kept per application, so a checkpoint in another application never shares one.
    expect(visual.baseline.split(/[\\/]/).slice(0, 2)).toEqual(['baselines', appId]);

    // Someone's change turned the box another colour: here, the baseline is altered instead.
    const file = join(ctx.config.artifactsDir, visual.baseline);
    const png = PNG.sync.read(readFileSync(file));
    for (let i = 0; i < png.data.length; i += 4) png.data[i + 2] = 255;
    writeFileSync(file, PNG.sync.write(png));
    const second = await runOne(s.id);
    expect(second.item.status).toBe('failed');
    const changed = second.steps.at(-1)!;
    expect(changed.responseJson.visual!.status).toBe('changed');
    expect(changed.message).toMatch(/% of pixels differ from the baseline/);

    await ok('POST', `/api/step-results/${changed.id}/accept-baseline`);
    const third = await runOne(s.id);
    expect(third.item.status).toBe('passed');
    expect(third.steps.at(-1)!.responseJson.visual!.status).toBe('match');
  }, 90_000);
});
