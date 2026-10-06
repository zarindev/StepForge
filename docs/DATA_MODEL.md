# Data Model

_By Md Zarin Tasnim · part of the StepForge documentation_

StepForge stores its own data in `data/stepforge.db` (SQLite, WAL mode). The schema is defined in
[`packages/db/src/schema.ts`](../packages/db/src/schema.ts); migrations live in `packages/db/migrations` and run
automatically on start (an existing database is backed up to `data/backups/` first).

Conventions: ULID primary keys, ISO-8601 `created_at` / `updated_at` on every table, `*_json` columns are TEXT
validated with Zod at the API boundary, booleans are 0/1 integers. Large payloads (bodies, DOM, videos, traces)
live in `data/artifacts/` and tables store only paths.

```mermaid
erDiagram
  applications ||--o{ environments : has
  applications ||--o{ modules : has
  applications ||--o{ tags : has
  applications ||--o{ blocks : has
  applications ||--o{ datasets : has
  applications ||--o{ api_specs : has
  applications ||--o{ mail_inboxes : has
  applications ||--o{ quality_gates : has
  applications ||--o{ schedules : has
  applications ||--o{ runs : has
  applications ||--o{ bugs : has
  applications ||--o{ analytics_daily : aggregates
  environments ||--o{ secrets : has
  environments ||--o{ db_connections : has
  modules ||--o{ modules : "parent of"
  modules ||--o{ scenarios : contains
  scenarios ||--o{ steps : "ordered"
  scenarios ||--o{ test_cases : has
  scenarios ||--o{ scenario_versions : history
  scenarios }o--o{ tags : scenario_tags
  blocks ||--o{ block_steps : "ordered"
  runs ||--o{ run_items : contains
  test_cases ||--o{ run_items : "executed as"
  run_items ||--o{ step_results : has
  run_items ||--o{ artifacts : has
  run_items ||--o{ perf_metrics : has
  run_items ||--o{ load_results : has
  run_items ||--o{ bugs : raises
```

## Deletion behaviour

Deleting an application cascades to everything it owns. Deleting a test case keeps historic `run_items`
(`test_case_id` becomes NULL) so analytics stay accurate. Secrets referenced by connections/inboxes/channels are
detached (`SET NULL`), never silently reused.

A database connection's password is a `secrets` row with no environment (`environment_id` NULL, key
`db-connection:<id>`), so it does not appear in the environment's secret list; it is deleted together with the
connection, its environment or its application. Connection names are unique per environment
(`db_connections_env_name_uq`) because steps refer to connections by name.

Mail inboxes (`mail_inboxes`) have a `name` unique per application (`mail_inboxes_app_name_uq`); email steps refer
to them by name. An IMAP password is stored the same way as a connection password (`secrets` row without an
environment, key `mail-inbox:<id>`) and is deleted with the inbox or its application.

Bugs (`bugs`) keep `scenario_id`, `test_case_id`, `failed_step_id` and `category` so they stay linked after the run
that found them is deleted; `fingerprint` = hash of scenario + failing step + diagnosis category (deduplication);
`last_seen_at` is updated on each occurrence. The diagnosis of a failed run item is stored in
`run_items.diagnosis_json`.
