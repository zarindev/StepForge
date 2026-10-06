import { decrypt, encrypt } from '@stepforge/crypto';
import { DbConnectionInput, DbConnectionUpdate, newId } from '@stepforge/core';
import { and, eq } from 'drizzle-orm';
import { resolve } from 'node:path';
import type { z } from 'zod';
import type { StepForgeDb } from '../index.ts';
import { applications, dbConnections, environments, secrets } from '../schema.ts';
import { getEnvironment } from './environments.ts';
import { invalid, mapUnique, notFound, now } from './errors.ts';

type Row = typeof dbConnections.$inferSelect;
/** What the UI sees: never the password, only whether one is stored. */
export type DbConnectionView = Omit<Row, 'secretId'> & {
  hasPassword: boolean;
  environmentName: string;
  isProduction: boolean;
};
/** Everything an executor needs, password decrypted. Server-side only. */
export type ResolvedConnection = {
  id: string;
  name: string;
  engine: Row['engine'];
  host: string;
  port: number | null;
  database: string;
  username: string;
  password?: string;
  options: Record<string, unknown>;
  readOnly: boolean;
  rollbackMode: boolean;
  production?: { applicationName: string };
};

/** Connection passwords live in the secrets table under this key, outside any environment's secret list. */
export const CONNECTION_SECRET_PREFIX = 'db-connection:';

function view(db: StepForgeDb, rows: Row[]): DbConnectionView[] {
  return rows.map(({ secretId, ...r }) => {
    const env = getEnvironment(db, r.environmentId);
    return { ...r, hasPassword: !!secretId, environmentName: env.name, isProduction: env.isProduction };
  });
}

export function listConnections(db: StepForgeDb, applicationId: string): DbConnectionView[] {
  const rows = db
    .select({ c: dbConnections })
    .from(dbConnections)
    .innerJoin(environments, eq(environments.id, dbConnections.environmentId))
    .where(eq(environments.applicationId, applicationId))
    .orderBy(environments.createdAt, dbConnections.name)
    .all()
    .map((r) => r.c);
  return view(db, rows);
}

function getRow(db: StepForgeDb, id: string): Row {
  const row = db.select().from(dbConnections).where(eq(dbConnections.id, id)).get();
  if (!row) throw notFound('Database connection', id);
  return row;
}

export function getConnection(db: StepForgeDb, id: string): DbConnectionView {
  return view(db, [getRow(db, id)])[0]!;
}

export function applicationIdForConnection(db: StepForgeDb, id: string): string {
  return getEnvironment(db, getRow(db, id).environmentId).applicationId;
}

/** SQLite paths must not point at StepForge's own database (it holds the encrypted secrets). */
function checkTarget(d: { engine?: string; database?: string }, ownDbFile?: string) {
  if (d.engine === 'sqlite' && ownDbFile && d.database && resolve(d.database) === resolve(ownDbFile))
    throw invalid('A connection cannot point at StepForge’s own database');
}

function storePassword(db: StepForgeDb, key: Buffer, connectionId: string, password: string): string {
  const enc = encrypt(password, key);
  const id = newId();
  db.insert(secrets)
    .values({ id, environmentId: null, key: `${CONNECTION_SECRET_PREFIX}${connectionId}`, ...enc })
    .run();
  return id;
}

export function createConnection(
  db: StepForgeDb,
  masterKey: Buffer,
  environmentId: string,
  input: z.input<typeof DbConnectionInput>,
  ownDbFile?: string,
): DbConnectionView {
  getEnvironment(db, environmentId);
  const d = DbConnectionInput.parse(input);
  checkTarget(d, ownDbFile);
  const id = newId();
  db.transaction(() => {
    mapUnique(
      () =>
        db
          .insert(dbConnections)
          .values({
            id,
            environmentId,
            name: d.name.trim(),
            engine: d.engine,
            host: d.host,
            port: d.port ?? null,
            database: d.database,
            username: d.username,
            optionsJson: d.options,
            readOnly: d.readOnly,
            rollbackMode: d.rollbackMode,
          })
          .run(),
      `A connection named "${d.name}" already exists in this environment`,
    );
    if (d.password)
      db.update(dbConnections)
        .set({ secretId: storePassword(db, masterKey, id, d.password) })
        .where(eq(dbConnections.id, id))
        .run();
  });
  return getConnection(db, id);
}

export function updateConnection(
  db: StepForgeDb,
  masterKey: Buffer,
  id: string,
  input: z.input<typeof DbConnectionUpdate>,
  ownDbFile?: string,
): DbConnectionView {
  const row = getRow(db, id);
  const d = DbConnectionUpdate.parse(input);
  checkTarget({ engine: d.engine ?? row.engine, database: d.database ?? row.database }, ownDbFile);
  db.transaction(() => {
    let secretId = row.secretId;
    if (d.password !== undefined) {
      if (row.secretId) db.delete(secrets).where(eq(secrets.id, row.secretId)).run();
      secretId = d.password ? storePassword(db, masterKey, id, d.password) : null;
    }
    mapUnique(
      () =>
        db
          .update(dbConnections)
          .set({
            ...(d.name !== undefined && { name: d.name.trim() }),
            ...(d.engine !== undefined && { engine: d.engine }),
            ...(d.host !== undefined && { host: d.host }),
            ...(d.port !== undefined && { port: d.port }),
            ...(d.database !== undefined && { database: d.database }),
            ...(d.username !== undefined && { username: d.username }),
            ...(d.options !== undefined && { optionsJson: d.options }),
            ...(d.readOnly !== undefined && { readOnly: d.readOnly }),
            ...(d.rollbackMode !== undefined && { rollbackMode: d.rollbackMode }),
            secretId,
            updatedAt: now(),
          })
          .where(eq(dbConnections.id, id))
          .run(),
      `A connection named "${d.name}" already exists in this environment`,
    );
  });
  return getConnection(db, id);
}

export function deleteConnection(db: StepForgeDb, id: string): void {
  const row = getRow(db, id);
  db.transaction(() => {
    db.delete(dbConnections).where(eq(dbConnections.id, id)).run();
    if (row.secretId) db.delete(secrets).where(eq(secrets.id, row.secretId)).run();
  });
}

/** Decrypts a connection for use. Never send the result to the UI. */
export function resolveConnection(db: StepForgeDb, masterKey: Buffer, id: string): ResolvedConnection {
  const row = getRow(db, id);
  const env = getEnvironment(db, row.environmentId);
  const app = db
    .select({ name: applications.name })
    .from(applications)
    .where(eq(applications.id, env.applicationId))
    .get();
  const secret = row.secretId
    ? db.select().from(secrets).where(eq(secrets.id, row.secretId)).get()
    : undefined;
  return {
    id: row.id,
    name: row.name,
    engine: row.engine,
    host: row.host,
    port: row.port,
    database: row.database,
    username: row.username,
    ...(secret && { password: decrypt(secret, masterKey) }),
    options: row.optionsJson,
    readOnly: row.readOnly,
    rollbackMode: row.rollbackMode,
    ...(env.isProduction && app && { production: { applicationName: app.name } }),
  };
}

/** Finds a connection of an environment by name (or id), as steps refer to them. */
export function findConnection(db: StepForgeDb, environmentId: string, ref: string): Row | undefined {
  const byName = db
    .select()
    .from(dbConnections)
    .where(and(eq(dbConnections.environmentId, environmentId), eq(dbConnections.name, ref)))
    .get();
  if (byName) return byName;
  const byId = db.select().from(dbConnections).where(eq(dbConnections.id, ref)).get();
  return byId?.environmentId === environmentId ? byId : undefined;
}
