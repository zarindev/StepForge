import { DbError, type DbClient } from './types.ts';

export type QueryPlan = {
  engine: string;
  /** Human-readable plan, one line per node. */
  lines: string[];
  /** Tables read with a full scan (no index). */
  fullScans: string[];
};

type PgNode = { 'Node Type': string; 'Relation Name'?: string; 'Index Name'?: string; Plans?: PgNode[] };

/**
 * The engine's execution plan for a read query, without running it (no EXPLAIN ANALYZE), with full table scans
 * picked out. Supported: SQLite, PostgreSQL, MySQL. The caller has already checked the statement is a read.
 */
export async function explainQuery(
  client: DbClient,
  sql: string,
  params: unknown[] = [],
): Promise<QueryPlan> {
  const body = sql.trim().replace(/;+\s*$/, '');
  switch (client.engine) {
    case 'sqlite': {
      const r = await client.query(`EXPLAIN QUERY PLAN ${body}`, params);
      const rows = r.rows as { id: number; parent: number; detail: string }[];
      const depth = new Map<number, number>();
      const lines = rows.map((row) => {
        const d = (depth.get(row.parent) ?? -1) + 1;
        depth.set(row.id, d);
        return `${'  '.repeat(d)}${row.detail}`;
      });
      // "SCAN patients" (or "SCAN TABLE patients" on older SQLite) without "USING … INDEX" reads every row.
      const fullScans = rows
        .filter((row) => /^SCAN /.test(row.detail) && !/USING (COVERING )?INDEX/.test(row.detail))
        .map((row) => row.detail.replace(/^SCAN (TABLE )?/, '').split(' ')[0]!);
      return { engine: 'sqlite', lines, fullScans: [...new Set(fullScans)] };
    }
    case 'pg': {
      const r = await client.query(`EXPLAIN (FORMAT JSON) ${body}`, params);
      const raw = Object.values(r.rows[0] ?? {})[0];
      const plan = (typeof raw === 'string' ? JSON.parse(raw) : raw) as { Plan: PgNode }[];
      const lines: string[] = [];
      const fullScans: string[] = [];
      const walk = (n: PgNode, d: number) => {
        lines.push(
          `${'  '.repeat(d)}${n['Node Type']}${n['Relation Name'] ? ` on ${n['Relation Name']}` : ''}${n['Index Name'] ? ` using ${n['Index Name']}` : ''}`,
        );
        if (n['Node Type'] === 'Seq Scan' && n['Relation Name']) fullScans.push(n['Relation Name']);
        for (const c of n.Plans ?? []) walk(c, d + 1);
      };
      walk(plan[0]!.Plan, 0);
      return { engine: 'pg', lines, fullScans: [...new Set(fullScans)] };
    }
    case 'mysql': {
      const r = await client.query(`EXPLAIN ${body}`, params);
      const rows = r.rows as {
        table?: string;
        type?: string;
        key?: string | null;
        rows?: number;
        Extra?: string;
      }[];
      return {
        engine: 'mysql',
        lines: rows.map(
          (x) =>
            `${x.table ?? '?'}: ${x.type ?? '?'}${x.key ? ` using ${x.key}` : ''}${x.rows ? ` (~${x.rows} rows)` : ''}${x.Extra ? ` — ${x.Extra}` : ''}`,
        ),
        fullScans: [...new Set(rows.filter((x) => x.type === 'ALL' && x.table).map((x) => x.table!))],
      };
    }
    default:
      throw new DbError(
        'unsupported',
        `Query plans are not supported for ${client.engine} yet (timing still works)`,
      );
  }
}
