/**
 * Integration tests against real database servers. They run only when a URL is provided, e.g.
 *   STEPFORGE_TEST_PG_URL=postgres://user:pass@127.0.0.1:5432/stepforge_test
 *   STEPFORGE_TEST_MYSQL_URL=mysql://user:pass@127.0.0.1:3306/stepforge_test
 *   STEPFORGE_TEST_MSSQL_URL="Server=127.0.0.1,1433;Database=master;User Id=sa;Password=…;TrustServerCertificate=true"
 *   STEPFORGE_TEST_MONGO_URL=mongodb://127.0.0.1:27017
 * CI provides them through service containers; locally, point them at any server you own.
 * The tests create and drop their own tables (customers, orders, items) — use a scratch database.
 */
import { DEFAULT_RUN_OPTIONS, newId, runTestCase, type StepInput } from '@stepforge/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createDbExecutor,
  ManagedConnection,
  openClient,
  runAudit,
  type ConnectionConfig,
  type DbClient,
  type DbEngine,
} from '../src/index.ts';

type SqlEngine = Exclude<DbEngine, 'sqlite' | 'mongo'>;
const SQL: [SqlEngine, string | undefined][] = [
  ['pg', process.env.STEPFORGE_TEST_PG_URL],
  ['mysql', process.env.STEPFORGE_TEST_MYSQL_URL],
  ['mssql', process.env.STEPFORGE_TEST_MSSQL_URL],
];
const MONGO = process.env.STEPFORGE_TEST_MONGO_URL;

const cfgFor = (engine: DbEngine, url: string, over: Partial<ConnectionConfig> = {}): ConnectionConfig => ({
  name: `${engine}-test`,
  engine,
  host: '',
  database: engine === 'mongo' ? 'stepforge_test' : '',
  username: '',
  options: engine === 'mongo' ? { uri: url } : { connectionString: url },
  readOnly: false,
  rollbackMode: false,
  ...over,
});

/** Placeholder syntax per engine for the parameterised query test. */
const PARAM: Record<SqlEngine, string> = { pg: '$1', mysql: '?', mssql: '@p1' };

function setupSql(engine: SqlEngine): string[] {
  const money = 'DECIMAL(10,2)';
  return [
    'DROP TABLE IF EXISTS items',
    'DROP TABLE IF EXISTS orders',
    'DROP TABLE IF EXISTS customers',
    `CREATE TABLE customers (id INT PRIMARY KEY, full_name VARCHAR(100) NOT NULL, dob VARCHAR(10), email VARCHAR(100), phone VARCHAR(30))`,
    `CREATE TABLE orders (id INT PRIMARY KEY, customer_id INT, total ${money} NOT NULL, status VARCHAR(20))`,
    // Table-level FOREIGN KEY: MySQL before 9.0 parses an inline column REFERENCES but ignores it.
    `CREATE TABLE items (id INT PRIMARY KEY, order_id INT, qty INT, FOREIGN KEY (order_id) REFERENCES orders(id))`,
    `CREATE UNIQUE INDEX customers_phone_uq ON customers (phone)`,
    `INSERT INTO customers (id, full_name, dob, email, phone) VALUES (1, 'Ana Lopez', '1988-04-12', 'ana@example.test', '+1 555 0101')`,
    `INSERT INTO customers (id, full_name, dob, email, phone) VALUES (2, 'Ben Carter', '1975-09-30', 'not-an-email', '+1 555 0102')`,
    `INSERT INTO customers (id, full_name, dob, email, phone) VALUES (3, 'Ana Lopez', '1988-04-12', 'ana@example.test', '+1 555 0103')`,
    `INSERT INTO orders (id, customer_id, total, status) VALUES (1, 1, 30.50, 'paid')`,
    `INSERT INTO orders (id, customer_id, total, status) VALUES (2, 99, 12, 'paid')`,
    `INSERT INTO orders (id, customer_id, total, status) VALUES (3, 2, -4, NULL)`,
    `INSERT INTO items (id, order_id, qty) VALUES (1, 1, 2)`,
    ...(engine === 'pg'
      ? [
          "CREATE OR REPLACE PROCEDURE sf_close_orders() LANGUAGE SQL AS $$ UPDATE orders SET status = 'closed' $$",
        ]
      : engine === 'mysql'
        ? [
            'DROP PROCEDURE IF EXISTS sf_close_orders',
            "CREATE PROCEDURE sf_close_orders() UPDATE orders SET status = 'closed'",
          ]
        : [
            "IF OBJECT_ID('sf_close_orders', 'P') IS NOT NULL DROP PROCEDURE sf_close_orders",
            "CREATE PROCEDURE sf_close_orders AS UPDATE orders SET status = 'closed'",
          ]),
  ];
}

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

for (const [engine, url] of SQL) {
  describe.skipIf(!url)(`${engine} server`, () => {
    let admin: DbClient;
    const cfg = (over: Partial<ConnectionConfig> = {}) => cfgFor(engine, url!, over);
    const count = async (sql: string) => Number(Object.values((await admin.query(sql)).rows[0]!)[0]);

    beforeAll(async () => {
      admin = await openClient(cfg());
      for (const sql of setupSql(engine)) await admin.query(sql);
    }, 60_000);
    afterAll(async () => {
      if (!admin) return;
      for (const sql of [
        'DROP TABLE IF EXISTS items',
        'DROP TABLE IF EXISTS orders',
        'DROP TABLE IF EXISTS customers',
      ])
        await admin.query(sql).catch(() => undefined);
      await admin.close();
    });

    it('reads the schema: columns, keys and indexes', async () => {
      const s = await admin.schema();
      const t = (n: string) => s.tables.find((x) => x.name === n)!;
      expect(t('customers').columns.map((c) => c.name)).toEqual(['id', 'full_name', 'dob', 'email', 'phone']);
      expect(t('customers').columns.find((c) => c.name === 'id')).toMatchObject({
        primaryKey: true,
        nullable: false,
      });
      expect(t('customers').indexes.find((i) => i.name === 'customers_phone_uq')).toMatchObject({
        unique: true,
        columns: ['phone'],
      });
      expect(t('items').foreignKeys).toEqual([{ column: 'order_id', refTable: 'orders', refColumn: 'id' }]);
    });

    it('refuses writes at the driver level on read-only connections (beyond the statement guard)', async () => {
      if (engine === 'mssql') return; // SQL Server has no read-only session; see KNOWN_ISSUES
      const ro = await openClient(cfg({ readOnly: true }));
      await expect(ro.query('DELETE FROM items')).rejects.toThrow(/read.only/i);
      await ro.close();
      expect(await count('SELECT COUNT(*) AS n FROM items')).toBe(1);
    });

    it('rolls back in rollback mode while still seeing rows other clients commit', async () => {
      const conn = await ManagedConnection.open(cfg({ rollbackMode: true }));
      await conn.prepare(true);
      await conn.client.query('DELETE FROM items');
      // The app under test commits a row meanwhile; the rollback transaction must see it.
      await admin.query("INSERT INTO orders (id, customer_id, total, status) VALUES (50, 1, 1, 'new')");
      expect(
        Number(
          Object.values(
            (await conn.client.query('SELECT COUNT(*) AS n FROM orders WHERE id = 50')).rows[0]!,
          )[0],
        ),
      ).toBe(1);
      expect(
        Number(Object.values((await conn.client.query('SELECT COUNT(*) AS n FROM items')).rows[0]!)[0]),
      ).toBe(0);
      await conn.close();
      expect(await count('SELECT COUNT(*) AS n FROM items')).toBe(1);
      await admin.query('DELETE FROM orders WHERE id = 50');
    });

    it('runs DB steps with parameters, procedures and assertions', async () => {
      const r = await runTestCase({
        runId: 'R',
        steps: steps(
          {
            type: 'db.query',
            params: {
              connection: 'x',
              sql: `SELECT id, email FROM customers WHERE full_name = ${PARAM[engine]} ORDER BY id`,
              params: ['Ana Lopez'],
            },
            assertions: [
              { target: 'rowCount', operator: 'equals', expected: 2 },
              { target: 'rows[1].id', operator: 'equals', expected: 3 },
              { target: 'column:id', operator: 'unique' },
            ],
          },
          { type: 'db.callProcedure', params: { connection: 'x', procedure: 'sf_close_orders' } },
          {
            type: 'db.query',
            params: { connection: 'x', sql: "SELECT COUNT(*) AS n FROM orders WHERE status = 'closed'" },
            assertions: [{ target: 'value', operator: 'equals', expected: 3 }],
          },
        ),
        executors: [createDbExecutor({ resolve: async () => cfg({ rollbackMode: true }) })],
        options: { ...DEFAULT_RUN_OPTIONS, defaultTimeoutMs: 20_000 },
        artifactsDir: '/tmp',
      });
      expect(r.status, r.error).toBe('passed');
      expect(await count("SELECT COUNT(*) AS n FROM orders WHERE status = 'closed'")).toBe(0);
    }, 60_000);

    it('audits data quality', async () => {
      const report = await runAudit(admin, await admin.schema(), {
        tables: ['customers', 'orders', 'items'],
      });
      const found = report.findings
        .map((f) => `${f.check}:${f.table}.${f.columns.join('+')}=${f.count}`)
        .sort();
      expect(found).toEqual([
        'duplicates:customers.email=1',
        'duplicates:customers.full_name+dob=1',
        'formats:customers.email=1',
        'negatives:orders.total=1',
        'nulls:orders.status=1',
        'orphans:orders.customer_id=1',
      ]);
    }, 60_000);
  });
}

describe.skipIf(!MONGO)('mongo server', () => {
  let admin: DbClient;
  const cfg = (over: Partial<ConnectionConfig> = {}) => cfgFor('mongo', MONGO!, over);
  const cmd = (o: object) => JSON.stringify(o);

  beforeAll(async () => {
    admin = await openClient(cfg());
    await admin.query(cmd({ collection: 'customers', deleteMany: { filter: {} } }));
    await admin.query(
      cmd({
        collection: 'customers',
        insertMany: [
          { _id: 1, full_name: 'Ana Lopez', dob: '1988-04-12', email: 'ana@example.test', balance: 10 },
          { _id: 2, full_name: 'Ben Carter', dob: '1975-09-30', email: 'nope', balance: -5 },
          { _id: 3, full_name: 'Ana Lopez', dob: '1988-04-12', email: 'ana2@example.test', balance: 0 },
        ],
      }),
    );
  }, 60_000);
  afterAll(async () => {
    await admin?.query(cmd({ collection: 'customers', deleteMany: { filter: {} } })).catch(() => undefined);
    await admin?.close();
  });

  it('finds, aggregates and counts', async () => {
    const found = await admin.query(
      cmd({ collection: 'customers', find: { full_name: 'Ana Lopez' }, sort: { _id: 1 } }),
    );
    expect(found.rows.map((r) => r._id)).toEqual([1, 3]);
    const agg = await admin.query(
      cmd({ collection: 'customers', aggregate: [{ $group: { _id: null, total: { $sum: '$balance' } } }] }),
    );
    expect(agg.rows[0]).toMatchObject({ total: 5 });
    expect((await admin.query(cmd({ collection: 'customers', countDocuments: {} }))).rows[0]).toEqual({
      count: 3,
    });
  });

  it('runs db.mongoFind steps and blocks writes on read-only connections', async () => {
    const r = await runTestCase({
      runId: 'R',
      steps: steps(
        {
          type: 'db.mongoFind',
          params: { connection: 'm', collection: 'customers', filter: { balance: { $lt: 0 } } },
          assertions: [{ target: 'rows[0].full_name', operator: 'equals', expected: 'Ben Carter' }],
        },
        {
          type: 'db.query',
          params: { connection: 'm', sql: cmd({ collection: 'customers', deleteMany: { filter: {} } }) },
        },
      ),
      executors: [createDbExecutor({ resolve: async () => cfg({ readOnly: true }) })],
      options: { ...DEFAULT_RUN_OPTIONS, defaultTimeoutMs: 20_000 },
      artifactsDir: '/tmp',
    });
    expect(r.steps[0]!.status).toBe('passed');
    expect(r.status).toBe('broken');
    expect(r.error).toMatch(/read-only/);
    expect((await admin.query(cmd({ collection: 'customers', countDocuments: {} }))).rows[0]).toEqual({
      count: 3,
    });
  });

  it('audits collections by sampling', async () => {
    const report = await runAudit(admin, await admin.schema(), { tables: ['customers'] });
    const found = report.findings.map((f) => `${f.check}:${f.columns.join('+')}=${f.count}`).sort();
    expect(found).toEqual(['duplicates:full_name+dob=1', 'formats:email=1', 'negatives:balance=1']);
  });
});
