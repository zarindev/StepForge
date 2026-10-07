# Contributing to StepForge

_By Md Zarin Tasnim · part of the StepForge documentation_

Thanks for helping. StepForge is a local-first tool: every change must keep it free, offline-capable and safe with
users' data.

## Setup

```bash
git clone https://github.com/zarindev/stepforge.git
cd stepforge
./setup.sh            # Windows: setup.bat
npm run dev           # API with auto-restart + dashboard with hot reload (http://127.0.0.1:5173)
```

Node 22+ is the only requirement. Optional tools for some tests: `npm run mailpit:install` (email), `npm run
k6:install` (k6), Python 3 / Java 17 + Maven (to run exported Python and Java projects).

## Checks (all must pass)

```bash
npm run lint
npm run typecheck
npm test                 # Vitest: unit and integration tests
npm run build
npm run test:e2e         # Playwright: the dashboard end to end
npm run verify:export    # the exported Playwright project runs against the demo app
npm run check:secrets    # no data/ or .env content committed
```

Tests against real PostgreSQL/MySQL/SQL Server/MongoDB run when `STEPFORGE_TEST_PG_URL`, `STEPFORGE_TEST_MYSQL_URL`,
`STEPFORGE_TEST_MSSQL_URL` or `STEPFORGE_TEST_MONGO_URL` are set (CI uses service containers).

## Layout

`packages/core` (step model, engine), `packages/executors/*` (UI, API, DB, email, perf, util), `packages/db`
(schema, migrations, repositories), `packages/diagnosis`, `packages/analytics`, `packages/codegen`,
`apps/server` (Fastify), `apps/web` (React), `apps/cli`, `demo/` (demo apps). See
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Guidelines

- **Never fake results.** No invented numbers in docs or UI; sample data only behind an explicit demo action.
- **Secrets** are encrypted, masked as `••••`, never logged, exported or written into generated code.
- **Schema changes:** edit `packages/db/src/schema.ts`, run `npm run db:generate`, commit the migration. Migrations
  run on start after a backup.
- **New step types:** add them to the catalogue in `packages/core`, an executor, plain-English text, the step reference
  and every code generator (or a `TODO(StepForge)` with a warning).
- **Code export:** snapshot tests live in `packages/codegen/test`; update with `npx vitest run packages/codegen -u` and
  review the diff.
- **UI:** every screen has loading, empty and error states; keep keyboard access and accessible names.
- Keep commits focused, with a clear message (`feat:`, `fix:`, `docs:` …).

## Reporting issues

Include your OS, Node version, what you did, what you expected and what happened. Security problems: see
[SECURITY.md](SECURITY.md) instead of a public issue.
