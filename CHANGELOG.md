# Changelog

## [Unreleased]

### Fixed
- PATCH endpoints no longer reset omitted fields to their defaults (zod `.partial()` keeps defaults).

### Added
- Phase 6 database testing: DB executor for SQLite, PostgreSQL, MySQL, SQL Server and MongoDB (query, Mongo find,
  scripts, procedures, extract, data-quality check), read-only guard with driver-level read-only sessions, rollback
  mode, typed confirmation for production writes, encrypted connection passwords, SQL Workbench with schema
  browser, autocomplete, CSV export and "Save as DB test", data-quality audit (orphans incl. inferred
  relationships, duplicates, missing values, formats, negatives), CareClinic planted DB bugs.
- Phase 5 API testing: API executor (REST, GraphQL, auth incl. OAuth2, cookies, JSONPath, JSON Schema, contract
  checks), OpenAPI/Swagger, Postman, cURL and HAR importers with generated negative tests, API Client with
  contract validation, CareClinic OpenAPI spec and planted API bugs.
- Phase 4 recorder and editor: Shadow-DOM recorder toolbar with assert/extract/mask/insert, ranked
  locators, auto-masked secrets, tab/dialog/iframe handling and network capture → API steps; control flow
  (if/loop/callScenario/useBlock) and reusable blocks; list/flow/plain-English views, typed step forms, locator
  editor, Monaco; rule-based test case variants; move module.
- Phase 3 execution: scenario engine, Playwright UI executor with self-healing locators, utility steps, persisted
  runner with workers/retries/flaky detection/cancel/resume, live run view, results with screenshots, video,
  embedded Trace Viewer, console and network logs; CareClinic demo app.
- Phase 2 organisation: applications, environments, encrypted secrets, nested modules, tags, scenarios, steps,
  test cases, version history with diff/restore, Test Explorer with search, filters, drag-and-drop and bulk actions,
  app switcher and global search.
- Phase 1 foundation: monorepo, core step model and variable resolver, SQLite schema and migrations, secret
  encryption, local Fastify server with session-token security, dashboard shell, setup/start scripts, CI.
