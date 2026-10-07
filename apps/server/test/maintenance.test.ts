import { schema } from '@stepforge/db';
import * as repo from '@stepforge/db/repos';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AppContext } from '../src/context.ts';
import { H, testServer } from './helpers.ts';

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
  ({ app, ctx } = await testServer());
});
afterAll(async () => {
  await app.close();
});

/** A finished run with one passed and one failed item, each with a screenshot file on disk. */
function seedRun(appId: string, envId: string, finishedAt: string) {
  const runId = `RUN${Math.random().toString(36).slice(2, 10).toUpperCase()}`;
  ctx.db
    .insert(schema.runs)
    .values({
      id: runId,
      applicationId: appId,
      environmentId: envId,
      status: 'failed',
      trigger: 'manual',
      scopeJson: {},
      optionsJson: {},
      totalsJson: {},
      finishedAt,
    })
    .run();
  const files: Record<string, string> = {};
  for (const status of ['passed', 'failed'] as const) {
    const itemId = `${runId}${status}`;
    ctx.db
      .insert(schema.runItems)
      .values({
        id: itemId,
        runId,
        status,
        position: 0,
        labelJson: { scenario: status, modulePath: [], testCaseCode: null, testCaseTitle: null },
      })
      .run();
    const rel = `runs/${runId}/${itemId}/shot.png`;
    mkdirSync(dirname(join(ctx.config.artifactsDir, rel)), { recursive: true });
    writeFileSync(join(ctx.config.artifactsDir, rel), 'png');
    ctx.db
      .insert(schema.artifacts)
      .values({ id: `${itemId}A`, runItemId: itemId, kind: 'screenshot', path: rel, size: 3 })
      .run();
    files[status] = join(ctx.config.artifactsDir, rel);
  }
  return { runId, files };
}

describe('maintenance', () => {
  let appId = '';
  let envId = '';
  beforeAll(() => {
    appId = repo.createApplication(ctx.db, { name: 'Shop', slug: 'shop' }).id;
    envId = repo.createEnvironment(ctx.db, appId, { name: 'Staging', baseUrl: 'http://127.0.0.1:1' }).id;
  });

  it('prunes old evidence of passed results only, keeping results and recent evidence', async () => {
    const old = seedRun(appId, envId, new Date(Date.now() - 30 * 86_400_000).toISOString());
    const recent = seedRun(appId, envId, new Date().toISOString());
    const r = (await call('POST', '/api/maintenance/prune')).json();
    expect(r).toMatchObject({ items: 1, files: 1 });
    expect(existsSync(old.files.passed!)).toBe(false);
    expect(existsSync(old.files.failed!)).toBe(true); // failures kept by default
    expect(existsSync(recent.files.passed!)).toBe(true);
    expect(
      ctx.db.select().from(schema.runItems).where(eq(schema.runItems.runId, old.runId)).all(),
    ).toHaveLength(2);
    // Without "keep failures", failed evidence goes too.
    await call('PUT', '/api/settings/retention', {
      value: { keepFailures: false, prunePassesAfterDays: 14 },
    });
    expect((await call('POST', '/api/maintenance/prune')).json()).toMatchObject({ files: 1 });
    expect(existsSync(old.files.failed!)).toBe(false);
  });

  it('rotates the master key: every secret still decrypts, the old key is kept as a backup', async () => {
    repo.setSecret(ctx.db, ctx.masterKey, envId, { key: 'apiToken', value: 'tok-123' });
    const before = readFileSync(ctx.config.keyFile, 'utf8');
    const cipherBefore = ctx.db.select().from(schema.secrets).all()[0]!.ciphertext;
    const r = (await call('POST', '/api/maintenance/rotate-key')).json() as {
      secrets: number;
      backup: string;
    };
    expect(r.secrets).toBe(1);
    expect(readFileSync(r.backup, 'utf8')).toBe(before);
    expect(readFileSync(ctx.config.keyFile, 'utf8')).not.toBe(before);
    expect(ctx.db.select().from(schema.secrets).all()[0]!.ciphertext).not.toBe(cipherBefore);
    expect(repo.resolveSecrets(ctx.db, ctx.masterKey, envId)).toEqual({ apiToken: 'tok-123' });
    expect(readdirSync(dirname(ctx.config.keyFile)).filter((f) => f.endsWith('.new'))).toEqual([]);
  });

  it('requires typed confirmation for the danger zone', async () => {
    expect((await call('POST', '/api/maintenance/delete-history', { confirm: 'yes' })).statusCode).toBe(400);
    expect((await call('POST', '/api/maintenance/delete-history', { confirm: 'DELETE' })).json()).toEqual({
      runs: 2,
    });
    expect(ctx.db.select().from(schema.runs).all()).toHaveLength(0);
    expect(repo.listApplications(ctx.db)).toHaveLength(1);
    expect((await call('POST', '/api/maintenance/delete-everything', { confirm: 'DELETE' })).statusCode).toBe(
      400,
    );
    expect(
      (await call('POST', '/api/maintenance/delete-everything', { confirm: 'DELETE EVERYTHING' })).json(),
    ).toEqual({ applications: 1 });
    expect(repo.listApplications(ctx.db)).toHaveLength(0);
    expect(ctx.db.select().from(schema.secrets).all()).toHaveLength(0);
  });
});
