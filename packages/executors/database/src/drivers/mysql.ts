import {
  DbError,
  normalizeRows,
  type ConnectionConfig,
  type DbClient,
  type SchemaInfo,
  type TableInfo,
} from '../types.ts';

const quote = (id: string) => `\`${id.replace(/`/g, '``')}\``;

export async function openMysql(cfg: ConnectionConfig): Promise<DbClient> {
  const mysql = await import('mysql2/promise');
  const o = cfg.options;
  let conn: Awaited<ReturnType<typeof mysql.createConnection>>;
  try {
    conn = o.connectionString
      ? await mysql.createConnection(String(o.connectionString))
      : await mysql.createConnection({
          host: cfg.host || '127.0.0.1',
          port: cfg.port ?? 3306,
          database: cfg.database || undefined,
          user: cfg.username || undefined,
          password: cfg.password,
          ssl: o.ssl ? { rejectUnauthorized: o.rejectUnauthorized !== false } : undefined,
          connectTimeout: Number(o.connectTimeoutMs ?? 10_000),
          dateStrings: true,
          supportBigNumbers: true,
          multipleStatements: false,
        });
  } catch (err) {
    throw new DbError('connection', `Cannot connect to MySQL: ${(err as Error).message}`);
  }
  if (cfg.readOnly) await conn.query('SET SESSION TRANSACTION READ ONLY');
  // Each statement sees rows other clients committed meanwhile (the app under test), even inside our
  // rollback transaction — REPEATABLE READ would freeze the first snapshot.
  await conn.query('SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED');

  const exec = async (sql: string, params: unknown[] = [], maxRows?: number) => {
    const started = performance.now();
    try {
      const [result, fields] = await conn.query({ sql, values: params });
      if (Array.isArray(result)) {
        // CALL returns [rows..., OkPacket]; keep the first result set.
        const set = (Array.isArray(result[0]) ? result[0] : result) as Record<string, unknown>[];
        const fieldList = (Array.isArray(fields?.[0]) ? fields[0] : fields) as { name: string }[] | undefined;
        const { rows, truncated } = normalizeRows(set, maxRows);
        return {
          columns: fieldList?.map((f) => f.name) ?? Object.keys(set[0] ?? {}),
          rows,
          rowCount: set.length,
          truncated,
          durationMs: Math.round(performance.now() - started),
        };
      }
      return {
        columns: [],
        rows: [],
        rowCount: 0,
        affected: (result as { affectedRows?: number }).affectedRows ?? 0,
        durationMs: Math.round(performance.now() - started),
      };
    } catch (err) {
      throw new DbError('query', (err as Error).message);
    }
  };

  return {
    engine: 'mysql',
    query: (sql, params, opts) => exec(sql, params, opts?.maxRows),
    callProcedure: (name, args, opts) =>
      exec(`CALL ${name}(${args.map(() => '?').join(', ')})`, args, opts?.maxRows),
    async begin() {
      await conn.query('START TRANSACTION');
    },
    async rollback() {
      await conn.query('ROLLBACK');
    },
    async schema(): Promise<SchemaInfo> {
      const [cols] = (await conn.query(`
        SELECT c.TABLE_NAME t, tb.TABLE_TYPE tt, c.COLUMN_NAME c, c.COLUMN_TYPE ty, c.IS_NULLABLE n, c.COLUMN_KEY k, c.COLUMN_DEFAULT d
        FROM information_schema.COLUMNS c
        JOIN information_schema.TABLES tb ON tb.TABLE_SCHEMA = c.TABLE_SCHEMA AND tb.TABLE_NAME = c.TABLE_NAME
        WHERE c.TABLE_SCHEMA = DATABASE() ORDER BY c.TABLE_NAME, c.ORDINAL_POSITION`)) as unknown as [
        Record<string, string>[],
      ];
      const [fks] = (await conn.query(`
        SELECT TABLE_NAME t, COLUMN_NAME c, REFERENCED_TABLE_NAME rt, REFERENCED_COLUMN_NAME rc
        FROM information_schema.KEY_COLUMN_USAGE
        WHERE TABLE_SCHEMA = DATABASE() AND REFERENCED_TABLE_NAME IS NOT NULL`)) as unknown as [
        Record<string, string>[],
      ];
      const [idx] = (await conn.query(`
        SELECT TABLE_NAME t, INDEX_NAME i, NON_UNIQUE nu, COLUMN_NAME c
        FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX`)) as unknown as [
        Record<string, string | number>[],
      ];
      const tables = new Map<string, TableInfo>();
      for (const r of cols) {
        if (!tables.has(r.t!))
          tables.set(r.t!, {
            name: r.t!,
            kind: r.tt === 'VIEW' ? 'view' : 'table',
            columns: [],
            foreignKeys: [],
            indexes: [],
          });
        tables.get(r.t!)!.columns.push({
          name: r.c!,
          type: r.ty!,
          nullable: r.n === 'YES',
          primaryKey: r.k === 'PRI',
          default: r.d ?? null,
        });
      }
      for (const r of fks)
        tables.get(r.t!)?.foreignKeys.push({ column: r.c!, refTable: r.rt!, refColumn: r.rc! });
      for (const r of idx) {
        const t = tables.get(String(r.t));
        if (!t) continue;
        let index = t.indexes.find((i) => i.name === r.i);
        if (!index) t.indexes.push((index = { name: String(r.i), unique: Number(r.nu) === 0, columns: [] }));
        index.columns.push(String(r.c));
      }
      return { engine: 'mysql', database: cfg.database, tables: [...tables.values()] };
    },
    quote,
    async close() {
      await conn.end().catch(() => undefined);
    },
  };
}
