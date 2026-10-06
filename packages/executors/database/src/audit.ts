import type { DbClient, ForeignKey, SchemaInfo, TableInfo } from './types.ts';

export const AUDIT_CHECKS = ['orphans', 'duplicates', 'nulls', 'formats', 'negatives'] as const;
export type AuditCheck = (typeof AUDIT_CHECKS)[number];

export type AuditOptions = {
  /** Tables to audit (default: every table, views excluded). */
  tables?: string[];
  /** Checks to run (default: all). */
  checks?: AuditCheck[];
  /** Column sets that must be unique, per table. Default: inferred (email/phone/code-like columns, name + birth date). */
  duplicateColumns?: Record<string, string[][]>;
  /** Columns that must not be NULL or empty, per table. Default: inferred name/title/status columns. */
  requiredColumns?: Record<string, string[]>;
  /** Also treat `<thing>_id` columns as references to `<things>.id` when no foreign key is declared. Default true. */
  inferRelationships?: boolean;
  /** Maximum rows read per column for format checks (and per collection for MongoDB). Default 10 000. */
  sampleLimit?: number;
};

export type AuditFinding = {
  check: AuditCheck;
  table: string;
  columns: string[];
  /** Offending rows (or duplicate groups). */
  count: number;
  severity: 'high' | 'medium' | 'low';
  message: string;
  sample: Record<string, unknown>[];
  /** The query that found it, so it can be re-run in the workbench or saved as a DB test. */
  sql?: string;
};

export type AuditReport = {
  engine: string;
  database: string;
  tables: string[];
  checks: AuditCheck[];
  findings: AuditFinding[];
  /** What each check looked at, so an empty report is explainable. */
  coverage: { check: AuditCheck; table: string; columns: string[] }[];
  notes: string[];
  durationMs: number;
};

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const PHONE = /^\+?[\d\s().-]{7,20}$/;
const NUMERIC_TYPE = /int|real|numeric|decimal|float|double|money|number|serial/i;
const TEXT_TYPE = /char|text|string|clob/i;
const MONEY_LIKE =
  /(^|_)(price|amount|qty|quantity|stock|fee|total|cost|balance|age|salary|discount|tax|count|paid|due)(_|$)/i;
const UNIQUE_LIKE = /(^|_)(email|phone|mobile|code|sku|username|ssn|barcode|slug)$/i;
const REQUIRED_LIKE = /^(name|full_name|first_name|last_name|title|status)$/i;
const NAME_COL = /^(full_name|name)$/i;
const DOB_COL = /^(dob|date_of_birth|birth_date|birthdate)$/i;

const num = (row: Record<string, unknown> | undefined) => Number(row?.n ?? row?.N ?? 0);

function pluralCandidates(base: string): string[] {
  return [base, `${base}s`, `${base}es`, base.endsWith('y') ? `${base.slice(0, -1)}ies` : ''].filter(Boolean);
}

/** Declared foreign keys plus, optionally, `x_id` → `xs.id` relationships inferred from naming. */
export function relationships(schema: SchemaInfo, table: TableInfo, infer: boolean): ForeignKey[] {
  const fks = [...table.foreignKeys];
  if (!infer) return fks;
  for (const col of table.columns) {
    const m = /^(.+?)_?id$/i.exec(col.name);
    if (!m || col.primaryKey || fks.some((f) => f.column === col.name) || !/_id$/i.test(col.name)) continue;
    const base = m[1]!.toLowerCase().replace(/_$/, '');
    const target = schema.tables.find(
      (t) =>
        t.kind === 'table' &&
        pluralCandidates(base).includes(t.name.toLowerCase()) &&
        t.columns.some((c) => c.name.toLowerCase() === 'id'),
    );
    if (target && target !== table)
      fks.push({ column: col.name, refTable: target.name, refColumn: 'id', inferred: true });
  }
  return fks;
}

/** Column sets checked for duplicates when the caller did not choose any. */
export function defaultDuplicateSets(table: TableInfo): string[][] {
  const uniqueIndexed = new Set(
    table.indexes.filter((i) => i.unique && i.columns.length === 1).map((i) => i.columns[0]),
  );
  const sets = table.columns
    .filter((c) => !c.primaryKey && UNIQUE_LIKE.test(c.name) && !uniqueIndexed.has(c.name))
    .map((c) => [c.name]);
  const name = table.columns.find((c) => NAME_COL.test(c.name));
  const dob = table.columns.find((c) => DOB_COL.test(c.name));
  if (name && dob) sets.push([name.name, dob.name]);
  return sets;
}

export async function runAudit(
  client: DbClient,
  schema: SchemaInfo,
  opts: AuditOptions = {},
): Promise<AuditReport> {
  const started = performance.now();
  const checks = opts.checks?.length ? opts.checks : [...AUDIT_CHECKS];
  const wanted = opts.tables?.length ? new Set(opts.tables) : null;
  const tables = schema.tables.filter(
    (t) => (wanted ? wanted.has(t.name) : t.kind !== 'view') && t.columns.length > 0,
  );
  const missing = wanted ? [...wanted].filter((n) => !schema.tables.some((t) => t.name === n)) : [];
  const report: AuditReport = {
    engine: schema.engine,
    database: schema.database,
    tables: tables.map((t) => t.name),
    checks,
    findings: [],
    coverage: [],
    notes: missing.map((m) => `Table "${m}" was not found`),
    durationMs: 0,
  };
  const sampleLimit = opts.sampleLimit ?? 10_000;
  if (schema.engine === 'mongo') await auditMongo(client, tables, checks, opts, sampleLimit, report);
  else await auditSql(client, schema, tables, checks, opts, sampleLimit, report);
  report.durationMs = Math.round(performance.now() - started);
  return report;
}

// ─── SQL engines ───────────────────────────────────────────────────────────

async function auditSql(
  client: DbClient,
  schema: SchemaInfo,
  tables: TableInfo[],
  checks: AuditCheck[],
  opts: AuditOptions,
  sampleLimit: number,
  report: AuditReport,
) {
  const q = (id: string) => client.quote(id);
  const tbl = (t: TableInfo | { name: string; schema?: string }) =>
    t.schema ? `${q(t.schema)}.${q(t.name)}` : q(t.name);
  const limit = (sql: string, n: number) =>
    client.engine === 'mssql' ? sql.replace(/^SELECT /, `SELECT TOP ${n} `) : `${sql} LIMIT ${n}`;
  const rows = async (sql: string) => (await client.query(sql, [], { maxRows: sampleLimit })).rows;
  const add = (f: AuditFinding) => report.findings.push(f);

  for (const t of tables) {
    if (checks.includes('orphans')) {
      for (const fk of relationships(schema, t, opts.inferRelationships !== false)) {
        const parent = schema.tables.find((x) => x.name === fk.refTable);
        if (!parent) continue;
        report.coverage.push({ check: 'orphans', table: t.name, columns: [fk.column] });
        const where = `c.${q(fk.column)} IS NOT NULL AND NOT EXISTS (SELECT 1 FROM ${tbl(parent)} p WHERE p.${q(fk.refColumn)} = c.${q(fk.column)})`;
        const n = num((await rows(`SELECT COUNT(*) AS n FROM ${tbl(t)} c WHERE ${where}`))[0]);
        if (n > 0) {
          const sql = `SELECT c.* FROM ${tbl(t)} c WHERE ${where}`;
          add({
            check: 'orphans',
            table: t.name,
            columns: [fk.column],
            count: n,
            severity: 'high',
            message: `${n} row${n === 1 ? '' : 's'} in ${t.name} ${n === 1 ? 'points' : 'point'} to a missing ${fk.refTable} (${fk.column} → ${fk.refTable}.${fk.refColumn}${fk.inferred ? ', inferred from the column name' : ''})`,
            sample: await rows(limit(sql, 5)),
            sql,
          });
        }
      }
    }

    if (checks.includes('duplicates')) {
      const sets = opts.duplicateColumns?.[t.name] ?? defaultDuplicateSets(t);
      for (const cols of sets) {
        if (!cols.every((c) => t.columns.some((x) => x.name === c))) {
          report.notes.push(`${t.name}: unknown column in duplicate check (${cols.join(', ')})`);
          continue;
        }
        report.coverage.push({ check: 'duplicates', table: t.name, columns: cols });
        const list = cols.map(q).join(', ');
        const sql = `SELECT ${list}, COUNT(*) AS n FROM ${tbl(t)} WHERE ${cols.map((c) => `${q(c)} IS NOT NULL`).join(' AND ')} GROUP BY ${list} HAVING COUNT(*) > 1`;
        // Empty strings are "no value", not a duplicate value.
        const groups = (await rows(limit(sql, 500))).filter((g) => cols.every((c) => g[c] !== ''));
        if (groups.length > 0) {
          const extra = groups.reduce((s, g) => s + num(g) - 1, 0);
          add({
            check: 'duplicates',
            table: t.name,
            columns: cols,
            count: groups.length,
            severity: cols.length > 1 || /email|code|sku|username/i.test(cols[0]!) ? 'high' : 'medium',
            message: `${groups.length} duplicate value${groups.length === 1 ? '' : 's'} of (${cols.join(', ')}) in ${t.name} — ${extra} extra row${extra === 1 ? '' : 's'}`,
            sample: groups.slice(0, 5),
            sql,
          });
        }
      }
    }

    if (checks.includes('nulls')) {
      const required =
        opts.requiredColumns?.[t.name] ??
        t.columns.filter((c) => c.nullable && REQUIRED_LIKE.test(c.name)).map((c) => c.name);
      for (const col of required) {
        const info = t.columns.find((c) => c.name === col);
        if (!info) {
          report.notes.push(`${t.name}: unknown required column "${col}"`);
          continue;
        }
        report.coverage.push({ check: 'nulls', table: t.name, columns: [col] });
        const where = `${q(col)} IS NULL${TEXT_TYPE.test(info.type) ? ` OR ${q(col)} = ''` : ''}`;
        const n = num((await rows(`SELECT COUNT(*) AS n FROM ${tbl(t)} WHERE ${where}`))[0]);
        if (n > 0) {
          const sql = `SELECT * FROM ${tbl(t)} WHERE ${where}`;
          add({
            check: 'nulls',
            table: t.name,
            columns: [col],
            count: n,
            severity: 'medium',
            message: `${n} row${n === 1 ? '' : 's'} in ${t.name} ${n === 1 ? 'has' : 'have'} no ${col}`,
            sample: await rows(limit(sql, 5)),
            sql,
          });
        }
      }
    }

    if (checks.includes('formats')) {
      for (const col of t.columns.filter((c) => TEXT_TYPE.test(c.type) || c.type === 'ANY')) {
        const re = /email/i.test(col.name) ? EMAIL : /(phone|mobile)/i.test(col.name) ? PHONE : null;
        if (!re) continue;
        report.coverage.push({ check: 'formats', table: t.name, columns: [col.name] });
        const pk = t.columns.find((c) => c.primaryKey);
        const values = await rows(
          limit(
            `SELECT ${pk ? `${q(pk.name)}, ` : ''}${q(col.name)} FROM ${tbl(t)} WHERE ${q(col.name)} IS NOT NULL`,
            sampleLimit,
          ),
        );
        const bad = values.filter((r) => r[col.name] !== '' && !re.test(String(r[col.name]).trim()));
        if (values.length >= sampleLimit)
          report.notes.push(`${t.name}.${col.name}: format check read the first ${sampleLimit} rows only`);
        if (bad.length > 0)
          add({
            check: 'formats',
            table: t.name,
            columns: [col.name],
            count: bad.length,
            severity: 'medium',
            message: `${bad.length} invalid ${re === EMAIL ? (bad.length === 1 ? 'email address' : 'email addresses') : bad.length === 1 ? 'phone number' : 'phone numbers'} in ${t.name}.${col.name}`,
            sample: bad.slice(0, 5),
          });
      }
    }

    if (checks.includes('negatives')) {
      for (const col of t.columns.filter((c) => NUMERIC_TYPE.test(c.type) && MONEY_LIKE.test(c.name))) {
        report.coverage.push({ check: 'negatives', table: t.name, columns: [col.name] });
        const n = num((await rows(`SELECT COUNT(*) AS n FROM ${tbl(t)} WHERE ${q(col.name)} < 0`))[0]);
        if (n > 0) {
          const sql = `SELECT * FROM ${tbl(t)} WHERE ${q(col.name)} < 0`;
          add({
            check: 'negatives',
            table: t.name,
            columns: [col.name],
            count: n,
            severity: 'high',
            message: `${n} row${n === 1 ? '' : 's'} in ${t.name} ${n === 1 ? 'has' : 'have'} a negative ${col.name}`,
            sample: await rows(limit(sql, 5)),
            sql,
          });
        }
      }
    }
  }
}

// ─── MongoDB (sampled, checked in memory) ──────────────────────────────────

async function auditMongo(
  client: DbClient,
  tables: TableInfo[],
  checks: AuditCheck[],
  opts: AuditOptions,
  sampleLimit: number,
  report: AuditReport,
) {
  if (checks.includes('orphans'))
    report.notes.push('MongoDB has no foreign keys; the orphan check is skipped for collections.');
  for (const t of tables) {
    const docs = (
      await client.query(JSON.stringify({ collection: t.name, find: {}, limit: sampleLimit }), [], {
        maxRows: sampleLimit,
      })
    ).rows;
    if (docs.length >= sampleLimit)
      report.notes.push(`${t.name}: checked the first ${sampleLimit} documents only`);
    const add = (f: Omit<AuditFinding, 'table'>) => report.findings.push({ ...f, table: t.name });

    if (checks.includes('duplicates'))
      for (const cols of opts.duplicateColumns?.[t.name] ?? defaultDuplicateSets(t)) {
        report.coverage.push({ check: 'duplicates', table: t.name, columns: cols });
        const groups = new Map<string, number>();
        for (const d of docs) {
          if (cols.some((c) => d[c] === null || d[c] === undefined || d[c] === '')) continue;
          const k = JSON.stringify(cols.map((c) => d[c]));
          groups.set(k, (groups.get(k) ?? 0) + 1);
        }
        const dups = [...groups].filter(([, n]) => n > 1);
        if (dups.length)
          add({
            check: 'duplicates',
            columns: cols,
            count: dups.length,
            severity: 'high',
            message: `${dups.length} duplicate value${dups.length === 1 ? '' : 's'} of (${cols.join(', ')}) in ${t.name}`,
            sample: dups.slice(0, 5).map(([k, n]) => ({
              ...Object.fromEntries(cols.map((c, i) => [c, (JSON.parse(k) as unknown[])[i]])),
              n,
            })),
          });
      }

    if (checks.includes('nulls'))
      for (const col of opts.requiredColumns?.[t.name] ??
        t.columns.filter((c) => REQUIRED_LIKE.test(c.name)).map((c) => c.name)) {
        report.coverage.push({ check: 'nulls', table: t.name, columns: [col] });
        const bad = docs.filter((d) => d[col] === null || d[col] === undefined || d[col] === '');
        if (bad.length)
          add({
            check: 'nulls',
            columns: [col],
            count: bad.length,
            severity: 'medium',
            message: `${bad.length} document${bad.length === 1 ? '' : 's'} in ${t.name} ${bad.length === 1 ? 'has' : 'have'} no ${col}`,
            sample: bad.slice(0, 5),
          });
      }

    for (const col of t.columns) {
      if (checks.includes('formats')) {
        const re = /email/i.test(col.name) ? EMAIL : /(phone|mobile)/i.test(col.name) ? PHONE : null;
        if (re) {
          report.coverage.push({ check: 'formats', table: t.name, columns: [col.name] });
          const bad = docs.filter(
            (d) => typeof d[col.name] === 'string' && d[col.name] !== '' && !re.test(String(d[col.name])),
          );
          if (bad.length)
            add({
              check: 'formats',
              columns: [col.name],
              count: bad.length,
              severity: 'medium',
              message: `${bad.length} invalid value${bad.length === 1 ? '' : 's'} in ${t.name}.${col.name}`,
              sample: bad.slice(0, 5),
            });
        }
      }
      if (checks.includes('negatives') && MONEY_LIKE.test(col.name) && /number/.test(col.type)) {
        report.coverage.push({ check: 'negatives', table: t.name, columns: [col.name] });
        const bad = docs.filter((d) => typeof d[col.name] === 'number' && (d[col.name] as number) < 0);
        if (bad.length)
          add({
            check: 'negatives',
            columns: [col.name],
            count: bad.length,
            severity: 'high',
            message: `${bad.length} document${bad.length === 1 ? '' : 's'} in ${t.name} ${bad.length === 1 ? 'has' : 'have'} a negative ${col.name}`,
            sample: bad.slice(0, 5),
          });
      }
    }
  }
}
