import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import {
  DbError,
  normalizeRows,
  type ConnectionConfig,
  type DbClient,
  type QueryOptions,
  type QueryResult,
  type SchemaInfo,
  type TableInfo,
} from '../types.ts';

const quote = (id: string) => `"${id.replace(/"/g, '""')}"`;

export function openSqlite(cfg: ConnectionConfig): DbClient {
  const file = cfg.database.trim();
  if (!file) throw new DbError('config', 'SQLite needs a database file path');
  if (file !== ':memory:' && !existsSync(file))
    throw new DbError('connection', `SQLite file not found: ${file}`);
  let db: Database.Database;
  try {
    db = new Database(file, { readonly: cfg.readOnly && file !== ':memory:', fileMustExist: true });
  } catch (err) {
    throw new DbError('connection', `Cannot open ${file}: ${(err as Error).message}`);
  }
  db.pragma('busy_timeout = 5000');

  const run = (sql: string, params: unknown[] = [], opts: QueryOptions = {}): QueryResult => {
    const started = performance.now();
    const stmt = db.prepare(sql);
    const bound = params.map((p) => (typeof p === 'boolean' ? (p ? 1 : 0) : p));
    if (stmt.reader) {
      const raw = stmt.all(...bound) as Record<string, unknown>[];
      const { rows, truncated } = normalizeRows(raw, opts.maxRows);
      return {
        columns: stmt.columns().map((c) => c.name),
        rows,
        rowCount: raw.length,
        truncated,
        durationMs: Math.round(performance.now() - started),
      };
    }
    const info = stmt.run(...bound);
    return {
      columns: [],
      rows: [],
      rowCount: 0,
      affected: info.changes,
      durationMs: Math.round(performance.now() - started),
    };
  };

  return {
    engine: 'sqlite',
    async query(sql, params, opts) {
      try {
        return run(sql, params, opts);
      } catch (err) {
        throw new DbError('query', (err as Error).message);
      }
    },
    async callProcedure() {
      throw new DbError('unsupported', 'SQLite has no stored procedures');
    },
    async begin() {
      db.exec('BEGIN IMMEDIATE');
    },
    async rollback() {
      if (db.inTransaction) db.exec('ROLLBACK');
    },
    async schema(): Promise<SchemaInfo> {
      const objects = db
        .prepare(
          "SELECT name, type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .all() as { name: string; type: 'table' | 'view' }[];
      const tables: TableInfo[] = objects.map(({ name, type }) => {
        const cols = db.prepare(`PRAGMA table_info(${quote(name)})`).all() as {
          name: string;
          type: string;
          notnull: number;
          pk: number;
          dflt_value: string | null;
        }[];
        const fks = db.prepare(`PRAGMA foreign_key_list(${quote(name)})`).all() as {
          table: string;
          from: string;
          to: string | null;
        }[];
        const idx = db.prepare(`PRAGMA index_list(${quote(name)})`).all() as {
          name: string;
          unique: number;
        }[];
        return {
          name,
          kind: type,
          columns: cols.map((c) => ({
            name: c.name,
            type: c.type || 'ANY',
            nullable: c.notnull === 0 && c.pk === 0,
            primaryKey: c.pk > 0,
            default: c.dflt_value,
          })),
          foreignKeys: fks.map((f) => ({ column: f.from, refTable: f.table, refColumn: f.to ?? 'rowid' })),
          indexes: idx.map((i) => ({
            name: i.name,
            unique: i.unique === 1,
            columns: (db.prepare(`PRAGMA index_info(${quote(i.name)})`).all() as { name: string }[]).map(
              (c) => c.name,
            ),
          })),
        };
      });
      return { engine: 'sqlite', database: file, tables };
    },
    quote,
    async close() {
      if (db.open) {
        if (db.inTransaction) db.exec('ROLLBACK');
        db.close();
      }
    },
  };
}
