import {
  StepError,
  type Executor,
  type ExecutorSession,
  type RunnableStep,
  type StepContext,
  type StepOutcome,
} from '@stepforge/core';
import { JSONPath } from 'jsonpath-plus';
import { runAudit, type AuditCheck, type AuditOptions, type AuditReport } from './audit.ts';
import { checkPolicy, ManagedConnection } from './connection.ts';
import { DIALECTS, splitStatements } from './sql-guard.ts';
import { DbError, type ConnectionConfig, type QueryResult } from './types.ts';

export * from './types.ts';
export * from './sql-guard.ts';
export * from './audit.ts';
export { openClient, checkPolicy, inspectStatement, ManagedConnection } from './connection.ts';
export { parseMongoCommand } from './drivers/mongo.ts';

/** Finds a connection by name (or id) in the run's environment. Provided by the host; decrypts the password. */
export type ConnectionResolver = (ref: string) => Promise<ConnectionConfig>;

/** Rows kept on the step result for the report (the full result is available to assertions and captureAs). */
const STORED_ROWS = 50;

/** Reads a value from a query result for an assertion target or `db.extract`. */
export function resultTarget(r: QueryResult, target: string): unknown {
  const t = target.trim();
  if (t === 'rowCount' || t === 'count') return r.rowCount;
  if (t === 'affected' || t === 'affectedRows') return r.affected ?? 0;
  if (t === 'rows') return r.rows;
  if (t === 'columns') return r.columns;
  if (t === 'time' || t === 'durationMs') return r.durationMs;
  // First column of the first row — handy for SELECT COUNT(*) …
  if (t === 'value' || t === 'scalar') {
    const first = r.rows[0];
    return first ? first[r.columns[0] ?? Object.keys(first)[0]!] : undefined;
  }
  const col = /^(?:column|col)[:.](.+)$/.exec(t);
  if (col) return r.rows.map((row) => row[col[1]!]);
  const cell = /^rows?\[(\d+)\](?:\.(.+))?$/.exec(t);
  if (cell) {
    const row = r.rows[Number(cell[1])];
    return cell[2] ? row?.[cell[2]] : row;
  }
  if (t.startsWith('$')) {
    const found = JSONPath({ path: t, json: r.rows, wrap: true }) as unknown[];
    if (found.length === 0) return undefined;
    return found.length === 1 && !/[*?]|\.\.|\[[^\]]*[:,]/.test(t) ? found[0] : found;
  }
  // A bare column name reads that column of the first row.
  if (r.columns.includes(t) || (r.rows[0] && t in r.rows[0])) return r.rows[0]?.[t];
  return undefined;
}

/** SQL errors that mean the test itself is wrong (broken), as opposed to the data/app misbehaving (failed). */
const AUTHORING_ERROR =
  /syntax|no such (table|column|function)|does not exist|unknown (column|table)|doesn't exist|invalid (object|column) name|must be json|needs (a|exactly)|incomplete input|bind|parameter/i;

const toStepError = (err: unknown): StepError => {
  if (err instanceof StepError) return err;
  if (err instanceof DbError) {
    const kind =
      err.code === 'connection'
        ? 'network'
        : err.code === 'unsupported'
          ? 'unsupported'
          : err.code === 'query' && !AUTHORING_ERROR.test(err.message)
            ? 'assertion'
            : 'invalid_params';
    return new StepError(kind, err.message);
  }
  return new StepError('unknown', (err as Error).message);
};

class DbSession implements ExecutorSession {
  private conns = new Map<string, ManagedConnection>();
  private last: QueryResult | null = null;

  constructor(private readonly resolve: ConnectionResolver) {}

  private async conn(ref: unknown): Promise<ManagedConnection> {
    const name = String(ref ?? '').trim();
    if (!name) throw new StepError('invalid_params', 'Choose a database connection for this step');
    const open = this.conns.get(name);
    if (open) return open;
    let cfg: ConnectionConfig;
    try {
      cfg = await this.resolve(name);
    } catch (err) {
      throw new StepError('invalid_params', (err as Error).message);
    }
    const c = await ManagedConnection.open(cfg);
    this.conns.set(name, c);
    return c;
  }

  async execute(step: RunnableStep, ctx: StepContext): Promise<StepOutcome> {
    const p = step.params as Record<string, unknown>;
    const name = step.type.split('.')[1];
    try {
      switch (name) {
        case 'query':
        case 'mongoFind':
          return await this.query(p, name === 'mongoFind');
        case 'runScript':
          return await this.script(p, ctx);
        case 'callProcedure':
          return await this.procedure(p);
        case 'extract':
          return this.extract(p);
        case 'dataQualityCheck':
          return await this.audit(p);
        default:
          throw new StepError('unsupported', `Unknown database step "${step.type}"`);
      }
    } catch (err) {
      throw toStepError(err);
    }
  }

  private outcome(
    c: ManagedConnection,
    text: string,
    params: unknown[],
    r: QueryResult,
    extra = {},
  ): StepOutcome {
    this.last = r;
    const summary =
      r.affected !== undefined && r.columns.length === 0
        ? `${r.affected} row${r.affected === 1 ? '' : 's'} affected`
        : `${r.rowCount} row${r.rowCount === 1 ? '' : 's'}`;
    return {
      message: `${c.cfg.name}: ${summary} in ${r.durationMs} ms${c.rolledBack ? ' (will be rolled back)' : ''}`,
      output: r.rows,
      query: {
        connection: c.cfg.name,
        engine: c.cfg.engine,
        sql: text,
        params,
        columns: r.columns,
        rows: r.rows.slice(0, STORED_ROWS),
        rowCount: r.rowCount,
        affected: r.affected,
        truncated: r.truncated || r.rows.length > STORED_ROWS,
        durationMs: r.durationMs,
        rollbackMode: c.cfg.rollbackMode,
        readOnly: c.cfg.readOnly,
        ...extra,
      },
      getTarget: (t) => resultTarget(r, t),
      metrics: [{ metric: 'db.query_time', value: r.durationMs, unit: 'ms' }],
    };
  }

  private async query(p: Record<string, unknown>, mongoFind: boolean): Promise<StepOutcome> {
    const c = await this.conn(p.connection);
    let text: string;
    if (mongoFind) {
      if (c.cfg.engine !== 'mongo')
        throw new StepError(
          'invalid_params',
          `db.mongoFind needs a MongoDB connection ("${c.cfg.name}" is ${c.cfg.engine})`,
        );
      if (!p.collection) throw new StepError('invalid_params', 'db.mongoFind needs a "collection"');
      text = JSON.stringify({
        collection: p.collection,
        find: p.filter ?? {},
        ...(p.projection ? { projection: p.projection } : {}),
        ...(p.sort ? { sort: p.sort } : {}),
        ...(p.limit ? { limit: Number(p.limit) } : {}),
      });
    } else {
      text = typeof p.sql === 'string' ? p.sql : p.sql ? JSON.stringify(p.sql) : '';
      if (!text.trim())
        throw new StepError('invalid_params', 'db.query needs SQL (or a Mongo command as JSON)');
    }
    const params = Array.isArray(p.params) ? p.params : [];
    const check = await checkPolicy(c.cfg, text, { confirm: p.confirmProduction as string | undefined });
    await c.prepare(check.write);
    const r = await c.client.query(text, params, { maxRows: Number(p.maxRows ?? 1000) });
    return this.outcome(c, text, params, r);
  }

  private async script(p: Record<string, unknown>, ctx: StepContext): Promise<StepOutcome> {
    const c = await this.conn(p.connection);
    if (c.cfg.engine === 'mongo')
      throw new StepError('unsupported', 'db.runScript runs SQL; use db.query for MongoDB');
    const text = String(p.script ?? p.sql ?? '');
    const statements = splitStatements(text, DIALECTS[c.cfg.engine]);
    if (statements.length === 0)
      throw new StepError('invalid_params', 'db.runScript needs at least one SQL statement');
    const check = await checkPolicy(c.cfg, text, { confirm: p.confirmProduction as string | undefined });
    await c.prepare(check.write);
    let last: QueryResult | undefined;
    let affected = 0;
    const started = performance.now();
    for (const [i, sql] of statements.entries()) {
      if (ctx.signal.aborted) throw new StepError('aborted', 'Run cancelled');
      try {
        last = await c.client.query(sql, [], { maxRows: Number(p.maxRows ?? 1000) });
      } catch (err) {
        throw new StepError(
          'assertion',
          `Statement ${i + 1} of ${statements.length} failed: ${(err as Error).message}`,
        );
      }
      affected += last.affected ?? 0;
    }
    const r: QueryResult = {
      ...last!,
      affected: last!.columns.length ? last!.affected : affected,
      statements: statements.length,
      durationMs: Math.round(performance.now() - started),
    };
    return this.outcome(c, text, [], r, { statements: statements.length });
  }

  private async procedure(p: Record<string, unknown>): Promise<StepOutcome> {
    const c = await this.conn(p.connection);
    const proc = String(p.procedure ?? p.name ?? '').trim();
    if (!/^[A-Za-z_][\w.$]*$/.test(proc))
      throw new StepError(
        'invalid_params',
        'db.callProcedure needs a procedure name (letters, digits, _ . $)',
      );
    const args = Array.isArray(p.args) ? p.args : [];
    await checkPolicy(c.cfg, `CALL ${proc}`, {
      procedure: true,
      confirm: p.confirmProduction as string | undefined,
    });
    await c.prepare(true);
    const r = await c.client.callProcedure(proc, args, { maxRows: Number(p.maxRows ?? 1000) });
    return this.outcome(c, `CALL ${proc}(${args.length} argument${args.length === 1 ? '' : 's'})`, args, r);
  }

  private extract(p: Record<string, unknown>): StepOutcome {
    if (!this.last)
      throw new StepError('invalid_params', 'db.extract needs an earlier database step in this test');
    const r = this.last;
    const path = String(p.path ?? p.target ?? 'value');
    const value = resultTarget(r, path);
    if (value === undefined && p.required !== false)
      throw new StepError('assertion', `Nothing found at "${path}" in the last query result`);
    return {
      output: value,
      message: `Extracted ${JSON.stringify(value)?.slice(0, 120)}`,
      getTarget: (t) => (t === 'value' ? value : resultTarget(r, t)),
    };
  }

  private async audit(p: Record<string, unknown>): Promise<StepOutcome> {
    const c = await this.conn(p.connection);
    const opts: AuditOptions = {
      tables: Array.isArray(p.tables)
        ? (p.tables as string[])
        : typeof p.tables === 'string' && p.tables.trim()
          ? p.tables.split(',').map((t) => t.trim())
          : undefined,
      checks: Array.isArray(p.checks) ? (p.checks as AuditCheck[]) : undefined,
      duplicateColumns: p.duplicateColumns as AuditOptions['duplicateColumns'],
      requiredColumns: p.requiredColumns as AuditOptions['requiredColumns'],
      inferRelationships: p.inferRelationships !== false,
    };
    const report: AuditReport = await runAudit(c.client, await c.client.schema(), opts);
    const maxIssues = Number(p.maxIssues ?? 0);
    const total = report.findings.length;
    return {
      message: `${c.cfg.name}: ${total} data-quality issue${total === 1 ? '' : 's'} in ${report.tables.length} table${report.tables.length === 1 ? '' : 's'}`,
      output: report,
      query: { connection: c.cfg.name, engine: c.cfg.engine, audit: report },
      assertions: [
        ...report.findings.map((f) => ({
          target: `${f.check}:${f.table}.${f.columns.join('+')}`,
          operator: 'isEmpty',
          actual: f.count,
          passed: total <= maxIssues,
          message: f.message,
        })),
        ...(total === 0
          ? [
              {
                target: 'audit',
                operator: 'isEmpty',
                passed: true,
                message: `No issues found (${report.coverage.length} checks)`,
              },
            ]
          : []),
      ],
      getTarget: (t) =>
        t === 'issues' || t === 'findings' ? report.findings.length : t === 'report' ? report : undefined,
    };
  }

  async close(): Promise<never[]> {
    const all = [...this.conns.values()];
    this.conns.clear();
    await Promise.all(all.map((c) => c.close().catch(() => undefined)));
    return [];
  }
}

export function createDbExecutor(opts: { resolve: ConnectionResolver }): Executor {
  return {
    group: 'db',
    async createSession() {
      return new DbSession(opts.resolve);
    },
  };
}
