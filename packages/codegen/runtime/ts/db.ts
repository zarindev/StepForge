// Database access for tests exported by StepForge (by Md Zarin Tasnim).
// Each connection name reads DB_<NAME>_URL: postgres://…, mysql://…, or sqlite:/path/to/file.db
import type { DbLike } from './helpers';

export type DbResult = DbLike;

function urlFor(connection: string): string {
  const key = `DB_${connection.replace(/[^A-Za-z0-9]+/g, '_').toUpperCase()}_URL`;
  const url = process.env[key];
  if (!url) throw new Error(`Set ${key} for the "${connection}" database (see .env.example)`);
  return url;
}

/** Runs one statement with bound parameters (? for MySQL/SQLite, $1 for PostgreSQL). */
export async function query(connection: string, sql: string, params: unknown[] = []): Promise<DbResult> {
  const url = urlFor(connection);
  const started = Date.now();
  if (/^postgres(ql)?:/.test(url)) {
    const { default: pg } = await import('pg');
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    try {
      const r = await client.query(sql, params);
      return {
        rows: r.rows,
        columns: r.fields?.map((f) => f.name) ?? [],
        rowCount: r.rows.length,
        affected: r.rowCount ?? 0,
        ms: Date.now() - started,
      };
    } finally {
      await client.end();
    }
  }
  if (/^mysql:/.test(url)) {
    const mysql = await import('mysql2/promise');
    const conn = await mysql.createConnection(url);
    try {
      const [rows, fields] = await conn.query(sql, params);
      if (Array.isArray(rows))
        return {
          rows: rows as Record<string, unknown>[],
          columns: (fields ?? []).map((f) => f.name),
          rowCount: rows.length,
          ms: Date.now() - started,
        };
      return {
        rows: [],
        columns: [],
        rowCount: 0,
        affected: (rows as { affectedRows: number }).affectedRows,
        ms: Date.now() - started,
      };
    } finally {
      await conn.end();
    }
  }
  const { default: Database } = await import('better-sqlite3');
  const db = new Database(url.replace(/^sqlite:(\/\/)?/, ''));
  try {
    const stmt = db.prepare(sql);
    if (stmt.reader) {
      const rows = stmt.all(...params) as Record<string, unknown>[];
      return {
        rows,
        columns: stmt.columns().map((c) => c.name),
        rowCount: rows.length,
        ms: Date.now() - started,
      };
    }
    const info = stmt.run(...params);
    return { rows: [], columns: [], rowCount: 0, affected: info.changes, ms: Date.now() - started };
  } finally {
    db.close();
  }
}

/** Runs several statements separated by semicolons. */
export async function script(connection: string, sql: string): Promise<DbResult> {
  const url = urlFor(connection);
  const started = Date.now();
  if (/^postgres(ql)?:/.test(url)) return query(connection, sql);
  if (/^mysql:/.test(url)) {
    const mysql = await import('mysql2/promise');
    const conn = await mysql.createConnection({ uri: url, multipleStatements: true });
    try {
      await conn.query(sql);
      return { rows: [], columns: [], rowCount: 0, ms: Date.now() - started };
    } finally {
      await conn.end();
    }
  }
  const { default: Database } = await import('better-sqlite3');
  const db = new Database(url.replace(/^sqlite:(\/\/)?/, ''));
  try {
    db.exec(sql);
    return { rows: [], columns: [], rowCount: 0, ms: Date.now() - started };
  } finally {
    db.close();
  }
}
