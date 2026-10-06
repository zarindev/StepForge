import { createClinicApp } from '@stepforge/demo-clinic';
import { schema } from '@stepforge/db';
import * as repo from '@stepforge/db/repos';
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
const clinicDb = join(mkdtempSync(join(tmpdir(), 'sf-clinic-')), 'clinic.db');
let appId = '';
let envId = '';
let connId = '';
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

beforeAll(async () => {
  ({ app, ctx } = await testServer());
  clinic = createClinicApp({ dbFile: clinicDb });
  await clinic.listen({ host: '127.0.0.1', port: 0 });
  clinicUrl = `http://127.0.0.1:${(clinic.server.address() as { port: number }).port}`;
  appId = (await ok('POST', '/api/applications', { name: 'CareClinic', slug: 'careclinic' })).id;
  envId = (await ok('POST', `/api/applications/${appId}/environments`, { name: 'Local', baseUrl: clinicUrl }))
    .id;
  await ok('PUT', `/api/environments/${envId}/secrets`, { key: 'password', value: 'Reception123!' });
  await ok('PUT', `/api/environments/${envId}/secrets`, { key: 'adminPassword', value: 'Admin123!' });
  moduleId = (await ok('POST', `/api/applications/${appId}/modules`, { name: 'Data' })).id;
}, 30_000);

afterAll(async () => {
  await app.close();
  await clinic.close();
});

async function runScenario(name: string, steps: unknown[], data?: Record<string, unknown>) {
  const s = await ok<{ id: string }>('POST', `/api/modules/${moduleId}/scenarios`, { name, steps });
  if (data) await ok('POST', `/api/scenarios/${s.id}/test-cases`, { title: name, data });
  const run = await ok<{ id: string }>('POST', '/api/runs', {
    applicationId: appId,
    environmentId: envId,
    scope: { type: 'scenarios', ids: [s.id] },
  });
  await ctx.runs.idle();
  const done = await ok<{ items: { id: string; status: string; errorMessage: string | null }[] }>(
    'GET',
    `/api/runs/${run.id}`,
  );
  const item = done.items[0]!;
  const detail = await ok<{
    steps: {
      type: string;
      status: string;
      message: string | null;
      queryJson: Record<string, unknown> | null;
    }[];
  }>('GET', `/api/run-items/${item.id}`);
  return { ...item, steps: detail.steps };
}

describe('database connections', () => {
  it('stores connections per environment without ever returning the password', async () => {
    const created = await ok<Record<string, unknown> & { id: string }>(
      'POST',
      `/api/environments/${envId}/connections`,
      {
        name: 'warehouse',
        engine: 'pg',
        host: 'db.internal',
        port: 5432,
        database: 'wh',
        username: 'qa',
        password: 'S3cret-PG!',
      },
    );
    expect(created).toMatchObject({
      readOnly: true,
      rollbackMode: true,
      hasPassword: true,
      environmentName: 'Local',
    });
    const list = await call('GET', `/api/applications/${appId}/connections`);
    expect(list.body).not.toContain('S3cret-PG!');
    expect(JSON.stringify(created)).not.toContain('S3cret-PG!');
    // The password is encrypted at rest and hidden from the environment's secret list.
    const stored = ctx.db.select().from(schema.secrets).all();
    expect(JSON.stringify(stored)).not.toContain('S3cret-PG!');
    expect(
      (await ok<{ key: string }[]>('GET', `/api/environments/${envId}/secrets`)).map((s) => s.key),
    ).toEqual(['adminPassword', 'password']);
    expect(repo.resolveConnection(ctx.db, ctx.masterKey, created.id).password).toBe('S3cret-PG!');

    // Names are unique per environment, and the password survives edits unless replaced.
    expect(
      (await call('POST', `/api/environments/${envId}/connections`, { name: 'warehouse', engine: 'pg' }))
        .statusCode,
    ).toBe(409);
    await ok('PATCH', `/api/connections/${created.id}`, { host: 'db2.internal' });
    expect(repo.resolveConnection(ctx.db, ctx.masterKey, created.id).password).toBe('S3cret-PG!');
    await ok('PATCH', `/api/connections/${created.id}`, { password: null });
    expect((await ok('GET', `/api/connections/${created.id}`)).hasPassword).toBe(false);

    await ok('PATCH', `/api/connections/${created.id}`, { password: 'again' });
    const before = ctx.db.select().from(schema.secrets).all().length;
    expect((await call('DELETE', `/api/connections/${created.id}`)).statusCode).toBe(204);
    expect(ctx.db.select().from(schema.secrets).all().length).toBe(before - 1);
  });

  it('removes connection passwords when their environment is deleted', async () => {
    const env = await ok('POST', `/api/applications/${appId}/environments`, {
      name: 'Temp',
      baseUrl: clinicUrl,
    });
    await ok('POST', `/api/environments/${env.id}/connections`, {
      name: 'tmp',
      engine: 'mysql',
      password: 'pw-temp',
    });
    const before = ctx.db.select().from(schema.secrets).all().length;
    await ok('DELETE', `/api/environments/${env.id}`);
    expect(ctx.db.select().from(schema.secrets).all().length).toBe(before - 1);
  });

  it('refuses a SQLite connection to StepForge’s own database', () => {
    expect(() =>
      repo.createConnection(
        ctx.db,
        ctx.masterKey,
        envId,
        { name: 'self', engine: 'sqlite', database: '/x/stepforge.db' },
        '/x/stepforge.db',
      ),
    ).toThrow(/own database/);
  });

  it('tests a draft, then browses the schema of the saved connection', async () => {
    const bad = await ok<{ ok: boolean; message: string }>(
      'POST',
      `/api/environments/${envId}/connections/test`,
      {
        name: 'clinic',
        engine: 'sqlite',
        database: join(tmpdir(), 'nope', 'missing.db'),
      },
    );
    expect(bad).toMatchObject({ ok: false });
    expect(bad.message).toMatch(/not found/);
    const good = await ok<{ ok: boolean; message: string }>(
      'POST',
      `/api/environments/${envId}/connections/test`,
      {
        name: 'clinic',
        engine: 'sqlite',
        database: clinicDb,
      },
    );
    expect(good).toMatchObject({ ok: true, message: expect.stringMatching(/6 tables/) });

    connId = (
      await ok('POST', `/api/environments/${envId}/connections`, {
        name: 'clinic',
        engine: 'sqlite',
        database: clinicDb,
      })
    ).id;
    const s = await ok<{
      tables: { name: string; columns: { name: string }[]; foreignKeys: { column: string }[] }[];
    }>('GET', `/api/connections/${connId}/schema`);
    const appointments = s.tables.find((t) => t.name === 'appointments')!;
    expect(appointments.columns.map((c) => c.name)).toContain('patient_id');
    expect(appointments.foreignKeys.map((f) => f.column)).toEqual(['doctor_id']);
  });
});

describe('SQL workbench', () => {
  it('runs reads, blocks writes on read-only connections and rolls back in rollback mode', async () => {
    const r = await ok<{ rows: { full_name: string }[]; columns: string[]; write: boolean }>(
      'POST',
      `/api/connections/${connId}/query`,
      { sql: 'SELECT full_name FROM patients WHERE id <= ? ORDER BY id', params: [2] },
    );
    expect(r).toMatchObject({
      columns: ['full_name'],
      write: false,
      rows: [{ full_name: 'Ana Lopez' }, { full_name: 'Ben Carter' }],
    });

    const blocked = await call('POST', `/api/connections/${connId}/query`, {
      sql: 'DELETE FROM appointments',
    });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().message).toMatch(/read-only/);

    await ok('PATCH', `/api/connections/${connId}`, { readOnly: false });
    const del = await ok<{ affected: number; rolledBack: boolean }>(
      'POST',
      `/api/connections/${connId}/query`,
      {
        sql: 'DELETE FROM appointments',
      },
    );
    expect(del).toMatchObject({ affected: 2, rolledBack: true });
    expect(
      (
        await ok<{ rows: { n: number }[] }>('POST', `/api/connections/${connId}/query`, {
          sql: 'SELECT COUNT(*) n FROM appointments',
        })
      ).rows[0]!.n,
    ).toBe(2);

    const syntax = await call('POST', `/api/connections/${connId}/query`, { sql: 'SELEC 1' });
    expect(syntax.statusCode).toBe(422);
    await ok('PATCH', `/api/connections/${connId}`, { readOnly: true });
  });

  it('asks for the application name before writing on a production environment', async () => {
    const prod = await ok('POST', `/api/applications/${appId}/environments`, {
      name: 'Production',
      baseUrl: clinicUrl,
      isProduction: true,
    });
    const c = await ok('POST', `/api/environments/${prod.id}/connections`, {
      name: 'clinic',
      engine: 'sqlite',
      database: clinicDb,
      readOnly: false,
      rollbackMode: false,
    });
    expect(c.isProduction).toBe(true);
    const sql = 'UPDATE doctors SET fee = fee WHERE id = 0';
    const refused = await call('POST', `/api/connections/${c.id}/query`, { sql });
    expect(refused.statusCode).toBe(403);
    expect(refused.json().message).toMatch(/Type the application name \("CareClinic"\)/);
    expect(
      (await call('POST', `/api/connections/${c.id}/query`, { sql, confirm: 'careclinic' })).statusCode,
    ).toBe(403);
    expect((await ok('POST', `/api/connections/${c.id}/query`, { sql, confirm: 'CareClinic' })).write).toBe(
      true,
    );
    await ok('DELETE', `/api/environments/${prod.id}`, { confirm: 'CareClinic' });
  });

  it('audits data quality and finds orphans left by deleting a patient', async () => {
    const clean = await ok<{ findings: unknown[]; coverage: unknown[] }>(
      'POST',
      `/api/connections/${connId}/audit`,
      {},
    );
    expect(clean.findings).toEqual([]);
    expect(clean.coverage.length).toBeGreaterThan(3);

    const login = await fetch(`${clinicUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'admin@careclinic.test', password: 'Admin123!' }),
    });
    const { token } = (await login.json()) as { token: string };
    await fetch(`${clinicUrl}/api/patients/1`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${token}` },
    });

    const after = await ok<{
      findings: { check: string; table: string; columns: string[]; count: number; sql: string }[];
    }>('POST', `/api/connections/${connId}/audit`, { checks: ['orphans'] });
    expect(after.findings).toMatchObject([
      { check: 'orphans', table: 'appointments', columns: ['patient_id'], count: 1 },
    ]);
    await fetch(`${clinicUrl}/api/reset`, { method: 'POST' });
  });
});

describe('database steps in runs', () => {
  it('passes a hybrid UI + API + DB scenario', async () => {
    const r = await runScenario(
      'Register a patient and verify it end to end',
      [
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
        {
          type: 'ui.fill',
          params: { value: '{{data.full_name}}' },
          locators: [{ strategy: 'label', value: 'Full name' }],
        },
        {
          type: 'ui.fill',
          params: { value: '{{data.dob}}' },
          locators: [{ strategy: 'label', value: 'Date of birth' }],
        },
        {
          type: 'ui.fill',
          params: { value: '{{data.phone}}' },
          locators: [{ strategy: 'label', value: 'Phone' }],
        },
        { type: 'ui.click', locators: [{ strategy: 'testId', value: 'save-patient' }] },
        {
          type: 'db.query',
          label: 'The patient row was written correctly',
          params: {
            connection: 'clinic',
            sql: 'SELECT * FROM patients WHERE full_name = ?',
            params: ['{{data.full_name}}'],
          },
          assertions: [
            { target: 'rowCount', operator: 'equals', expected: 1 },
            { target: 'phone', operator: 'equals', expected: '{{data.phone}}' },
            { target: 'dob', operator: 'equals', expected: '{{data.dob}}' },
            { target: 'code', operator: 'matches', expected: '^PAT-\\d{4}$' },
          ],
        },
        { type: 'db.extract', params: { path: 'code' }, captureAs: 'code' },
        {
          type: 'api.request',
          params: {
            method: 'POST',
            url: '/api/auth/login',
            body: { email: 'reception@careclinic.test', password: '{{secret.password}}' },
          },
        },
        { type: 'api.extract', params: { path: '$.token' }, captureAs: 'token' },
        {
          type: 'api.request',
          params: {
            url: '/api/patients',
            query: { q: '{{vars.code}}' },
            auth: { type: 'bearer', token: '{{vars.token}}' },
          },
          assertions: [{ target: '$[0].full_name', operator: 'equals', expected: '{{data.full_name}}' }],
        },
        {
          type: 'db.query',
          label: 'Codes stay unique',
          params: { connection: 'clinic', sql: 'SELECT code FROM patients' },
          assertions: [
            { target: 'column:code', operator: 'unique' },
            { target: 'column:code', operator: 'noNulls' },
          ],
        },
      ],
      { full_name: 'Grace Hopper', dob: '1985-12-09', phone: '+1-555-201-0099' },
    );
    expect(r.errorMessage).toBeNull();
    expect(r.status).toBe('passed');
    const q = r.steps.find((s) => s.type === 'db.query')!.queryJson!;
    expect(q).toMatchObject({ connection: 'clinic', engine: 'sqlite', rowCount: 1, readOnly: true });
    // Secrets used in the scenario never reach stored results.
    expect(JSON.stringify(r.steps)).not.toContain('Reception123!');
    await fetch(`${clinicUrl}/api/reset`, { method: 'POST' });
  }, 60_000);

  it('catches orphaned appointments after a patient is deleted', async () => {
    const r = await runScenario('Deleting a patient removes their appointments', [
      {
        type: 'api.request',
        params: {
          method: 'POST',
          url: '/api/auth/login',
          body: { email: 'admin@careclinic.test', password: '{{secret.adminPassword}}' },
        },
      },
      { type: 'api.extract', params: { path: '$.token' }, captureAs: 'token' },
      {
        type: 'api.request',
        params: {
          method: 'DELETE',
          url: '/api/patients/1',
          auth: { type: 'bearer', token: '{{vars.token}}' },
        },
        assertions: [{ target: 'status', operator: 'equals', expected: 204 }],
      },
      {
        type: 'db.query',
        params: { connection: 'clinic', sql: 'SELECT COUNT(*) AS n FROM appointments WHERE patient_id = 1' },
        assertions: [
          {
            target: 'value',
            operator: 'equals',
            expected: 0,
            message: 'Appointments of the deleted patient are still there',
          },
        ],
      },
    ]);
    expect(r.status).toBe('failed');
    expect(r.errorMessage).toMatch(/Appointments of the deleted patient are still there/);
    await fetch(`${clinicUrl}/api/reset`, { method: 'POST' });
  });

  it('catches duplicate patient registrations', async () => {
    const register = {
      type: 'api.request',
      params: {
        method: 'POST',
        url: '/api/patients',
        auth: { type: 'bearer', token: '{{vars.token}}' },
        body: { full_name: 'Ana Lopez', dob: '1988-04-12', phone: '+1-555-201-0001' },
      },
      continueOnFail: true,
      assertions: [{ target: 'status', operator: 'equals', expected: 409 }],
    };
    const r = await runScenario('The same patient cannot be registered twice', [
      {
        type: 'api.request',
        params: {
          method: 'POST',
          url: '/api/auth/login',
          body: { email: 'reception@careclinic.test', password: '{{secret.password}}' },
        },
      },
      { type: 'api.extract', params: { path: '$.token' }, captureAs: 'token' },
      register,
      {
        type: 'db.query',
        params: {
          connection: 'clinic',
          sql: "SELECT COUNT(*) AS n FROM patients WHERE full_name = 'Ana Lopez' AND dob = '1988-04-12'",
        },
        assertions: [{ target: 'value', operator: 'equals', expected: 1 }],
        continueOnFail: true,
      },
      {
        type: 'db.dataQualityCheck',
        params: { connection: 'clinic', tables: ['patients'], checks: ['duplicates'] },
      },
    ]);
    expect(r.status).toBe('failed');
    expect(r.steps.map((s) => s.status)).toEqual(['passed', 'passed', 'failed', 'failed', 'failed']);
    expect(r.steps[4]!.message).toMatch(/duplicate value of \((phone|full_name, dob)\) in patients/);
    await fetch(`${clinicUrl}/api/reset`, { method: 'POST' });
  });

  it('reports a missing connection as a broken test', async () => {
    const r = await runScenario('Unknown connection', [
      { type: 'db.query', params: { connection: 'reporting', sql: 'SELECT 1' } },
    ]);
    expect(r.status).toBe('broken');
    expect(r.errorMessage).toMatch(/No database connection named "reporting" in the Local environment/);
  });
});
