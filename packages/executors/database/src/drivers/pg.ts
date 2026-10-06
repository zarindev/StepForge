import {
  DbError,
  normalizeRows,
  type ConnectionConfig,
  type DbClient,
  type SchemaInfo,
  type TableInfo,
} from '../types.ts';

const quote = (id: string) => `"${id.replace(/"/g, '""')}"`;

export async function openPg(cfg: ConnectionConfig): Promise<DbClient> {
  const { default: pg } = await import('pg');
  const o = cfg.options;
  const client = new pg.Client({
    ...(o.connectionString
      ? { connectionString: String(o.connectionString) }
      : {
          host: cfg.host || '127.0.0.1',
          port: cfg.port ?? 5432,
          database: cfg.database || undefined,
          user: cfg.username || undefined,
        }),
    password: cfg.password,
    ssl: o.ssl ? { rejectUnauthorized: o.rejectUnauthorized !== false } : undefined,
    connectionTimeoutMillis: Number(o.connectTimeoutMs ?? 10_000),
    application_name: 'StepForge',
  });
  try {
    await client.connect();
  } catch (err) {
    throw new DbError('connection', `Cannot connect to PostgreSQL: ${(err as Error).message}`);
  }
  // Second line of defence for read-only connections: the session refuses writes.
  if (cfg.readOnly) await client.query('SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY');
  if (o.schema) await client.query(`SET search_path TO ${quote(String(o.schema))}`);

  const exec = async (text: string, params: unknown[] = [], maxRows?: number) => {
    const started = performance.now();
    try {
      const res = await client.query({ text, values: params });
      const last = Array.isArray(res) ? res[res.length - 1] : res;
      const raw = (last.rows ?? []) as Record<string, unknown>[];
      const { rows, truncated } = normalizeRows(raw, maxRows);
      const isRead = (last.fields?.length ?? 0) > 0;
      return {
        columns: (last.fields ?? []).map((f: { name: string }) => f.name),
        rows,
        rowCount: raw.length,
        ...(!isRead && { affected: last.rowCount ?? 0 }),
        truncated,
        durationMs: Math.round(performance.now() - started),
      };
    } catch (err) {
      throw new DbError('query', (err as Error).message);
    }
  };

  return {
    engine: 'pg',
    query: (text, params, opts) => exec(text, params, opts?.maxRows),
    callProcedure: (name, args, opts) =>
      exec(`CALL ${name}(${args.map((_, i) => `$${i + 1}`).join(', ')})`, args, opts?.maxRows),
    async begin() {
      await client.query('BEGIN');
    },
    async rollback() {
      await client.query('ROLLBACK');
    },
    async schema(): Promise<SchemaInfo> {
      const cols = await client.query(`
        SELECT c.table_schema, c.table_name, t.table_type, c.column_name, c.data_type, c.is_nullable, c.column_default
        FROM information_schema.columns c
        JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
        WHERE c.table_schema NOT IN ('pg_catalog', 'information_schema') AND c.table_schema NOT LIKE 'pg_toast%'
        ORDER BY c.table_schema, c.table_name, c.ordinal_position`);
      const pks = await client.query(`
        SELECT tc.table_schema, tc.table_name, kcu.column_name
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema
        WHERE tc.constraint_type = 'PRIMARY KEY'`);
      const fks = await client.query(`
        SELECT ns.nspname AS table_schema, cl.relname AS table_name, a.attname AS column_name,
               rcl.relname AS ref_table, ra.attname AS ref_column
        FROM pg_constraint con
        JOIN pg_class cl ON cl.oid = con.conrelid
        JOIN pg_namespace ns ON ns.oid = cl.relnamespace
        JOIN pg_class rcl ON rcl.oid = con.confrelid
        JOIN LATERAL unnest(con.conkey, con.confkey) AS k(col, refcol) ON true
        JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.col
        JOIN pg_attribute ra ON ra.attrelid = con.confrelid AND ra.attnum = k.refcol
        WHERE con.contype = 'f'`);
      const idx = await client.query(`
        SELECT ns.nspname AS table_schema, t.relname AS table_name, i.relname AS index_name, ix.indisunique AS is_unique,
               array_agg(a.attname ORDER BY k.ord) AS columns
        FROM pg_index ix
        JOIN pg_class t ON t.oid = ix.indrelid
        JOIN pg_class i ON i.oid = ix.indexrelid
        JOIN pg_namespace ns ON ns.oid = t.relnamespace
        JOIN LATERAL unnest(ix.indkey) WITH ORDINALITY AS k(attnum, ord) ON true
        JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
        WHERE ns.nspname NOT IN ('pg_catalog', 'information_schema') AND ns.nspname NOT LIKE 'pg_toast%'
        GROUP BY ns.nspname, t.relname, i.relname, ix.indisunique`);
      const key = (s: string, t: string) => `${s}.${t}`;
      const pkSet = new Set(pks.rows.map((r) => `${key(r.table_schema, r.table_name)}.${r.column_name}`));
      const tables = new Map<string, TableInfo>();
      for (const r of cols.rows) {
        const k = key(r.table_schema, r.table_name);
        if (!tables.has(k))
          tables.set(k, {
            name: r.table_name,
            ...(r.table_schema !== 'public' && { schema: r.table_schema }),
            kind: r.table_type === 'VIEW' ? 'view' : 'table',
            columns: [],
            foreignKeys: [],
            indexes: [],
          });
        tables.get(k)!.columns.push({
          name: r.column_name,
          type: r.data_type,
          nullable: r.is_nullable === 'YES',
          primaryKey: pkSet.has(`${k}.${r.column_name}`),
          default: r.column_default,
        });
      }
      for (const r of fks.rows)
        tables.get(key(r.table_schema, r.table_name))?.foreignKeys.push({
          column: r.column_name,
          refTable: r.ref_table,
          refColumn: r.ref_column,
        });
      for (const r of idx.rows)
        tables.get(key(r.table_schema, r.table_name))?.indexes.push({
          name: r.index_name,
          unique: r.is_unique,
          columns: Array.isArray(r.columns) ? r.columns : String(r.columns).replace(/[{}]/g, '').split(','),
        });
      return { engine: 'pg', database: cfg.database, tables: [...tables.values()] };
    },
    quote,
    async close() {
      await client.end().catch(() => undefined);
    },
  };
}
