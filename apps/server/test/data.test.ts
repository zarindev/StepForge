import { createClinicApp } from '@stepforge/demo-clinic';
import type { FastifyInstance } from 'fastify';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseCsv } from '../src/data/service.ts';
import type { AppContext } from '../src/context.ts';
import { H, testServer } from './helpers.ts';

/** The test data library: table, CSV, SQL and API sources read by util.useData. */
let app: FastifyInstance;
let ctx: AppContext;
let clinic: ReturnType<typeof createClinicApp>;
const dir = mkdtempSync(join(tmpdir(), 'sf-data-'));
const clinicDb = join(dir, 'clinic.db');
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
type Item = {
  id: string;
  status: string;
  errorMessage: string | null;
  labelJson: { scenario: string; testCaseCode?: string };
};
async function run(ids: string[]) {
  const r = await ok<{ id: string }>('POST', '/api/runs', {
    applicationId: appId,
    environmentId: envId,
    scope: { type: 'scenarios', ids },
    options: { video: 'off', trace: 'off', screenshots: 'off' },
  });
  await ctx.runs.idle();
  return ok<{ items: Item[] }>('GET', `/api/runs/${r.id}`);
}
const steps = async (itemId: string) =>
  (
    await ok<{ steps: { type: string; status: string; message: string | null }[] }>(
      'GET',
      `/api/run-items/${itemId}`,
    )
  ).steps;
const scenario = (name: string, s: unknown[], extra: Record<string, unknown> = {}) =>
  ok<{ id: string }>('POST', `/api/modules/${moduleId}/scenarios`, { name, steps: s, ...extra });
const log = (message: string) => ({ type: 'util.log', params: { message } });
const use = (source: string, params: Record<string, unknown> = {}, assertions: unknown[] = []) => ({
  type: 'util.useData',
  params: { source, ...params },
  assertions,
});

beforeAll(async () => {
  ({ app, ctx } = await testServer({ dataDir: dir }));
  clinic = createClinicApp({ dbFile: clinicDb });
  await clinic.listen({ host: '127.0.0.1', port: 0 });
  const clinicUrl = `http://127.0.0.1:${(clinic.server.address() as { port: number }).port}`;
  appId = (await ok('POST', '/api/applications', { name: 'CareClinic', slug: 'careclinic-data' })).id;
  envId = (await ok('POST', `/api/applications/${appId}/environments`, { name: 'Local', baseUrl: clinicUrl }))
    .id;
  await ok('POST', `/api/environments/${envId}/connections`, {
    name: 'clinic',
    engine: 'sqlite',
    database: clinicDb,
  });
  moduleId = (await ok('POST', `/api/applications/${appId}/modules`, { name: 'Data' })).id;
}, 30_000);
afterAll(async () => {
  await app.close();
  await clinic.close();
});

describe('test data library', () => {
  it('parses CSV with quotes, commas and line breaks inside quotes', () => {
    expect(parseCsv('﻿name,city\r\n"Lopez, Ana","New\nYork"\nBen,"say ""hi"""\n\n')).toEqual({
      columns: ['name', 'city'],
      rows: [
        { name: 'Lopez, Ana', city: 'New\nYork' },
        { name: 'Ben', city: 'say "hi"' },
      ],
    });
  });

  it('validates sources: names, columns, kinds, unique names', async () => {
    const bad = [
      { name: '1st', kind: 'table', columns: ['a'] },
      { name: 'Empty', kind: 'table', columns: [] },
      { name: 'NoPath', kind: 'csv', config: { path: '' } },
      { name: 'NoQuery', kind: 'sql', config: { connection: 'clinic', query: '' } },
      { name: 'Weird', kind: 'excel' },
    ];
    for (const b of bad)
      expect((await call('POST', `/api/applications/${appId}/data-sources`, b)).statusCode).toBe(400);
    await ok('POST', `/api/applications/${appId}/data-sources`, {
      name: 'users',
      kind: 'table',
      columns: ['email', 'role', 'extra'],
      rows: [
        { email: 'ana@x.test', role: 'admin', ignored: 'dropped' },
        { email: 'ben@x.test', role: 'reception' },
      ],
    });
    expect(
      (
        await call('POST', `/api/applications/${appId}/data-sources`, {
          name: 'users',
          kind: 'table',
          columns: ['x'],
        })
      ).statusCode,
    ).toBe(400);
    const preview = await ok<{ columns: string[]; rows: Record<string, string>[]; total: number }>(
      'POST',
      `/api/data-sources/${(await ok<{ id: string; name: string }[]>('GET', `/api/applications/${appId}/data-sources`))[0]!.id}/preview`,
      { environmentId: envId },
    );
    expect(preview.columns).toEqual(['email', 'role', 'extra']);
    expect(preview.rows[0]).toEqual({ email: 'ana@x.test', role: 'admin', extra: '' }); // only declared columns, as text
    expect(preview.total).toBe(2);
  });

  it('picks rows from a table: first, a given row, a matching value, random; the row becomes vars', async () => {
    const s = await scenario('Reads users', [
      use('users', {}, [{ target: 'role', operator: 'equals', expected: 'admin' }]),
      log('first: {{vars.users.email}}'),
      use('users', { pick: 'row', row: 2, as: 'second' }),
      log('row 2: {{vars.second.email}}'),
      use('users', { pick: 'match', column: 'role', equals: 'reception', as: 'desk' }),
      log('match: {{vars.desk.email}}'),
      use('users', { pick: 'random', as: 'any' }),
      log('random: {{vars.any.role}}'),
    ]);
    const r = await run([s.id]);
    expect(r.items[0]!.status).toBe('passed');
    const st = await steps(r.items[0]!.id);
    expect(
      st
        .filter((x) => x.type === 'util.log')
        .map((x) => x.message?.split(': ')[0] + ': ' + x.message?.split(': ')[1]),
    ).toEqual([
      'first: ana@x.test',
      'row 2: ben@x.test',
      'match: ben@x.test',
      expect.stringMatching(/^random: (admin|reception)$/),
    ]);
    expect(st[0]!.message).toBe('Row 1 of 2 from "users" → vars.users');

    const missing = await scenario('Asks for things that are not there', [
      use('users', { pick: 'row', row: 5 }),
    ]);
    const nomatch = await scenario('No matching row', [
      use('users', { pick: 'match', column: 'role', equals: 'nurse' }),
    ]);
    const unknown = await scenario('Unknown source', [use('patients')]);
    const bad = await run([missing.id, nomatch.id, unknown.id]);
    const msg = (n: string) => bad.items.find((i) => i.labelJson.scenario === n)!.errorMessage;
    expect(msg('Asks for things that are not there')).toMatch(/Row 5 does not exist: "users" has 2 rows/);
    expect(msg('No matching row')).toMatch(/No row of "users" has role = "nurse"/);
    expect(msg('Unknown source')).toMatch(/No data source named "patients" \(known: users\)/);
  }, 60_000);

  it('"not used yet" hands each test case a different row, across the run', async () => {
    const s = await scenario('One user per test case', [
      use('users', { pick: 'unused', as: 'u' }),
      log('{{vars.u.email}}'),
    ]);
    for (const code of ['A', 'B', 'C'])
      await ok('POST', `/api/scenarios/${s.id}/test-cases`, { title: `Case ${code}` });
    const r = await run([s.id]);
    const statuses = r.items.map((i) => i.status);
    expect(statuses.filter((x) => x === 'passed')).toHaveLength(2);
    const failed = r.items.find((i) => i.status === 'failed')!;
    expect(failed.errorMessage).toMatch(/All 2 rows of "users" were already used in this run/);
    const emails = await Promise.all(
      r.items
        .filter((i) => i.status === 'passed')
        .map(async (i) => (await steps(i.id)).find((x) => x.type === 'util.log')!.message),
    );
    expect(new Set(emails)).toEqual(new Set(['ana@x.test', 'ben@x.test']));
  }, 60_000);

  it('reads CSV files, SQL queries (read-only) and API responses', async () => {
    writeFileSync(join(dir, 'cities.csv'), 'city,country\n"Paris, FR",France\nBerlin,Germany\n');
    await ok('POST', `/api/applications/${appId}/data-sources`, {
      name: 'cities',
      kind: 'csv',
      config: { path: 'cities.csv' },
    });
    await ok('POST', `/api/applications/${appId}/data-sources`, {
      name: 'patients',
      kind: 'sql',
      config: { connection: 'clinic', query: 'SELECT full_name, phone FROM patients ORDER BY id' },
    });
    await ok('POST', `/api/applications/${appId}/data-sources`, {
      name: 'api tags',
      kind: 'api',
      config: { url: '/api/openapi.json', rowsPath: '$.tags[*]' },
    });
    const s = await scenario('Reads every kind', [
      use('cities', { pick: 'match', column: 'country', equals: 'France' }, [
        { target: 'city', operator: 'equals', expected: 'Paris, FR' },
      ]),
      use('patients', {}, [{ target: 'full_name', operator: 'equals', expected: 'Ana Lopez' }]),
      use('api tags', { pick: 'row', row: 2 }, [
        { target: 'name', operator: 'equals', expected: 'Patients' },
      ]),
      log('{{vars.cities.city}} / {{vars.patients.full_name}} / {{vars.apiTags.name}}'),
    ]);
    const r = await run([s.id]);
    expect(r.items[0]!.errorMessage).toBeNull();
    expect((await steps(r.items[0]!.id)).at(-1)!.message).toBe('Paris, FR / Ana Lopez / Patients');

    // A SQL source can never write, even on a connection that allows writes.
    await ok('POST', `/api/applications/${appId}/data-sources`, {
      name: 'sneaky',
      kind: 'sql',
      config: { connection: 'clinic', query: "UPDATE patients SET full_name = 'X'" },
    });
    const w = await run([(await scenario('Write attempt', [use('sneaky')])).id]);
    expect(w.items[0]!.status).not.toBe('passed');
    const list = await ok<{ name: string; usedBySteps: number }[]>(
      'GET',
      `/api/applications/${appId}/data-sources`,
    );
    expect(list.find((d) => d.name === 'users')!.usedBySteps).toBeGreaterThanOrEqual(7);
    const sqlPreview = await ok<{ total: number }>(
      'POST',
      `/api/data-sources/${(list as unknown as { id: string; name: string }[]).find((d) => d.name === 'patients')!.id}/preview`,
      { environmentId: envId },
    );
    expect(sqlPreview.total).toBeGreaterThan(0);
  }, 60_000);

  it('travels with application export/import; exported code marks the step', async () => {
    const exported = await ok<{ datasets: { name: string; kind: string }[] }>(
      'GET',
      `/api/applications/${appId}/export`,
    );
    expect(exported.datasets.map((d) => `${d.name}:${d.kind}`)).toEqual(
      expect.arrayContaining(['users:table', 'cities:csv', 'patients:sql', 'api tags:api']),
    );
    const imported = await ok<{ applicationId: string }>(
      'POST',
      '/api/applications/import?slug=careclinic-data-copy',
      exported,
    );
    const copy = await ok<{ name: string; kind: string; configJson: { query?: string } }[]>(
      'GET',
      `/api/applications/${imported.applicationId}/data-sources`,
    );
    expect(copy.find((d) => d.name === 'patients')).toMatchObject({
      kind: 'sql',
      configJson: { query: expect.stringContaining('SELECT') },
    });

    const tree = await ok<{ scenarios: { id: string; name: string }[] }>(
      'GET',
      `/api/applications/${appId}/tree`,
    );
    const preview = await ok<{ warnings: { message: string }[] }>(
      'POST',
      `/api/applications/${appId}/codegen/preview`,
      {
        target: 'playwright-ts',
        scope: { type: 'scenarios', ids: [tree.scenarios.find((s) => s.name === 'Reads users')!.id] },
      },
    );
    expect(preview.warnings.map((w) => w.message).join(' ')).toMatch(
      /test data source "users" are read by StepForge at run time/,
    );
  });
});
