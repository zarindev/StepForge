import { openMongo, parseMongoCommand } from './drivers/mongo.ts';
import { openMssql } from './drivers/mssql.ts';
import { openMysql } from './drivers/mysql.ts';
import { openPg } from './drivers/pg.ts';
import { openSqlite } from './drivers/sqlite.ts';
import { classifySql, isMongoWrite } from './sql-guard.ts';
import { DbError, type ConnectionConfig, type DbClient } from './types.ts';

/** Opens a client for any supported engine. Drivers other than SQLite are loaded on first use. */
export async function openClient(cfg: ConnectionConfig): Promise<DbClient> {
  switch (cfg.engine) {
    case 'sqlite':
      return openSqlite(cfg);
    case 'pg':
      return openPg(cfg);
    case 'mysql':
      return openMysql(cfg);
    case 'mssql':
      return openMssql(cfg);
    case 'mongo':
      return openMongo(cfg);
    default:
      throw new DbError('config', `Unsupported database engine "${String(cfg.engine)}"`);
  }
}

export type StatementCheck = { write: boolean; keyword: string };

/** Works out whether a statement (SQL, or a Mongo command as JSON) changes anything. */
export async function inspectStatement(
  cfg: ConnectionConfig,
  text: string,
): Promise<StatementCheck & { transactionControl: boolean }> {
  if (cfg.engine === 'mongo') {
    const cmd = await parseMongoCommand(text);
    const op = Object.keys(cmd).find((k) => k !== 'collection' && typeof cmd[k] !== 'undefined') ?? '';
    return { write: isMongoWrite(cmd), keyword: op, transactionControl: false };
  }
  const c = classifySql(text, cfg.engine);
  const first = c.statements.find((s) => s.kind !== 'read') ?? c.statements[0];
  return { write: c.write, keyword: first?.keyword ?? '', transactionControl: c.transactionControl };
}

/**
 * Enforces the safety rules (Section 12) before anything reaches the database:
 * read-only connections refuse writes, rollback mode owns the transaction, and writes on a production
 * environment need the application's name typed as confirmation.
 */
export async function checkPolicy(
  cfg: ConnectionConfig,
  text: string,
  opts: { confirm?: string; procedure?: boolean } = {},
): Promise<StatementCheck> {
  const check = opts.procedure
    ? { write: true, keyword: 'CALL', transactionControl: false }
    : await inspectStatement(cfg, text);
  if (check.write && cfg.readOnly)
    throw new DbError(
      'blocked',
      `Blocked: connection "${cfg.name}" is read-only, and this ${check.keyword || 'statement'} would change data. ` +
        'Turn off read-only on the connection to allow writes.',
    );
  if (check.transactionControl && cfg.rollbackMode)
    throw new DbError(
      'blocked',
      `Blocked: connection "${cfg.name}" uses rollback mode, so StepForge owns the transaction. ` +
        'Remove BEGIN/COMMIT/ROLLBACK, or turn rollback mode off.',
    );
  if (check.write && cfg.production && opts.confirm?.trim() !== cfg.production.applicationName)
    throw new DbError(
      'blocked',
      `Blocked: "${cfg.name}" belongs to a production environment. ` +
        `Type the application name ("${cfg.production.applicationName}") to confirm this ${check.keyword || 'write'}.`,
    );
  return check;
}

/**
 * A connection used by one test case or one workbench request. In rollback mode, the first write opens a
 * transaction that is rolled back on close, so reads before it still see what the app under test commits.
 */
export class ManagedConnection {
  private inTransaction = false;
  constructor(
    readonly cfg: ConnectionConfig,
    readonly client: DbClient,
  ) {}

  static async open(cfg: ConnectionConfig): Promise<ManagedConnection> {
    return new ManagedConnection(cfg, await openClient(cfg));
  }

  /** Called before running a statement already checked by `checkPolicy`. */
  async prepare(write: boolean): Promise<void> {
    if (write && this.cfg.rollbackMode && !this.inTransaction) {
      await this.client.begin();
      this.inTransaction = true;
    }
  }

  get rolledBack(): boolean {
    return this.inTransaction;
  }

  async close(): Promise<void> {
    try {
      if (this.inTransaction) await this.client.rollback();
    } finally {
      this.inTransaction = false;
      await this.client.close();
    }
  }
}
