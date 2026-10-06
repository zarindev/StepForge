import { DEFAULT_RUN_OPTIONS, newId, runTestCase, type StepInput } from '@stepforge/core';
import Database from 'better-sqlite3';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  checkPolicy,
  classifySql,
  createDbExecutor,
  openClient,
  relationships,
  resultTarget,
  runAudit,
  splitStatements,
  type ConnectionConfig,
} from '../src/index.ts';

let file = '';
const cfg = (over: Partial<ConnectionConfig> = {}): ConnectionConfig => ({
  name: 'clinic',
  engine: 'sqlite',
  host: '',
  database: file,
  username: '',
  options: {},
  readOnly: false,
  rollbackMode: false,
  ...over,
});

beforeEach(() => {
  file = join(mkdtempSync(join(tmpdir(), 'sf-db-')), 'shop.db');
  const db = new Database(file);
  db.pragma('foreign_keys = OFF'); // the fixture plants orphan rows on purpose
  db.exec(`
    CREATE TABLE customers (id INTEGER PRIMARY KEY, full_name TEXT NOT NULL, dob TEXT, email TEXT, phone TEXT);
    CREATE TABLE orders (id INTEGER PRIMARY KEY, customer_id INTEGER, total REAL NOT NULL, status TEXT);
    CREATE TABLE items (id INTEGER PRIMARY KEY, order_id INTEGER REFERENCES orders(id), qty INTEGER);
    CREATE UNIQUE INDEX customers_phone ON customers(phone);
    INSERT INTO customers VALUES (1, 'Ana Lopez', '1988-04-12', 'ana@example.test', '+1 555 0101');
    INSERT INTO customers VALUES (2, 'Ben Carter', '1975-09-30', 'not-an-email', '+1 555 0102');
    INSERT INTO customers VALUES (3, 'Ana Lopez', '1988-04-12', 'ana@example.test', '+1 555 0103');
    INSERT INTO orders VALUES (1, 1, 30.5, 'paid'), (2, 99, 12, 'paid'), (3, 2, -4, NULL);
    INSERT INTO items VALUES (1, 1, 2), (2, 42, 1);
  `);
  db.close();
});

const steps = (...s: StepInput[]) =>
  s.map((x) => ({
    enabled: true,
    continueOnFail: false,
    retries: 0,
    params: {},
    locators: [],
    assertions: [],
    id: newId(),
    ...x,
  }));
const run = (s: ReturnType<typeof steps>, over: Partial<ConnectionConfig> = {}) =>
  runTestCase({
    runId: 'R',
    steps: s,
    executors: [
      createDbExecutor({
        resolve: async (name) => {
          if (name !== 'clinic') throw new Error(`No connection named "${name}"`);
          return cfg(over);
        },
      }),
    ],
    options: { ...DEFAULT_RUN_OPTIONS, defaultTimeoutMs: 5000 },
    artifactsDir: '/tmp',
    secrets: { dbSecret: 'Ana Lopez' },
  });
const count = (sql: string) => {
  const db = new Database(file, { readonly: true });
  const n = (db.prepare(sql).get() as { n: number }).n;
  db.close();
  return n;
};

describe('SQL guard', () => {
  it('classifies reads and writes', () => {
    expect(classifySql('SELECT * FROM t').write).toBe(false);
    expect(classifySql('  -- comment\n select 1; /* x */ SHOW tables').write).toBe(false);
    expect(classifySql('WITH x AS (SELECT 1) SELECT * FROM x').write).toBe(false);
    expect(classifySql("SELECT 'DELETE FROM t' AS s").write).toBe(false);
    for (const w of [
      'DELETE FROM t',
      'update t set a=1',
      'INSERT INTO t VALUES (1)',
      'DROP TABLE t',
      'WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d',
      'SELECT * INTO backup FROM t',
      'PRAGMA foreign_keys = OFF',
      'EXPLAIN ANALYZE DELETE FROM t',
      'CALL do_things()',
      'SET TRANSACTION READ WRITE',
      'SELECT 1; DELETE FROM t',
      'vacuum',
    ])
      expect(classifySql(w).write, w).toBe(true);
    expect(classifySql('BEGIN; SELECT 1; COMMIT').transactionControl).toBe(true);
  });

  it('cannot be fooled by quoting differences between engines', () => {
    // In PostgreSQL/SQL Server the backslash does not escape, so this runs a DROP.
    expect(classifySql("SELECT 'a\\'; DROP TABLE t; --'", 'mysql').write).toBe(true);
    expect(classifySql("SELECT 'a\\'; DROP TABLE t; --'", 'pg').write).toBe(true);
    expect(classifySql('SELECT 1 # ; DROP TABLE t', 'mysql').write).toBe(true);
    expect(classifySql('SELECT $x$ ; DROP TABLE t; $x$', 'pg').write).toBe(true);
  });

  it('splits scripts on top-level semicolons only', () => {
    expect(splitStatements("INSERT INTO t VALUES ('a;b'); -- c;\nSELECT 1;\n\n")).toEqual([
      "INSERT INTO t VALUES ('a;b')",
      '-- c;\nSELECT 1',
    ]);
  });
});

describe('connection policy', () => {
  it('blocks writes on read-only connections and transaction control in rollback mode', async () => {
    await expect(checkPolicy(cfg({ readOnly: true }), 'DELETE FROM orders')).rejects.toThrow(/read-only/);
    await expect(checkPolicy(cfg({ readOnly: true }), 'SELECT 1')).resolves.toMatchObject({ write: false });
    await expect(checkPolicy(cfg({ rollbackMode: true }), 'COMMIT')).rejects.toThrow(/rollback mode/);
  });

  it('requires the application name for writes on production', async () => {
    const prod = cfg({ production: { applicationName: 'CareClinic' } });
    await expect(checkPolicy(prod, 'UPDATE orders SET total = 0')).rejects.toThrow(
      /Type the application name/,
    );
    await expect(
      checkPolicy(prod, 'UPDATE orders SET total = 0', { confirm: 'careclinic' }),
    ).rejects.toThrow();
    await expect(
      checkPolicy(prod, 'UPDATE orders SET total = 0', { confirm: 'CareClinic' }),
    ).resolves.toMatchObject({
      write: true,
    });
    await expect(checkPolicy(prod, 'SELECT 1')).resolves.toMatchObject({ write: false });
  });

  it('opens SQLite read-only at the driver level too', async () => {
    const c = await openClient(cfg({ readOnly: true }));
    await expect(c.query('DELETE FROM orders')).rejects.toThrow(/readonly/i);
    await c.close();
  });
});

describe('db executor', () => {
  it('queries with parameters and asserts on rows, cells and columns', async () => {
    const r = await run(
      steps({
        type: 'db.query',
        params: {
          connection: 'clinic',
          sql: 'SELECT * FROM customers WHERE full_name = ? ORDER BY id',
          params: ['{{secret.dbSecret}}'],
        },
        captureAs: 'rows',
        assertions: [
          { target: 'rowCount', operator: 'equals', expected: 2 },
          { target: 'rows[0].email', operator: 'equals', expected: 'ana@example.test' },
          { target: 'email', operator: 'contains', expected: '@' },
          { target: 'column:id', operator: 'unique' },
          { target: 'column:phone', operator: 'noNulls' },
          { target: 'column:id', operator: 'inRange', expected: { min: 1, max: 3 } },
          { target: '$[1].id', operator: 'equals', expected: 3 },
        ],
      }),
    );
    expect(r.status, r.error).toBe('passed');
    expect((r.vars.rows as unknown[]).length).toBe(2);
    const q = r.steps[0]!.query as { sql: string; params: unknown[]; rows: unknown[] };
    expect(q.rows).toHaveLength(2);
    // The secret used as a parameter is masked in the stored result.
    expect(q.params).toEqual(['••••']);
    expect(JSON.stringify(r.steps[0])).not.toContain('Ana Lopez');
  });

  it('fails with a clear message when an assertion does not hold', async () => {
    const r = await run(
      steps({
        type: 'db.query',
        params: { connection: 'clinic', sql: 'SELECT total FROM orders' },
        assertions: [{ target: 'column:total', operator: 'inRange', expected: '0..' }],
      }),
    );
    expect(r.status).toBe('failed');
    expect(r.error).toMatch(/Expected column:total inRange/);
  });

  it('extracts values for later steps, including COUNT(*) as "value"', async () => {
    const r = await run(
      steps(
        { type: 'db.query', params: { connection: 'clinic', sql: 'SELECT COUNT(*) AS n FROM orders' } },
        { type: 'db.extract', params: { path: 'value' }, captureAs: 'orders' },
        {
          type: 'db.query',
          params: { connection: 'clinic', sql: 'SELECT id FROM orders WHERE id <= {{vars.orders}}' },
          assertions: [{ target: 'rowCount', operator: 'equals', expected: '{{vars.orders}}' }],
        },
      ),
    );
    expect(r.status, r.error).toBe('passed');
    expect(r.vars.orders).toBe(3);
  });

  it('blocks writes on a read-only connection and marks the test broken', async () => {
    const r = await run(
      steps({ type: 'db.query', params: { connection: 'clinic', sql: 'DELETE FROM orders' } }),
      { readOnly: true },
    );
    expect(r.status).toBe('broken');
    expect(r.error).toMatch(/read-only/);
    expect(count('SELECT COUNT(*) n FROM orders')).toBe(3);
  });

  it('rolls back every write at the end of the test in rollback mode', async () => {
    const r = await run(
      steps(
        {
          type: 'db.query',
          params: {
            connection: 'clinic',
            sql: "INSERT INTO orders (customer_id, total, status) VALUES (1, 5, 'new')",
          },
        },
        {
          type: 'db.runScript',
          params: { connection: 'clinic', script: 'UPDATE orders SET total = 0; DELETE FROM items;' },
        },
        {
          type: 'db.query',
          params: { connection: 'clinic', sql: 'SELECT COUNT(*) AS n, SUM(total) AS s FROM orders' },
          assertions: [
            { target: 'n', operator: 'equals', expected: 4 },
            { target: 's', operator: 'equals', expected: 0 },
          ],
        },
      ),
      { rollbackMode: true },
    );
    expect(r.status, r.error).toBe('passed');
    expect(r.steps[0]!.message).toMatch(/rolled back/);
    expect(count('SELECT COUNT(*) n FROM orders')).toBe(3);
    expect(count('SELECT COUNT(*) n FROM items')).toBe(2);
  });

  it('commits when rollback mode is off', async () => {
    const r = await run(
      steps({
        type: 'db.runScript',
        params: { connection: 'clinic', script: 'DELETE FROM items WHERE id = 2;' },
      }),
    );
    expect(r.status, r.error).toBe('passed');
    expect(count('SELECT COUNT(*) n FROM items')).toBe(1);
  });

  it('separates SQL authoring errors (broken) from constraint failures (failed)', async () => {
    const bad = await run(
      steps({ type: 'db.query', params: { connection: 'clinic', sql: 'SELECT * FROM nope' } }),
    );
    expect(bad.status).toBe('broken');
    const constraint = await run(
      steps({
        type: 'db.query',
        params: { connection: 'clinic', sql: "INSERT INTO customers (id, full_name) VALUES (1, 'x')" },
      }),
    );
    expect(constraint.status).toBe('failed');
    expect(constraint.error).toMatch(/UNIQUE/);
    const unknown = await run(steps({ type: 'db.query', params: { connection: 'other', sql: 'SELECT 1' } }));
    expect(unknown.status).toBe('broken');
    expect(unknown.error).toMatch(/No connection named "other"/);
  });

  it('runs a data-quality check as a step', async () => {
    const r = await run(
      steps({ type: 'db.dataQualityCheck', params: { connection: 'clinic', tables: ['orders'] } }),
    );
    expect(r.status).toBe('failed');
    expect(r.steps[0]!.assertions.map((a) => a.message).join('\n')).toMatch(/negative total/);
  });
});

describe('data-quality audit', () => {
  it('finds orphans (declared and inferred), duplicates, missing values, bad formats and negatives', async () => {
    const c = await openClient(cfg({ readOnly: true }));
    const schema = await c.schema();
    const orders = schema.tables.find((t) => t.name === 'orders')!;
    expect(relationships(schema, orders, true)).toEqual([
      { column: 'customer_id', refTable: 'customers', refColumn: 'id', inferred: true },
    ]);
    const report = await runAudit(c, schema);
    await c.close();
    const by = (check: string, table: string) =>
      report.findings.find((f) => f.check === check && f.table === table);
    expect(by('orphans', 'orders')).toMatchObject({ count: 1, columns: ['customer_id'] });
    expect(by('orphans', 'items')).toMatchObject({ count: 1, columns: ['order_id'] });
    expect(report.findings.find((f) => f.columns.length === 2)?.message).toMatch(
      /1 duplicate value of \(full_name, dob\) in customers — 1 extra row/,
    );
    // email duplicates too; phone has a unique index so it is not checked.
    expect(report.findings.filter((f) => f.check === 'duplicates').map((f) => f.columns.join('+'))).toEqual([
      'email',
      'full_name+dob',
    ]);
    expect(by('nulls', 'orders')).toMatchObject({ columns: ['status'], count: 1 });
    expect(by('formats', 'customers')).toMatchObject({ columns: ['email'], count: 1 });
    expect(by('negatives', 'orders')).toMatchObject({ columns: ['total'], count: 1 });
    expect(report.coverage.length).toBeGreaterThan(5);
  });

  it('honours chosen checks, tables and columns', async () => {
    const c = await openClient(cfg());
    const report = await runAudit(c, await c.schema(), {
      tables: ['customers', 'ghost'],
      checks: ['duplicates'],
      duplicateColumns: { customers: [['phone']] },
    });
    await c.close();
    expect(report.findings).toEqual([]);
    expect(report.notes).toContain('Table "ghost" was not found');
  });

  it('reads result targets', () => {
    const r = {
      columns: ['a', 'b'],
      rows: [
        { a: 1, b: 'x' },
        { a: 2, b: null },
      ],
      rowCount: 2,
      durationMs: 1,
    };
    expect(resultTarget(r, 'value')).toBe(1);
    expect(resultTarget(r, 'column:b')).toEqual(['x', null]);
    expect(resultTarget(r, 'rows[1]')).toEqual({ a: 2, b: null });
    expect(resultTarget(r, 'b')).toBe('x');
    expect(resultTarget(r, '$[*].a')).toEqual([1, 2]);
  });
});
