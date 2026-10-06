export type DbEngine = 'pg' | 'mysql' | 'mssql' | 'sqlite' | 'mongo';
export const DB_ENGINES: DbEngine[] = ['sqlite', 'pg', 'mysql', 'mssql', 'mongo'];
export const DEFAULT_PORTS: Record<DbEngine, number | null> = {
  pg: 5432,
  mysql: 3306,
  mssql: 1433,
  sqlite: null,
  mongo: 27017,
};

/** Everything needed to open a connection. The password is decrypted by the host just before use. */
export type ConnectionConfig = {
  id?: string;
  name: string;
  engine: DbEngine;
  host: string;
  port?: number | null;
  /** Database name, or the file path for SQLite. */
  database: string;
  username: string;
  password?: string;
  /** Driver extras: `ssl` (boolean), `connectionString`/`uri`, `schema`, `trustServerCertificate`, `authSource`. */
  options: Record<string, unknown>;
  readOnly: boolean;
  rollbackMode: boolean;
  /** Set when the connection belongs to a production environment. */
  production?: { applicationName: string };
};

export type QueryResult = {
  columns: string[];
  rows: Record<string, unknown>[];
  /** Rows returned (before truncation). */
  rowCount: number;
  /** Rows changed by a write statement, when the driver reports it. */
  affected?: number;
  durationMs: number;
  /** True when more rows were returned than kept (`maxRows`). */
  truncated?: boolean;
  /** Number of statements executed (scripts). */
  statements?: number;
};

export type ColumnInfo = {
  name: string;
  type: string;
  nullable: boolean;
  primaryKey: boolean;
  default?: string | null;
};
export type ForeignKey = { column: string; refTable: string; refColumn: string; inferred?: boolean };
export type IndexInfo = { name: string; columns: string[]; unique: boolean };
export type TableInfo = {
  name: string;
  /** Schema/namespace, when the engine has one and it is not the default. */
  schema?: string;
  kind: 'table' | 'view' | 'collection';
  columns: ColumnInfo[];
  foreignKeys: ForeignKey[];
  indexes: IndexInfo[];
};
export type SchemaInfo = { engine: DbEngine; database: string; tables: TableInfo[] };

export type QueryOptions = { maxRows?: number; signal?: AbortSignal };

/** One open connection. Drivers implement it; the executor and the workbench share it. */
export interface DbClient {
  readonly engine: DbEngine;
  /** Runs one SQL statement (or a Mongo command as JSON for `mongo`). */
  query(text: string, params?: unknown[], opts?: QueryOptions): Promise<QueryResult>;
  /** Calls a stored procedure. */
  callProcedure(name: string, args: unknown[], opts?: QueryOptions): Promise<QueryResult>;
  begin(): Promise<void>;
  rollback(): Promise<void>;
  schema(): Promise<SchemaInfo>;
  /** Quotes an identifier (table or column) for this engine. */
  quote(identifier: string): string;
  close(): Promise<void>;
}

export const DEFAULT_MAX_ROWS = 1000;

/** Normalises driver values so results are JSON-safe and stable across engines. */
export function normalizeValue(v: unknown): unknown {
  if (v === undefined) return null;
  if (typeof v === 'bigint') return Number.isSafeInteger(Number(v)) ? Number(v) : v.toString();
  if (v instanceof Date) return v.toISOString();
  if (Buffer.isBuffer(v)) return `<${v.length} bytes>`;
  if (v instanceof Uint8Array) return `<${v.byteLength} bytes>`;
  if (v && typeof v === 'object') {
    const ctor = (v as { constructor?: { name?: string } }).constructor?.name;
    if (ctor === 'ObjectId' || ctor === 'Decimal128' || ctor === 'Long') return String(v);
    if (Array.isArray(v)) return v.map(normalizeValue);
    if (ctor === 'Object' || ctor === undefined)
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, normalizeValue(x)]));
    return String(v);
  }
  return v;
}

export function normalizeRows(
  rows: Record<string, unknown>[],
  maxRows = DEFAULT_MAX_ROWS,
): { rows: Record<string, unknown>[]; truncated: boolean } {
  const kept = rows
    .slice(0, maxRows)
    .map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, normalizeValue(v)])));
  return { rows: kept, truncated: rows.length > maxRows };
}

/** Error thrown by drivers and guards; the executor maps it to a StepError kind. */
export class DbError extends Error {
  constructor(
    public readonly code: 'blocked' | 'connection' | 'query' | 'unsupported' | 'config',
    message: string,
  ) {
    super(message);
    this.name = 'DbError';
  }
}
