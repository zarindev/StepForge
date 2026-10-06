# Databases

_By Md Zarin Tasnim · part of the StepForge documentation_

StepForge can query, assert on and audit the database behind the application you test. It never needs a
database server for itself (its own data is one SQLite file); it connects to **yours**.

| Engine | Driver | Notes |
|---|---|---|
| SQLite | `better-sqlite3` | Point at the `.db` file. Nothing to install. |
| PostgreSQL | `pg` | Host/port/database or a connection string. |
| MySQL / MariaDB | `mysql2` | Host/port/database or a connection string. |
| SQL Server | `mssql` (tedious) | Host/port/database or an ADO-style connection string. |
| MongoDB | `mongodb` | Host/port or a `mongodb://` URI. Commands are JSON. |

## Adding a connection

Application → **Databases** tab → *Add connection*. A connection belongs to an **environment**; steps refer to it
by **name**, so give the matching database in each environment the same name (`main` in Local, Staging…).
Use *Test connection* before saving: it reports how many tables it can see.

The password is stored encrypted (AES-256-GCM, like secrets) and is never sent back to the browser, written
to logs, exported or put into generated code. Leave the password field empty when editing to keep it. Do not
put passwords into a connection string — use the password field.

### Pointing at your own servers (no Docker needed)

StepForge does not start database servers. Use whatever you already run:

- **The app's own database** on your machine or a test server (most common).
- **A native install**: PostgreSQL (postgresql.org installers for Windows/macOS, `apt install postgresql`),
  MySQL Community Server / MariaDB, SQL Server Express or Developer edition (free), MongoDB Community.
- **A free hosted database** you own (any provider's free tier), using TLS.

For SQLite, the file must be readable by the user running StepForge. StepForge refuses connections that point
at its own `data/stepforge.db`.

## Safety rules

These are enforced in code, not just in the UI.

1. **Read-only by default.** New connections are read-only. Every statement is inspected before it is sent:
   anything that is not clearly a read (`SELECT`, `WITH … SELECT`, `SHOW`, `EXPLAIN` without `ANALYZE`, …) counts as
   a write — `INSERT`, `UPDATE`, `DELETE`, DDL, `CALL`, `SET`, `PRAGMA x = y`, `SELECT … INTO`, `WITH … DELETE`,
   and anything unrecognised. Because quoting rules differ between engines, the statement is also inspected
   under every other engine's rules and counts as a write if any of them sees one (so a write cannot hide inside
   what one engine would read as a string or comment).
   The driver adds a second barrier where the engine supports it: SQLite opens the file read-only, PostgreSQL and
   MySQL put the session into read-only transaction mode. SQL Server has no such session switch, so for SQL Server
   also use a **read-only database login**. MongoDB commands are writes when they use a write operation or an
   aggregation `$out`/`$merge` stage.
2. **Rollback mode by default.** With rollback mode on, the first write in a test (or a workbench statement)
   opens a transaction, and StepForge rolls it back when the test ends. Reads before the first write run normally,
   so they see what the application under test has committed. MySQL sessions use `READ COMMITTED` so later reads
   in the transaction still see the app's new rows. Statements that control transactions (`BEGIN`, `COMMIT`,
   `ROLLBACK`, …) are refused in rollback mode. MongoDB needs a replica set for transactions.
   *Caveat:* while the transaction is open the database holds its locks. On SQLite this means the application's
   own writes wait (up to its busy timeout) until the test finishes; keep write steps late in a test, or use a
   copy of the database.
3. **Production needs typed confirmation.** For connections in an environment marked *Production*, every write
   requires the application's name: the workbench asks you to type it, and steps need `confirmProduction` set to
   it. The workbench shows a red banner on production connections.
4. **Audits only read.** The data-quality audit always opens the connection read-only.

## SQL Workbench

*SQL* in the left rail. Pick a connection, browse tables (columns with types, primary keys, foreign keys,
indexes), write SQL in Monaco with schema-aware autocomplete (`table.` lists that table's columns, also for
aliases), and run it with **Ctrl/Cmd+Enter** (runs the selection if there is one). Results show up to 1000 rows;
**Export CSV** downloads them (cells that start with `=`, `+`, `-` or `@` are escaped so spreadsheets do not run them).
Drafts are kept per connection in your browser.

**Save as DB test** turns the current query into a scenario with a `db.query` step and suggested assertions
(`value equals …` for single-value results, otherwise `rowCount equals …`), which you can edit before saving.

### Data Quality Audit

The *Data quality audit* tab runs these checks on the tables you pick:

| Check | What it looks for |
|---|---|
| Orphaned references | Rows whose foreign key points at a missing parent. Uses declared foreign keys and, unless turned off, relationships **inferred from naming** (`patient_id` → `patients.id`), because many schemas never declare them. |
| Duplicates | Repeated values in email/phone/mobile/code/sku/username/barcode/slug columns that have no unique index, and repeated *name + date of birth* pairs. Empty strings are not counted as duplicates. |
| Missing required values | `NULL` or empty values in nullable `name`/`full_name`/`first_name`/`last_name`/`title`/`status` columns (or the columns you choose in a step). |
| Invalid formats | Values in email and phone columns that do not look like an email address / phone number (first 10 000 rows per column). |
| Negative numbers | Negative values in numeric price/amount/quantity/stock/fee/total/cost/balance/age/salary/discount/tax columns. |

Each finding shows sample rows and the query that found it: *Open query* loads it into the editor, *Save as test*
creates a `db.query` step asserting `rowCount equals 0`. *Save as DB test* on the audit panel adds a
`db.dataQualityCheck` step instead. MongoDB collections are checked on a sample of documents (no foreign keys).

## Testing the drivers against real servers

`npm test` always runs the SQLite tests. The PostgreSQL, MySQL, SQL Server and MongoDB integration tests
(`packages/executors/database/test/servers.test.ts`) run when you provide URLs to scratch databases you own:

```bash
STEPFORGE_TEST_PG_URL=postgres://user:pass@127.0.0.1:5432/stepforge_test \
STEPFORGE_TEST_MYSQL_URL=mysql://user:pass@127.0.0.1:3306/stepforge_test \
STEPFORGE_TEST_MSSQL_URL="Server=127.0.0.1,1433;Database=master;User Id=sa;Password=…;TrustServerCertificate=true" \
STEPFORGE_TEST_MONGO_URL=mongodb://127.0.0.1:27017 \
npx vitest run packages/executors/database
```

They create and drop `customers`, `orders` and `items` tables (and a `sf_close_orders` procedure). CI runs them
against service containers on Linux.
