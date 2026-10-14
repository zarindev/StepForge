import { StepError, VariableResolver } from '@stepforge/core';
import type { StepForgeDb } from '@stepforge/db';
import * as repo from '@stepforge/db/repos';
import { checkPolicy, classifySql, DbError, openClient } from '@stepforge/executor-db';
import type { DataPick, DataProvider } from '@stepforge/executor-util';
import { JSONPath } from 'jsonpath-plus';
import { readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import type { DatabaseService } from '../database/service.ts';

const MAX_ROWS = 5000;
type Row = Record<string, unknown>;
export type LoadedRows = { columns: string[]; rows: Row[] };

/** RFC 4180 CSV: quoted fields, "" escapes, commas and line breaks inside quotes; the first line is the header. */
export function parseCsv(text: string): LoadedRows {
  const records: string[][] = [];
  let field = '';
  let record: string[] = [];
  let quoted = false;
  const src = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"' && field === '') quoted = true;
    else if (ch === ',') {
      record.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      record.push(field);
      records.push(record);
      record = [];
      field = '';
    } else field += ch;
  }
  if (field !== '' || record.length) {
    record.push(field);
    records.push(record);
  }
  const nonEmpty = records.filter((r) => r.some((c) => c.trim() !== ''));
  const [header, ...body] = nonEmpty;
  if (!header) return { columns: [], rows: [] };
  const columns = header.map((h, i) => h.trim() || `column${i + 1}`);
  return {
    columns,
    rows: body.slice(0, MAX_ROWS).map((r) => Object.fromEntries(columns.map((c, i) => [c, r[i] ?? '']))),
  };
}

/**
 * Where a CSV source may read from. Anyone with an API token can create a source and preview it, so the file
 * must look like a data file: only .csv / .tsv / .txt (also after following symlinks). That keeps StepForge's
 * own key, session and database files (data/.key, data/.session.json, data/stepforge.db) and other server files
 * out of reach. Relative paths are taken from the data folder.
 */
const DATA_FILE = /\.(csv|tsv|txt)$/i;
export function csvFilePath(dataDir: string, path: string): string {
  const file = isAbsolute(path) ? path : resolve(dataDir, path);
  let real = file;
  try {
    real = realpathSync(file);
  } catch {
    // a missing file is reported when it is read
  }
  if (!DATA_FILE.test(file) || !DATA_FILE.test(real))
    throw new StepError('invalid_params', `A CSV data source must point to a .csv, .tsv or .txt file (got ${path})`);
  return file;
}

const columnsOf = (rows: Row[]) => [...new Set(rows.flatMap((r) => Object.keys(r)))];

/**
 * Reads the test data library: loads a source's rows (once per run) and hands out rows to `util.useData` steps —
 * first, random, a given row, the row matching a value, or one not used yet in the run.
 */
export class DataService {
  constructor(
    private readonly db: StepForgeDb,
    private readonly dataDir: string,
    private readonly database?: DatabaseService,
  ) {}

  /** Loads a source's rows in an environment (placeholders in its settings resolved with the environment). */
  async load(source: repo.DataSource, environmentId: string, resolver: VariableResolver): Promise<LoadedRows> {
    const cfg = resolver.resolve(source.configJson) as Record<string, unknown>;
    switch (source.kind) {
      case 'table':
        return { columns: source.columnsJson, rows: source.rowsJson };
      case 'csv': {
        const file = csvFilePath(this.dataDir, String(cfg.path));
        let text: string;
        try {
          text = readFileSync(file, 'utf8');
        } catch (err) {
          throw new StepError('invalid_params', `Cannot read the CSV file ${file}: ${(err as Error).message}`);
        }
        return parseCsv(text);
      }
      case 'sql': {
        if (!this.database) throw new StepError('unsupported', 'Databases are not available here');
        const conn = repo.findConnection(this.db, environmentId, String(cfg.connection));
        if (!conn) {
          const env = repo.getEnvironment(this.db, environmentId);
          throw new StepError(
            'invalid_params',
            `No database connection named "${String(cfg.connection)}" in the ${env.name} environment`,
          );
        }
        // Always read-only: a data source never changes the database. Not every driver can enforce that
        // (MSSQL, Mongo; Postgres accepts "SET SESSION ... READ WRITE; DELETE ..."), so the statement is checked
        // like a query on a read-only connection first, and must be a single statement.
        const dbCfg = { ...this.database.config(conn.id), readOnly: true, rollbackMode: false };
        const query = String(cfg.query);
        if (dbCfg.engine !== 'mongo' && classifySql(query, dbCfg.engine).statements.length > 1)
          throw new StepError('invalid_params', 'A SQL data source runs one query; remove the extra statements');
        try {
          await checkPolicy(dbCfg, query);
        } catch (err) {
          if (err instanceof DbError && err.code === 'blocked')
            throw new StepError('invalid_params', 'A SQL data source only reads data; this query would change it');
          throw err;
        }
        const client = await openClient(dbCfg);
        try {
          const r = await client.query(query, [], { maxRows: MAX_ROWS });
          return { columns: r.columns, rows: r.rows };
        } finally {
          await client.close();
        }
      }
      case 'api': {
        const env = repo.getEnvironment(this.db, environmentId);
        const raw = String(cfg.url);
        const url = /^https?:\/\//.test(raw)
          ? raw
          : `${env.baseUrl.replace(/\/$/, '')}/${raw.replace(/^\//, '')}`;
        const res = await fetch(url, {
          method: String(cfg.method ?? 'GET'),
          headers: {
            accept: 'application/json',
            ...(cfg.body ? { 'content-type': 'application/json' } : {}),
            ...((cfg.headers as Record<string, string>) ?? {}),
          },
          body: cfg.body ? String(cfg.body) : undefined,
          signal: AbortSignal.timeout(30_000),
        }).catch((err: Error) => {
          throw new StepError('network', `${url}: ${err.message}`);
        });
        if (!res.ok) throw new StepError('invalid_params', `${url} answered ${res.status} ${res.statusText}`);
        const body = (await res.json().catch(() => {
          throw new StepError('invalid_params', `${url} did not return JSON`);
        })) as unknown;
        const found = JSONPath({ path: String(cfg.rowsPath || '$'), json: body as object, wrap: false }) as unknown;
        const list = Array.isArray(found) ? found : found === undefined ? [] : [found];
        const rows = list
          .slice(0, MAX_ROWS)
          .map((x) => (x && typeof x === 'object' && !Array.isArray(x) ? (x as Row) : { value: x }));
        return { columns: columnsOf(rows), rows };
      }
    }
  }

  /** The provider for one run: rows are loaded once per source, and "not used yet" is tracked across the run. */
  forRun(applicationId: string, environmentId: string, scopes: { env: Row; secrets: Record<string, string> }): DataProvider {
    const loaded = new Map<string, Promise<LoadedRows>>();
    const used = new Map<string, Set<number>>();
    const resolver = new VariableResolver({ env: scopes.env, secret: scopes.secrets });
    return async (req: DataPick) => {
      const source = repo.findDataSource(this.db, applicationId, req.source);
      if (!source) {
        const known = repo.listDataSources(this.db, applicationId).map((d) => d.name);
        throw new StepError(
          'invalid_params',
          `No data source named "${req.source}"${known.length ? ` (known: ${known.join(', ')})` : ''}`,
        );
      }
      let rowsP = loaded.get(source.id);
      if (!rowsP) {
        rowsP = this.load(source, environmentId, resolver);
        loaded.set(source.id, rowsP);
        rowsP.catch(() => loaded.delete(source.id)); // a failed load is tried again by the next step
      }
      const { rows } = await rowsP;
      if (!rows.length) throw new StepError('assertion', `The data source "${source.name}" has no rows`);
      const indexed = rows.map((row, i) => ({ row, i }));
      const pool =
        req.pick === 'match'
          ? indexed.filter((x) => String(x.row[req.column!] ?? '') === String(req.equals ?? ''))
          : indexed;
      let chosen: { row: Row; i: number } | undefined;
      switch (req.pick) {
        case 'random':
          chosen = pool[Math.floor(Math.random() * pool.length)];
          break;
        case 'row': {
          const n = Math.trunc(Number(req.row ?? 1));
          chosen = pool[n - 1];
          if (!chosen)
            throw new StepError('invalid_params', `Row ${n} does not exist: "${source.name}" has ${rows.length} rows`);
          break;
        }
        case 'unused': {
          const taken = used.get(source.id) ?? new Set<number>();
          used.set(source.id, taken);
          chosen = pool.find((x) => !taken.has(x.i));
          if (!chosen)
            throw new StepError(
              'assertion',
              `All ${rows.length} rows of "${source.name}" were already used in this run; add rows or pick another way`,
            );
          taken.add(chosen.i);
          break;
        }
        default:
          chosen = pool[0];
      }
      if (!chosen)
        throw new StepError(
          'assertion',
          `No row of "${source.name}" has ${req.column} = ${JSON.stringify(req.equals ?? '')}`,
        );
      return { row: chosen.row, rowNumber: chosen.i + 1, total: rows.length };
    };
  }

  /** Rows for the Test data tab's preview, in one environment. */
  async preview(id: string, environmentId: string) {
    const source = repo.getDataSource(this.db, id);
    const env = repo.getEnvironment(this.db, environmentId);
    if (env.applicationId !== source.applicationId)
      throw new repo.RepoError(400, 'invalid', 'Environment belongs to another application');
    const resolver = new VariableResolver({
      env: { ...env.variablesJson, baseUrl: env.baseUrl, name: env.name },
      secret: {},
    });
    try {
      const r = await this.load(source, environmentId, resolver);
      return { columns: r.columns.length ? r.columns : columnsOf(r.rows), rows: r.rows.slice(0, 50), total: r.rows.length };
    } catch (err) {
      throw new repo.RepoError(400, 'data_source', (err as Error).message);
    }
  }
}
