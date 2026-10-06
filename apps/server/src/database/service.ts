import { DbConnectionInput } from '@stepforge/core';
import type { StepForgeDb } from '@stepforge/db';
import * as repo from '@stepforge/db/repos';
import {
  checkPolicy,
  ManagedConnection,
  openClient,
  runAudit,
  type AuditOptions,
  type AuditReport,
  type ConnectionConfig,
  type ConnectionResolver,
  type QueryResult,
  type SchemaInfo,
} from '@stepforge/executor-db';
import type { z } from 'zod';

const SCHEMA_TTL_MS = 60_000;

/** Maps driver errors (by name: workspace symlinks can load the module twice) onto HTTP errors. */
function httpError(err: unknown): Error {
  const e = err as Error & { code?: string };
  if (e.name !== 'DbError') return e;
  const status = e.code === 'blocked' ? 403 : e.code === 'connection' ? 502 : e.code === 'query' ? 422 : 400;
  return new repo.RepoError(status, e.code === 'query' ? 'query_error' : (e.code ?? 'db_error'), e.message);
}

async function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        t = setTimeout(
          () => reject(new repo.RepoError(504, 'timeout', `${what} timed out after ${ms / 1000}s`)),
          ms,
        );
      }),
    ]);
  } finally {
    clearTimeout(t);
  }
}

export type WorkbenchResult = QueryResult & {
  write: boolean;
  /** True when rollback mode undid the statement's changes. */
  rolledBack: boolean;
};

/** Connections, schema browsing, ad-hoc queries and data-quality audits for the SQL Workbench. */
export class DatabaseService {
  private schemas = new Map<string, { at: number; schema: SchemaInfo }>();

  constructor(
    private readonly db: StepForgeDb,
    private readonly masterKey: Buffer,
    private readonly ownDbFile?: string,
  ) {}

  config(id: string): ConnectionConfig {
    return repo.resolveConnection(this.db, this.masterKey, id);
  }

  create(environmentId: string, input: z.input<typeof DbConnectionInput>) {
    return repo.createConnection(this.db, this.masterKey, environmentId, input, this.ownDbFile);
  }

  update(id: string, input: Parameters<typeof repo.updateConnection>[3]) {
    this.schemas.delete(id);
    return repo.updateConnection(this.db, this.masterKey, id, input, this.ownDbFile);
  }

  delete(id: string) {
    this.schemas.delete(id);
    repo.deleteConnection(this.db, id);
  }

  /**
   * Tests a saved connection, or an unsaved draft (`connectionId` lets a draft reuse the stored password).
   * Reports the number of tables so "connected to the wrong database" is obvious.
   */
  async test(
    cfg: ConnectionConfig,
  ): Promise<{ ok: boolean; message: string; durationMs: number; tables?: number }> {
    const started = performance.now();
    try {
      const client = await withTimeout(openClient(cfg), 20_000, 'Connecting');
      try {
        const schema = await withTimeout(client.schema(), 20_000, 'Reading the schema');
        const n = schema.tables.length;
        return {
          ok: true,
          message: `Connected to ${cfg.engine === 'sqlite' ? 'the SQLite file' : `“${schema.database || cfg.name}”`} — ${n} table${n === 1 ? '' : 's'}`,
          durationMs: Math.round(performance.now() - started),
          tables: n,
        };
      } finally {
        await client.close();
      }
    } catch (err) {
      return {
        ok: false,
        message: (err as Error).message,
        durationMs: Math.round(performance.now() - started),
      };
    }
  }

  draftConfig(
    environmentId: string,
    input: z.input<typeof DbConnectionInput>,
    connectionId?: string,
  ): ConnectionConfig {
    const d = DbConnectionInput.parse(input);
    const env = repo.getEnvironment(this.db, environmentId);
    let password = d.password;
    if (password === undefined && connectionId) password = this.config(connectionId).password;
    return {
      name: d.name,
      engine: d.engine,
      host: d.host,
      port: d.port ?? null,
      database: d.database,
      username: d.username,
      password,
      options: d.options,
      readOnly: true, // testing never writes
      rollbackMode: false,
      ...(env.isProduction && {
        production: { applicationName: repo.getApplication(this.db, env.applicationId).name },
      }),
    };
  }

  async schema(id: string, refresh = false): Promise<SchemaInfo> {
    const cached = this.schemas.get(id);
    if (cached && !refresh && Date.now() - cached.at < SCHEMA_TTL_MS) return cached.schema;
    const client = await withTimeout(openClient(this.config(id)), 20_000, 'Connecting').catch((e) => {
      throw httpError(e);
    });
    try {
      const schema = await withTimeout(client.schema(), 30_000, 'Reading the schema');
      this.schemas.set(id, { at: Date.now(), schema });
      return schema;
    } catch (err) {
      throw httpError(err);
    } finally {
      await client.close();
    }
  }

  /** Runs one workbench statement under the connection's safety rules. */
  async query(
    id: string,
    input: { sql: string; params?: unknown[]; maxRows?: number; confirm?: string },
  ): Promise<WorkbenchResult> {
    const cfg = this.config(id);
    try {
      const check = await checkPolicy(cfg, input.sql, { confirm: input.confirm });
      const conn = await withTimeout(ManagedConnection.open(cfg), 20_000, 'Connecting');
      try {
        await conn.prepare(check.write);
        const result = await withTimeout(
          conn.client.query(input.sql, input.params ?? [], { maxRows: input.maxRows ?? 1000 }),
          120_000,
          'The query',
        );
        if (check.write) this.schemas.delete(id); // DDL may have changed it
        return { ...result, write: check.write, rolledBack: conn.rolledBack };
      } finally {
        await conn.close();
      }
    } catch (err) {
      throw httpError(err);
    }
  }

  async audit(id: string, opts: AuditOptions): Promise<AuditReport> {
    const client = await withTimeout(
      openClient({ ...this.config(id), readOnly: true }),
      20_000,
      'Connecting',
    ).catch((e) => {
      throw httpError(e);
    });
    try {
      return await withTimeout(runAudit(client, await client.schema(), opts), 300_000, 'The audit');
    } catch (err) {
      throw httpError(err);
    } finally {
      await client.close();
    }
  }

  /** Resolves `connection` step params against a run's environment. */
  resolverFor(environmentId: string): ConnectionResolver {
    return async (ref) => {
      const row = repo.findConnection(this.db, environmentId, ref);
      if (!row) {
        const env = repo.getEnvironment(this.db, environmentId);
        throw new Error(`No database connection named "${ref}" in the ${env.name} environment`);
      }
      return this.config(row.id);
    };
  }
}
