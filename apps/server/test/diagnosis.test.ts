import { createClinicApp } from '@stepforge/demo-clinic';
import ExcelJS from 'exceljs';
import type { FastifyInstance } from 'fastify';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AppContext } from '../src/context.ts';
import { H, testServer } from './helpers.ts';

let app: FastifyInstance;
let ctx: AppContext;
let clinic: ReturnType<typeof createClinicApp>;
let clinicUrl = '';
const clinicDb = join(mkdtempSync(join(tmpdir(), 'sf-diag-')), 'clinic.db');
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

type Diag = {
  category: string;
  owner: string;
  title: string;
  explanation: string;
  fix: string;
  suggestedLocator?: { strategy: string; value: string };
};
type Item = { id: string; status: string; errorMessage: string | null; labelJson: { scenario: string } };

beforeAll(async () => {
  ({ app, ctx } = await testServer());
  clinic = createClinicApp({ dbFile: clinicDb });
  await clinic.listen({ host: '127.0.0.1', port: 0 });
  clinicUrl = `http://127.0.0.1:${(clinic.server.address() as { port: number }).port}`;
  appId = (await ok('POST', '/api/applications', { name: 'CareClinic', slug: 'careclinic' })).id;
  envId = (await ok('POST', `/api/applications/${appId}/environments`, { name: 'Local', baseUrl: clinicUrl }))
    .id;
  for (const [key, value] of [
    ['apiPassword', 'Admin123!'],
    ['adminPassword', 'Admin123!'],
    ['password', 'Reception123!'],
  ])
    await ok('PUT', `/api/environments/${envId}/secrets`, { key, value });
  await ok('POST', `/api/environments/${envId}/connections`, {
    name: 'clinic',
    engine: 'sqlite',
    database: clinicDb,
  });
  moduleId = (await ok('POST', `/api/applications/${appId}/modules`, { name: 'Data rules' })).id;
}, 30_000);
afterAll(async () => {
  await app.close();
  await clinic.close();
});

async function run(scope: unknown) {
  await fetch(`${clinicUrl}/api/reset`, { method: 'POST' });
  const r = await ok<{ id: string }>('POST', '/api/runs', {
    applicationId: appId,
    environmentId: envId,
    scope,
    options: { workers: 4 },
  });
  await ctx.runs.idle();
  return ok<{ id: string; items: Item[] }>('GET', `/api/runs/${r.id}`);
}
const diagnosisOf = async (itemId: string) =>
  (await ok<{ diagnosisJson: Diag }>('GET', `/api/run-items/${itemId}`)).diagnosisJson;
async function scenario(name: string, steps: unknown[]) {
  return (await ok<{ id: string }>('POST', `/api/modules/${moduleId}/scenarios`, { name, steps })).id;
}

const login = (role: 'admin' | 'reception') => [
  {
    type: 'api.request',
    params: {
      method: 'POST',
      url: '/api/auth/login',
      body: {
        email: `${role}@careclinic.test`,
        password: role === 'admin' ? '{{secret.adminPassword}}' : '{{secret.password}}',
      },
    },
  },
  { type: 'api.extract', params: { path: '$.token' }, captureAs: 'token' },
];

describe('diagnosis of the planted CareClinic bugs (done-when)', () => {
  let orphanId = '';
  let duplicateId = '';

  it('labels each planted bug with the right category and owner, and files one bug each', async () => {
    // API layer: the generated OpenAPI suite with contract checks.
    const spec = await ok<{ id: string }>('POST', `/api/applications/${appId}/api-specs`, {
      url: '/api/openapi.json',
      environmentId: envId,
    });
    const imported = await ok<{ rootModuleId: string }>('POST', `/api/applications/${appId}/import`, {
      kind: 'openapi',
      specId: spec.id,
      options: { contract: true },
    });
    const apiRun = await run({ type: 'module', id: imported.rootModuleId });
    const failed = apiRun.items.filter((i) => i.status !== 'passed');
    const byError = async (re: RegExp) => {
      const item = failed.find((i) => re.test(i.errorMessage ?? ''));
      expect(item, `a failure matching ${re}`).toBeDefined();
      return diagnosisOf(item!.id);
    };
    expect(failed).toHaveLength(3);

    const fee = await byError(/fee should be number/); // CC-API-01
    expect([fee.category, fee.owner]).toEqual(['schema_mismatch', 'app']);
    expect(fee.title).toMatch(/fee should be number/);

    const noAuth = await byError(/Expected status equals 401, but got 200/); // CC-API-02
    expect([noAuth.category, noAuth.owner]).toEqual(['missing_auth', 'app']);
    expect(noAuth.title).toBe('The API accepted a request it should have rejected (200 instead of 401)');

    const unknown = await byError(/Expected status equals 404, but got 204/); // CC-API-03
    expect([unknown.category, unknown.owner]).toEqual(['wrong_status', 'app']);
    expect(unknown.title).toBe('The API answered 204 No Content for something that does not exist');

    // DB layer.
    orphanId = await scenario('Deleting a patient removes their appointments', [
      ...login('admin'),
      {
        type: 'api.request',
        params: {
          method: 'DELETE',
          url: '/api/patients/1',
          auth: { type: 'bearer', token: '{{vars.token}}' },
        },
      },
      {
        type: 'db.query',
        params: { connection: 'clinic', sql: 'SELECT COUNT(*) AS n FROM appointments WHERE patient_id = 1' },
        assertions: [{ target: 'value', operator: 'equals', expected: 0 }],
      },
    ]);
    duplicateId = await scenario('The same patient cannot be registered twice', [
      ...login('reception'),
      {
        type: 'api.request',
        params: {
          method: 'POST',
          url: '/api/patients',
          auth: { type: 'bearer', token: '{{vars.token}}' },
          body: { full_name: 'Ana Lopez', dob: '1988-04-12', phone: '+1-555-201-0001' },
        },
        assertions: [{ target: 'status', operator: 'equals', expected: 409 }],
      },
    ]);
    const dbRun = await run({ type: 'scenarios', ids: [orphanId, duplicateId] });
    const orphan = await diagnosisOf(
      dbRun.items.find((i) => i.labelJson.scenario.startsWith('Deleting'))!.id,
    ); // CC-DB-01
    expect([orphan.category, orphan.owner]).toEqual(['data_integrity', 'app']);
    expect(orphan.title).toBe('The database holds 1 where 0 was expected');
    const dup = await diagnosisOf(dbRun.items.find((i) => i.labelJson.scenario.startsWith('The same'))!.id); // CC-DB-02
    expect([dup.category, dup.owner]).toEqual(['validation_missing', 'app']);
    expect(dup.title).toBe('The API accepted a duplicate (201 instead of 409 Conflict)');

    const bugs = await ok<
      { code: string; ownerHint: string; severity: string; occurrences: number; category: string }[]
    >('GET', `/api/applications/${appId}/bugs`);
    expect(bugs.map((b) => b.code).sort()).toEqual(['BUG-001', 'BUG-002', 'BUG-003', 'BUG-004', 'BUG-005']);
    expect(new Set(bugs.map((b) => b.ownerHint))).toEqual(new Set(['app']));
    expect(bugs.map((b) => b.category).sort()).toEqual([
      'data_integrity',
      'missing_auth',
      'schema_mismatch',
      'validation_missing',
      'wrong_status',
    ]);
  }, 120_000);

  it('counts repeated failures on the same bug and keeps a readable report', async () => {
    await run({ type: 'scenarios', ids: [duplicateId] });
    const bugs = await ok<
      {
        id: string;
        title: string;
        occurrences: number;
        stepsToReproduceJson: string[];
        expected: string;
        actual: string;
        environmentJson: { browser?: string; url: string };
      }[]
    >('GET', `/api/applications/${appId}/bugs`);
    expect(bugs).toHaveLength(5);
    const dup = bugs.find((b) => b.title.startsWith('The same patient'))!;
    expect(dup.occurrences).toBe(2);
    expect(dup.stepsToReproduceJson).toEqual([
      '1. Send POST /api/auth/login',
      '2. Read $.token from the response (save as token)',
      '3. Send POST /api/patients  ← fails here',
    ]);
    expect(dup.expected).toBe('status equals 409');
    expect(dup.actual).toBe('201 — Expected status equals 409, but got 201');
    expect(dup.environmentJson.url).toBe(clinicUrl);
    // Secrets never reach a bug.
    expect(JSON.stringify(bugs)).not.toContain('Admin123!');
    expect(JSON.stringify(bugs)).not.toContain('Reception123!');
  }, 60_000);

  it('exports bugs and run reports in every format, with the author on each', async () => {
    const bugs = await ok<{ id: string; code: string }[]>('GET', `/api/applications/${appId}/bugs`);
    const one = bugs[0]!;
    const html = await call('GET', `/api/bugs/${one.id}/export?format=html`);
    expect(html.headers['content-disposition']).toMatch(/attachment; filename="BUG-00\d-/);
    expect(html.body).toContain('Prepared by Md Zarin Tasnim');
    expect(html.body).toContain('StepForge by Md Zarin Tasnim');
    expect(html.body).toContain('Why (likely)');
    const md = await call('GET', `/api/bugs/${one.id}/export?format=md`);
    expect(md.body).toMatch(/^## BUG-00\d: /);
    expect(md.body).toContain('### Steps to reproduce');
    expect(md.body).toContain('_Prepared by Md Zarin Tasnim with StepForge by Md Zarin Tasnim._');
    const pdf = await call('GET', `/api/bugs/${one.id}/export?format=pdf`);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');

    const listPdf = await call('GET', `/api/applications/${appId}/bugs/export?format=pdf`);
    expect(listPdf.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
    const jira = await call('GET', `/api/applications/${appId}/bugs/export?format=jira`);
    expect(jira.body.replace(/^\uFEFF/, '').split('\r\n')[0]).toBe(
      'Summary,Issue Type,Priority,Description,Labels,Severity,Status,External ID',
    );
    const trello = await call('GET', `/api/applications/${appId}/bugs/export?format=trello`);
    expect(trello.body.replace(/^\uFEFF/, '').split('\r\n')[0]).toBe(
      'Card Name,Card Description,Labels,List',
    );
    const xlsx = await call('GET', `/api/applications/${appId}/bugs/export?format=xlsx`);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(xlsx.rawPayload as never);
    expect(wb.creator).toBe('Md Zarin Tasnim');
    expect(wb.getWorksheet('Bugs')!.rowCount).toBe(6);
    expect(wb.getWorksheet('About')!.getCell('B2').value).toBe('Md Zarin Tasnim');

    const runs = await ok<{ id: string }[]>('GET', `/api/runs?applicationId=${appId}`);
    const report = await call('GET', `/api/runs/${runs[0]!.id}/report?format=html`);
    expect(report.body).toContain('Run report — CareClinic');
    expect(report.body).toContain('Prepared by Md Zarin Tasnim');
    expect(report.body).toContain('The API accepted a duplicate');
    expect(
      (await call('GET', `/api/runs/${runs[0]!.id}/report?format=pdf`)).rawPayload.subarray(0, 5).toString(),
    ).toBe('%PDF-');
    expect(
      (await call('GET', `/api/runs/${runs[0]!.id}/report?format=xlsx`)).rawPayload.subarray(0, 2).toString(),
    ).toBe('PK');

    // The author can be changed in Settings; the StepForge credit stays.
    await ok('PUT', '/api/settings/reportBranding', {
      value: { author: 'QA Team', company: 'Acme Health', accent: '#6366F1' },
    });
    const branded = await call('GET', `/api/bugs/${one.id}/export?format=html`);
    expect(branded.body).toContain('Prepared by QA Team · Acme Health');
    expect(branded.body).toContain('StepForge by Md Zarin Tasnim');
    await ok('PUT', '/api/settings/reportBranding', {
      value: { author: 'Md Zarin Tasnim', company: '', accent: '#F97316' },
    });
  }, 120_000);
});

describe('UI diagnosis', () => {
  it('suggests the new locator when the element changed, and fixes the step in one click', async () => {
    const id = await scenario('Save a new patient', [
      { type: 'ui.navigate', params: { url: '/login' } },
      {
        type: 'ui.fill',
        params: { value: 'reception@careclinic.test' },
        locators: [{ strategy: 'label', value: 'Email' }],
      },
      {
        type: 'ui.fill',
        params: { value: '{{secret.password}}' },
        locators: [{ strategy: 'testId', value: 'password' }],
      },
      { type: 'ui.click', locators: [{ strategy: 'role', value: 'button', name: 'Sign in' }] },
      { type: 'ui.navigate', params: { url: '/patients/new' } },
      // Recorded when the button said "Store patient" and had a different test id.
      {
        type: 'ui.click',
        timeoutMs: 2000,
        locators: [
          { strategy: 'testId', value: 'store-patient-btn' },
          { strategy: 'role', value: 'button', name: 'Store patient' },
        ],
      },
    ]);
    const r = await run({ type: 'scenarios', ids: [id] });
    const item = r.items[0]!;
    expect(item.status).toBe('failed');
    const d = await diagnosisOf(item.id);
    expect(d.category).toBe('locator_changed');
    expect(d.suggestedLocator).toEqual({ strategy: 'testId', value: 'save-patient' });
    expect(d.title).toContain('testId=save-patient');

    const detail = await ok<{ steps: { stepId: string; status: string; screenshotPath: string | null }[] }>(
      'GET',
      `/api/run-items/${item.id}`,
    );
    const failedStep = detail.steps.find((s) => s.status === 'failed')!;
    expect(failedStep.screenshotPath).toMatch(/-failed\.png$/);
    await ok('POST', `/api/run-items/${item.id}/accept-locator`, {
      stepId: failedStep.stepId,
      locator: d.suggestedLocator,
    });
    const again = await run({ type: 'scenarios', ids: [id] });
    expect(again.items[0]!.status).toBe('passed');
  }, 120_000);
});
