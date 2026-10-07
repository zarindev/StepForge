import { mailpitBinary } from '@stepforge/email';
import type { FastifyInstance } from 'fastify';
import { existsSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AppContext } from '../src/context.ts';
import { H, testServer } from './helpers.ts';

const BIN_DIR = resolve(import.meta.dirname, '../../../data/bin');
const freePort = () =>
  new Promise<number>((r) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => r(port));
    });
  });

/**
 * What the demo workspace should show: most scenarios pass, and the ones that exercise the demo app's real defects
 * fail. (StepForge never reads the demo's defect list; these expectations come from the scenarios themselves.)
 */
const EXPECTED: Record<string, 'passed' | 'failed'> = {
  'Sign in with valid credentials': 'passed',
  'A wrong password is refused': 'passed',
  'Register a patient': 'passed',
  'Search patients': 'passed',
  'The same patient cannot be registered twice': 'failed',
  'Book an appointment': 'passed',
  'A doctor cannot be double-booked': 'passed',
  'Health check': 'passed',
  'Doctors match the documented schema': 'failed',
  'Appointments require a login': 'failed',
  'Deleting an unknown patient returns 404': 'failed',
  'Deleting a patient removes their appointments': 'failed',
  'Patient data is complete': 'passed',
  'Sign up with email verification': 'passed',
  'The dashboard loads quickly': 'passed',
  'Looking up a patient uses the primary key': 'passed',
  'Register in the UI, check the API and the database': 'passed',
};

describe.skipIf(!existsSync(mailpitBinary(BIN_DIR)))('demo workspace (onboarding)', () => {
  let app: FastifyInstance;
  let ctx: AppContext;
  const call = (method: string, url: string, payload?: unknown) =>
    app.inject({
      method: method as 'GET',
      url,
      headers: H,
      ...(payload !== undefined && { payload: payload as object }),
    });

  beforeAll(async () => {
    ({ app, ctx } = await testServer({
      binDir: BIN_DIR,
      mailpit: { httpPort: await freePort(), smtpPort: await freePort() },
    }));
  }, 30_000);
  afterAll(async () => {
    await app.close(); // stops CareClinic and Mailpit
  });

  it('loads in one call, and a full run passes and fails as expected', async () => {
    expect((await call('GET', '/api/demo')).json()).toMatchObject({ available: true, loaded: false });
    const res = await call('POST', '/api/demo/load');
    expect(res.statusCode).toBe(200);
    const loaded = res.json() as {
      applicationId: string;
      clinicUrl: string;
      mailpit: boolean;
      created: boolean;
      warnings: string[];
    };
    expect(loaded).toMatchObject({ created: true, mailpit: true, warnings: [] });
    expect(await (await fetch(`${loaded.clinicUrl}/api/health`)).json()).toEqual({
      ok: true,
      app: 'CareClinic',
    });

    // Organised tree, environment pointing at the running demo, secrets, connection and gate.
    const tree = (await call('GET', `/api/applications/${loaded.applicationId}/tree`)).json() as {
      modules: { name: string }[];
      scenarios: unknown[];
    };
    expect(tree.modules.map((m) => m.name)).toEqual([
      'Sign in',
      'Patients',
      'Appointments',
      'API',
      'Database',
      'Email',
      'Performance',
      'End to end',
    ]);
    expect(tree.scenarios).toHaveLength(Object.keys(EXPECTED).length);
    const env = (
      (await call('GET', `/api/applications/${loaded.applicationId}/environments`)).json() as {
        id: string;
        baseUrl: string;
      }[]
    )[0]!;
    expect(env.baseUrl).toBe(loaded.clinicUrl);
    const secrets = (await call('GET', `/api/environments/${env.id}/secrets`)).json() as { key: string }[];
    expect(secrets.map((s) => s.key).sort()).toEqual(['adminPassword', 'password']);
    expect(JSON.stringify(secrets)).not.toContain('Reception123!');
    expect(
      (
        (await call('GET', `/api/applications/${loaded.applicationId}/connections`)).json() as {
          name: string;
          engine: string;
        }[]
      )[0],
    ).toMatchObject({ name: 'clinic', engine: 'sqlite' });

    // Loading again is harmless.
    expect((await call('POST', '/api/demo/load')).json()).toMatchObject({
      applicationId: loaded.applicationId,
      created: false,
    });

    const run = (
      await call('POST', '/api/runs', {
        applicationId: loaded.applicationId,
        environmentId: env.id,
        scope: { type: 'application' },
      })
    ).json() as { id: string };
    await ctx.runs.idle();
    const detail = (await call('GET', `/api/runs/${run.id}`)).json() as {
      status: string;
      qualityGateJson: { status: string } | null;
      items: {
        labelJson: { scenario: string };
        status: string;
        errorMessage: string | null;
        diagnosisJson: { title: string } | null;
      }[];
    };
    const byScenario = new Map<string, string[]>();
    for (const i of detail.items)
      byScenario.set(i.labelJson.scenario, [...(byScenario.get(i.labelJson.scenario) ?? []), i.status]);
    const actual = Object.fromEntries(
      [...byScenario].map(([k, v]) => [k, v.every((x) => x === 'passed') ? 'passed' : 'failed']),
    );
    const details = detail.items
      .filter((i) => i.status !== 'passed')
      .map(
        (i) =>
          `${i.labelJson.scenario}: ${i.status} — ${i.errorMessage ?? ''} [${i.diagnosisJson?.title ?? ''}]`,
      );
    if (process.env.SHOW_DEMO_DIAGNOSES) writeFileSync(process.env.SHOW_DEMO_DIAGNOSES, details.join('\n'));
    expect(actual, details.join('\n')).toEqual(EXPECTED);
    expect(detail.status).toBe('failed');
    expect(detail.qualityGateJson?.status).toBe('red');
    // Each expected failure is a product failure with a diagnosis, never a broken test.
    for (const i of detail.items.filter((x) => x.status !== 'passed')) {
      expect(i.status, i.labelJson.scenario).toBe('failed');
      expect(i.diagnosisJson?.title, i.labelJson.scenario).toBeTruthy();
    }
  }, 240_000);
});
