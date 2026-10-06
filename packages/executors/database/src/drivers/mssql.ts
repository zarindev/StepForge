import {
  DbError,
  normalizeRows,
  type ConnectionConfig,
  type DbClient,
  type SchemaInfo,
  type TableInfo,
} from '../types.ts';

const quote = (id: string) => `[${id.replace(/]/g, ']]')}]`;

/**
 * SQL Server driver (tedious). SQL Server has no session-level read-only switch, so read-only connections
 * rely on the statement guard plus rollback mode; a read-only database login is recommended.
 */
export async function openMssql(cfg: ConnectionConfig): Promise<DbClient> {
  const { default: sql } = await import('mssql');
  const o = cfg.options;
  const pool = new sql.ConnectionPool(
    o.connectionString
      ? String(o.connectionString)
      : {
          server: cfg.host || '127.0.0.1',
          port: cfg.port ?? 1433,
          database: cfg.database || undefined,
          user: cfg.username || undefined,
          password: cfg.password,
          connectionTimeout: Number(o.connectTimeoutMs ?? 10_000),
          // Two connections: one may be held by the rollback-mode transaction while schema reads use the other.
          pool: { max: 2, min: 0 },
          options: {
            encrypt: o.ssl !== false,
            trustServerCertificate: o.trustServerCertificate !== false,
            appName: 'StepForge',
            ...(cfg.readOnly && { readOnlyIntent: true }),
          },
        },
  );
  try {
    await pool.connect();
  } catch (err) {
    throw new DbError('connection', `Cannot connect to SQL Server: ${(err as Error).message}`);
  }
  let tx: InstanceType<typeof sql.Transaction> | null = null;
  const request = () => (tx ? new sql.Request(tx) : pool.request());

  const toResult = (
    res: { recordset?: Record<string, unknown>[]; rowsAffected: number[] },
    started: number,
    maxRows?: number,
  ) => {
    if (res.recordset) {
      const raw = res.recordset;
      const { rows, truncated } = normalizeRows(raw, maxRows);
      const meta = (raw as unknown as { columns?: Record<string, unknown> }).columns;
      return {
        columns: meta ? Object.keys(meta) : Object.keys(raw[0] ?? {}),
        rows,
        rowCount: raw.length,
        truncated,
        durationMs: Math.round(performance.now() - started),
      };
    }
    return {
      columns: [],
      rows: [],
      rowCount: 0,
      affected: res.rowsAffected.reduce((a, b) => a + b, 0),
      durationMs: Math.round(performance.now() - started),
    };
  };

  return {
    engine: 'mssql',
    async query(text, params = [], opts) {
      const started = performance.now();
      try {
        const r = request();
        // Positional parameters are written @p1, @p2… in the SQL.
        params.forEach((p, i) => r.input(`p${i + 1}`, p));
        return toResult(await r.query(text), started, opts?.maxRows);
      } catch (err) {
        throw new DbError('query', (err as Error).message);
      }
    },
    async callProcedure(name, args, opts) {
      const started = performance.now();
      try {
        const r = request();
        args.forEach((p, i) => r.input(`p${i + 1}`, p));
        return toResult(await r.execute(name), started, opts?.maxRows);
      } catch (err) {
        throw new DbError('query', (err as Error).message);
      }
    },
    async begin() {
      tx = new sql.Transaction(pool);
      await tx.begin();
    },
    async rollback() {
      if (tx) await tx.rollback().catch(() => undefined);
      tx = null;
    },
    async schema(): Promise<SchemaInfo> {
      const q = async (text: string) =>
        (await pool.request().query(text)).recordset as Record<string, unknown>[];
      const cols = await q(`
        SELECT c.TABLE_SCHEMA s, c.TABLE_NAME t, tb.TABLE_TYPE tt, c.COLUMN_NAME c, c.DATA_TYPE ty, c.IS_NULLABLE n, c.COLUMN_DEFAULT d
        FROM INFORMATION_SCHEMA.COLUMNS c
        JOIN INFORMATION_SCHEMA.TABLES tb ON tb.TABLE_SCHEMA = c.TABLE_SCHEMA AND tb.TABLE_NAME = c.TABLE_NAME
        ORDER BY c.TABLE_SCHEMA, c.TABLE_NAME, c.ORDINAL_POSITION`);
      const pks = await q(`
        SELECT kcu.TABLE_SCHEMA s, kcu.TABLE_NAME t, kcu.COLUMN_NAME c
        FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
        JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu ON kcu.CONSTRAINT_NAME = tc.CONSTRAINT_NAME
        WHERE tc.CONSTRAINT_TYPE = 'PRIMARY KEY'`);
      const fks = await q(`
        SELECT SCHEMA_NAME(t.schema_id) s, t.name t, c.name c, rt.name rt, rc.name rc
        FROM sys.foreign_key_columns f
        JOIN sys.tables t ON t.object_id = f.parent_object_id
        JOIN sys.columns c ON c.object_id = f.parent_object_id AND c.column_id = f.parent_column_id
        JOIN sys.tables rt ON rt.object_id = f.referenced_object_id
        JOIN sys.columns rc ON rc.object_id = f.referenced_object_id AND rc.column_id = f.referenced_column_id`);
      const idx = await q(`
        SELECT SCHEMA_NAME(t.schema_id) s, t.name t, i.name i, i.is_unique u, c.name c
        FROM sys.indexes i
        JOIN sys.tables t ON t.object_id = i.object_id
        JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
        JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
        WHERE i.name IS NOT NULL ORDER BY t.name, i.name, ic.key_ordinal`);
      const key = (r: Record<string, unknown>) => `${r.s}.${r.t}`;
      const pkSet = new Set(pks.map((r) => `${key(r)}.${r.c}`));
      const tables = new Map<string, TableInfo>();
      for (const r of cols) {
        if (!tables.has(key(r)))
          tables.set(key(r), {
            name: String(r.t),
            ...(r.s !== 'dbo' && { schema: String(r.s) }),
            kind: r.tt === 'VIEW' ? 'view' : 'table',
            columns: [],
            foreignKeys: [],
            indexes: [],
          });
        tables.get(key(r))!.columns.push({
          name: String(r.c),
          type: String(r.ty),
          nullable: r.n === 'YES',
          primaryKey: pkSet.has(`${key(r)}.${r.c}`),
          default: (r.d as string | null) ?? null,
        });
      }
      for (const r of fks)
        tables
          .get(key(r))
          ?.foreignKeys.push({ column: String(r.c), refTable: String(r.rt), refColumn: String(r.rc) });
      for (const r of idx) {
        const t = tables.get(key(r));
        if (!t) continue;
        let index = t.indexes.find((i) => i.name === r.i);
        if (!index) t.indexes.push((index = { name: String(r.i), unique: !!r.u, columns: [] }));
        index.columns.push(String(r.c));
      }
      return { engine: 'mssql', database: cfg.database, tables: [...tables.values()] };
    },
    quote,
    async close() {
      if (tx) await tx.rollback().catch(() => undefined);
      await pool.close().catch(() => undefined);
    },
  };
}
