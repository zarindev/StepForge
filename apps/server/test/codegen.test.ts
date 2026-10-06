import { TARGETS } from '@stepforge/codegen';
import type { FastifyInstance } from 'fastify';
import JSZip from 'jszip';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { H, testServer } from './helpers.ts';

const SECRET_VALUE = 'Reception123!-never-in-code';
let app: FastifyInstance;
let appId = '';

async function call(method: string, url: string, payload?: unknown) {
  return app.inject({
    method: method as 'GET',
    url,
    headers: H,
    ...(payload !== undefined && { payload: payload as object }),
  });
}
async function ok<T = Record<string, unknown>>(method: string, url: string, payload?: unknown): Promise<T> {
  const res = await call(method, url, payload);
  if (res.statusCode >= 300) throw new Error(`${method} ${url} → ${res.statusCode}: ${res.body}`);
  return res.json() as T;
}

beforeAll(async () => {
  ({ app } = await testServer());
  // The CareClinic suite used by the exported-code CI check.
  const suite = JSON.parse(
    readFileSync(
      resolve(import.meta.dirname, '../../../demo/clinic-app/stepforge/codegen-suite.json'),
      'utf8',
    ),
  );
  appId = (await ok<{ applicationId: string }>('POST', '/api/applications/import', suite)).applicationId;
  const env = (await ok<{ id: string }[]>('GET', `/api/applications/${appId}/environments`))[0]!;
  await ok('PUT', `/api/environments/${env.id}/secrets`, { key: 'password', value: SECRET_VALUE });
});
afterAll(async () => {
  await app.close();
});

describe('code export', () => {
  it('lists the targets', async () => {
    const targets = await ok<{ id: string }[]>('GET', '/api/codegen/targets');
    expect(targets.map((t) => t.id)).toEqual(TARGETS.map((t) => t.id));
    expect(targets).toHaveLength(13);
  });

  it('previews a Playwright project with warnings', async () => {
    const p = await ok<{
      files: { path: string; content?: string }[];
      warnings: { message: string }[];
      scenarios: number;
      run: string;
    }>('POST', `/api/applications/${appId}/codegen/preview`, { target: 'playwright-ts', ci: ['github'] });
    expect(p.scenarios).toBe(4);
    expect(p.files.map((f) => f.path)).toEqual(
      expect.arrayContaining([
        'playwright.config.ts',
        'tests/patients/register-a-patient.spec.ts',
        '.github/workflows/stepforge-tests.yml',
        'README.md',
      ]),
    );
    expect(p.files.find((f) => f.path === '.env.example')!.content).toContain('PASSWORD=\n');
    expect(p.warnings.map((w) => w.message)).toEqual([
      expect.stringContaining('the "clinic" connection is not set up'),
    ]);
    expect(p.run).toContain('npx playwright test');
  });

  it('never writes a secret value into any target', async () => {
    for (const t of TARGETS) {
      const res = await call('POST', `/api/applications/${appId}/codegen/download`, {
        target: t.id,
        pom: t.pom,
        ci: t.ci ? ['github', 'gitlab'] : [],
      });
      expect(res.statusCode, t.id).toBe(200);
      const body = res.rawPayload;
      if (res.headers['content-type'] === 'application/zip') {
        const zip = await JSZip.loadAsync(body);
        for (const f of Object.values(zip.files))
          if (!f.dir) expect(await f.async('string'), `${t.id}:${f.name}`).not.toContain(SECRET_VALUE);
      } else expect(body.toString('latin1'), t.id).not.toContain(SECRET_VALUE);
    }
  }, 60_000);

  it('downloads a zip, records the export and serves it again', async () => {
    const res = await call('POST', `/api/applications/${appId}/codegen/download`, {
      target: 'cypress-js',
      scope: {
        type: 'module',
        id: (
          await ok<{ modules: { id: string; name: string }[] }>('GET', `/api/applications/${appId}/tree`)
        ).modules.find((m) => m.name === 'API')!.id,
      },
    });
    expect(res.headers['content-disposition']).toBe('attachment; filename="careclinic-cypress-js.zip"');
    const zip = await JSZip.loadAsync(res.rawPayload);
    const specs = Object.keys(zip.files).filter((f) => f.endsWith('.cy.js'));
    expect(specs).toEqual([
      'careclinic-cypress-js/cypress/e2e/api/create-a-patient-through-the-api.cy.js',
      'careclinic-cypress-js/cypress/e2e/api/health-and-rejected-logins.cy.js',
    ]);
    const list = await ok<
      { id: string; kind: string; optionsJson: { scenarios: number; filename: string } }[]
    >('GET', `/api/exports?applicationId=${appId}`);
    expect(list[0]).toMatchObject({
      kind: 'cypress-js',
      optionsJson: { scenarios: 2, filename: 'careclinic-cypress-js.zip' },
    });
    const again = await call('GET', `/api/exports/${list[0]!.id}/file`);
    expect(again.statusCode).toBe(200);
    expect(again.rawPayload.equals(res.rawPayload)).toBe(true);
    // A document downloads as the file itself.
    const xlsx = await call('POST', `/api/applications/${appId}/codegen/download`, { target: 'docs-xlsx' });
    expect(xlsx.headers['content-disposition']).toBe('attachment; filename="careclinic-test-cases.xlsx"');
    expect(xlsx.rawPayload.subarray(0, 2).toString()).toBe('PK');
  });

  it('rejects unknown targets and empty selections', async () => {
    expect(
      (await call('POST', `/api/applications/${appId}/codegen/preview`, { target: 'robot' })).statusCode,
    ).toBe(400);
    const empty = await call('POST', `/api/applications/${appId}/codegen/preview`, {
      target: 'k6',
      scope: { type: 'tag', id: 'nope' },
    });
    expect(empty.statusCode).toBe(400);
    expect(empty.json().message).toBe('No scenarios match this selection');
  });
});
