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
const EXPECTED: Record<string, Record<string, 'passed' | 'failed'>> = {
  CareClinic: {
    'Sign in with valid credentials': 'passed',
    'A wrong password is refused': 'passed',
    'Dashboard labels the appointment count': 'failed',
    'Dashboard lists the next appointments': 'failed',
    'Register a patient': 'passed',
    'Search patients': 'passed',
    'The same patient cannot be registered twice': 'failed',
    'Book an appointment': 'passed',
    'A doctor cannot be double-booked': 'passed',
    'Book an appointment on a phone': 'passed', // desktop run; fails in the mobile run
    'The booking form refuses a double booking': 'failed',
    'Insured patients get 20% off': 'failed',
    'Health check': 'passed',
    'Doctors match the documented schema': 'failed',
    'Appointments require a login': 'failed',
    'Deleting an unknown patient returns 404': 'failed',
    'Deleting a patient removes their appointments': 'failed',
    'Patient data is complete': 'passed',
    'Sign up with email verification': 'passed',
    'Verify with the link in the email': 'failed',
    'The dashboard loads quickly': 'passed',
    'Looking up a patient uses the primary key': 'passed',
    'The visits report answers quickly': 'failed',
    "The doctors' schedule answers quickly": 'failed',
    'Register in the UI, check the API and the database': 'passed',
  },
  ShopDesk: {
    'Sign in as the cashier': 'passed',
    'Search products': 'passed',
    'Add a product': 'passed',
    'Out-of-stock products are marked': 'failed',
    'Selling one unit reduces stock': 'passed',
    'A sale total counts every unit': 'failed',
    'The cart shows the running total': 'failed',
    'Complete a sale on a phone': 'passed', // desktop run; fails in the mobile run
    'Receiving stock increases it': 'passed',
    'Stock never goes negative': 'failed',
    'Deleting a product removes its sale lines': 'failed',
    'Profit is revenue minus cost': 'failed',
    'Cashiers cannot add products': 'passed',
    'A product without a name is rejected': 'failed',
    'Products match the documented schema': 'failed',
    'The profit report requires a login': 'failed',
    'Health check': 'passed',
    'The sales report answers quickly': 'failed',
    'Expanded sales answer quickly': 'failed',
    'Add a product in the UI, sell it through the API, check the database': 'passed',
  },
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

  type Item = {
    labelJson: { scenario: string };
    status: string;
    errorMessage: string | null;
    diagnosisJson: { title: string; category: string } | null;
  };
  const runAndWait = async (
    applicationId: string,
    environmentId: string,
    scope: unknown,
    options?: unknown,
  ) => {
    const run = (
      await call('POST', '/api/runs', {
        applicationId,
        environmentId,
        scope,
        ...(options !== undefined && { options }),
      })
    ).json() as { id: string };
    await ctx.runs.idle();
    return (await call('GET', `/api/runs/${run.id}`)).json() as {
      status: string;
      qualityGateJson: { status: string } | null;
      items: Item[];
    };
  };
  const outcome = (items: Item[]) => {
    const by = new Map<string, string[]>();
    for (const i of items) by.set(i.labelJson.scenario, [...(by.get(i.labelJson.scenario) ?? []), i.status]);
    return Object.fromEntries(
      [...by].map(([k, v]) => [k, v.every((x) => x === 'passed') ? 'passed' : 'failed']),
    );
  };

  it('loads both demo apps in one call, and their runs pass and fail as expected', async () => {
    expect((await call('GET', '/api/demo')).json()).toMatchObject({ available: true, loaded: false });
    const res = await call('POST', '/api/demo/load');
    expect(res.statusCode).toBe(200);
    const loaded = res.json() as {
      applications: { name: string; applicationId: string; url: string }[];
      mailpit: boolean;
      created: boolean;
      warnings: string[];
    };
    expect(loaded).toMatchObject({ created: true, mailpit: true, warnings: [] });
    expect(loaded.applications.map((a) => a.name)).toEqual(['CareClinic', 'ShopDesk']);
    expect((await call('POST', '/api/demo/load')).json()).toMatchObject({ created: false });

    const report: string[] = [];
    for (const demo of loaded.applications) {
      expect(await (await fetch(`${demo.url}/api/health`)).json()).toEqual({ ok: true, app: demo.name });
      const tree = (await call('GET', `/api/applications/${demo.applicationId}/tree`)).json() as {
        scenarios: unknown[];
      };
      expect(tree.scenarios).toHaveLength(Object.keys(EXPECTED[demo.name]!).length);
      const env = (
        (await call('GET', `/api/applications/${demo.applicationId}/environments`)).json() as {
          id: string;
          baseUrl: string;
        }[]
      )[0]!;
      expect(env.baseUrl).toBe(demo.url);
      const secrets = (await call('GET', `/api/environments/${env.id}/secrets`)).json() as { key: string }[];
      expect(JSON.stringify(secrets)).not.toMatch(/123!/);

      const desktop = await runAndWait(demo.applicationId, env.id, { type: 'application' });
      for (const i of desktop.items.filter((x) => x.status !== 'passed'))
        report.push(
          `${demo.name} | desktop | ${i.labelJson.scenario} | ${i.status} | ${i.diagnosisJson?.category ?? ''} | ${i.diagnosisJson?.title ?? ''} | ${i.errorMessage ?? ''}`,
        );
      expect(outcome(desktop.items), report.join('\n')).toEqual(EXPECTED[demo.name]);
      expect(desktop.qualityGateJson?.status).toBe('red');
      for (const i of desktop.items.filter((x) => x.status !== 'passed')) {
        expect(i.status, i.labelJson.scenario).toBe('failed'); // a product failure, never a broken test
        expect(i.diagnosisJson?.title, i.labelJson.scenario).toBeTruthy();
      }
      // The phone scenarios at the mobile viewport.
      const tags = (await call('GET', `/api/applications/${demo.applicationId}/tags`)).json() as {
        id: string;
        name: string;
      }[];
      const mobile = await runAndWait(
        demo.applicationId,
        env.id,
        { type: 'tag', id: tags.find((t) => t.name === 'mobile')!.id },
        { viewport: 'mobile' },
      );
      for (const i of mobile.items)
        report.push(
          `${demo.name} | mobile | ${i.labelJson.scenario} | ${i.status} | ${i.diagnosisJson?.category ?? ''} | ${i.diagnosisJson?.title ?? ''} | ${i.errorMessage ?? ''}`,
        );
      expect(mobile.items.map((i) => i.status)).toEqual(['failed']);
    }
    if (process.env.SHOW_DEMO_DIAGNOSES) writeFileSync(process.env.SHOW_DEMO_DIAGNOSES, report.join('\n'));
  }, 400_000);
});
