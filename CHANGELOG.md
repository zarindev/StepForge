# Changelog

## [Unreleased]

### Changed
- Record from the Test Explorer: the New scenario dialog has **Create & record**, a scenario's Steps tab has
  **Record steps** (the recorded steps are added after the existing ones, reviewed first), and a module's menu and
  empty modules offer **Record a scenario**. The Recorder shows where the recording will go; the sidebar Recorder
  works as before.

### Fixed
- Diagnosis: a failed response-time check on an API step is now diagnosed as a slow API (rule `api-slow-response`)
  instead of a generic assertion mismatch.
- Diagnosis: JavaScript errors only count when they happened on the page the step failed on, so an error on an
  earlier page no longer takes the blame.
- UI executor: a click blocked by another element keeps Playwright's "… intercepts pointer events" reason, so it is
  diagnosed as *element covered* rather than a slow page.
- One-time-code extraction no longer picks digits inside a link or an email address (e.g. a run id in a
  verification link) over the real code.
- PATCH endpoints no longer reset omitted fields to their defaults (zod `.partial()` keeps defaults).

### Added
- Phase 14 showcase: a second demo app, **ShopDesk** (shop back office on port 8102), and 25 planted bugs across both
  demo apps (API, database, UI, email, business logic, performance) in `demo/manifests/planted_bugs.json`, which
  StepForge never reads (guard test); the demo workspace now loads both apps (45 scenarios). `scripts/benchmark.ts`
  measures detection and diagnosis into `docs/benchmarks.json` (25/25 detected, 24/25 diagnosed correctly, 0 false
  alarms). `scripts/capture_showcase.ts` (replaces `capture_screenshots.ts`) captures screenshots, WebM clips and real
  sample exports (`docs/samples/`). A 15-slide case study (`docs/case-study/case-study.html`), promo cards and
  `scripts/export_case_study.ts` (PDF, slide PNGs, Upwork and social images, with size, dimension and overflow
  checks), `UPWORK_LISTING.md` and `CASE_STUDY.md`. `npm run demo:shop`.
- Phase 13 public-repo polish: first-run onboarding (load the CareClinic demo workspace — 17 scenarios, database
  connection, quality gate, demo app started by StepForge — or create an application with a guided recorder tour),
  `npm start -- --demo`, editable runner defaults (used by the Run dialog, schedules and the CLI), daily evidence
  retention, application import/export and demo controls in Settings, encryption-key rotation, danger zone, error
  states on every page, full README with banner and screenshots, CONTRIBUTING, SECURITY, LEGAL, a section 16 checklist,
  screenshot capture script, fresh-clone smoke test and CI job (Ubuntu + Windows).
- Phase 12 code export: 13 targets — Playwright (TypeScript and Python), Cypress, Selenium (Python and Java), pytest +
  requests, REST Assured, k6, Postman v2.1, cURL, Markdown, Gherkin and Excel test cases — with optional Page Object
  Model and GitHub/GitLab CI files, API/DB/email helpers that keep StepForge's check rules, TODO markers and warnings
  for anything that cannot be translated, Exports page (preview, download, history), Explorer shortcut,
  `stepforge codegen`, application export/import API, snapshot tests and `npm run verify:export` (CI job for the
  Playwright export).
- Phase 11 automation: schedules (cron presets or expressions with next-run preview, run now, history, skipping a
  time while the previous run is still going), Telegram and email notifications with failures, diagnoses, quality
  gate and a link (secrets encrypted, "failures only" option, send test), the `stepforge` CLI (`run` with
  tag/module/scenario filters, JUnit/HTML/PDF output, notifications and exit codes; `list`, `report`, `export`,
  `import`, `secret set`), JUnit XML run reports, application export/import as JSON (no secret values).
- Phase 10 analytics: Home dashboard (KPIs, trend, quality gates, recent runs), application analytics (breakdowns,
  failure categories, top failing/slowest/flaky tests with drill-down, performance trends, calendar), quality gates
  with block/warn rules, run comparison, daily aggregates refreshed after every run.
- Phase 9 diagnosis and bug reports: rule-based diagnosis (53 YAML rules, user rules, last-green diff, locator
  suggestions with one-click fix, annotated failure screenshots), automatic deduplicated bug reports, exports
  (bug PDF/HTML/Markdown, bug list PDF/XLSX/Jira/Trello CSV, run report HTML/PDF/XLSX) with the report author
  ("Prepared by Md Zarin Tasnim" by default), optional local Ollama explanations.
- Phase 8 performance testing: built-in load engine (profiles, exact percentiles, live timeline, threshold
  verdicts), k6 export/install/bridge, Web Vitals page metrics, Lighthouse, query plans, Load Designer, load-test
  authorization per application.
- Phase 7 email testing: Mailpit (installer, start/stop from Settings, inbox viewer) and IMAP inboxes per
  application, email steps (wait, assert, extract OTP/link/regex, open link), email preview and evidence in run
  results, CareClinic sign-up with email verification.
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
