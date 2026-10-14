# Changelog

## [Unreleased]

### Added
- **Run queue priorities**: runs have a priority (high, normal, low) set in
  the Run dialog, schedules, campaigns or with `stepforge run --priority`; waiting runs start by priority, then oldest
  first. The Runs page shows the queue — the run in progress and the waiting ones in start order — with **Run next**,
  a priority picker and Cancel. `GET /api/runs/queue`, `POST /api/runs/:id/priority`. Migration 0012.
- **Network traffic breakdown**: each request now records its
  size and the step that made it; the run page's Network evidence has a **Breakdown** (requests, bytes, failures,
  third-party hosts; by type; by host with third parties marked; slowest; largest; failed) and a filterable request
  list with sizes and steps. New step `ui.networkSummary` turns the traffic into checks (page weight, failed
  requests, third-party hosts, requests or bytes per type). See [docs/WEB_APPS.md](docs/WEB_APPS.md#network-traffic).
- **Slack, Microsoft Teams, Mattermost, Rocket.Chat and webhook notifications**: new channel kinds in Settings → Notifications. Slack-style incoming webhooks (coloured
  message, optional mention on failure; Mattermost flavour), Teams Workflows (Adaptive Card with an "Open the run"
  button) and a generic JSON webhook with optional headers. Webhook URLs are stored encrypted and never returned
  or shown in errors. See [docs/SCHEDULING.md](docs/SCHEDULING.md#slack-mattermost-and-rocketchat).
- **SOAP, Kafka and FTP steps**, see
  [docs/INTEGRATIONS.md](docs/INTEGRATIONS.md): `api.soap` (envelope built from the body, SOAP 1.1/1.2, SOAPAction,
  faults fail the step unless expected), XPath assertion targets and extraction for any XML response,
  `api.kafkaProduce` / `api.kafkaConsume` (wait for the first matching message since the test started; key, text or
  JSONPath match; TLS and SASL), and `api.ftp` (upload, download, list, delete, exists over FTP, FTPS or SFTP). CI
  runs the Kafka tests against Apache Kafka.
- **Manual test runs**: Run → *How: Manual*. Nothing is executed; a
  tester follows each test's steps in plain English — blocks, hooks and called scenarios expanded, test data and
  environment variables filled in, secrets kept hidden — and records passed / failed / blocked / skipped per step with
  a note and a screenshot. The results are ordinary run results (history, analytics, gates, reports). A new
  `util.manual` step puts person-only checks into any scenario; automated runs skip it. Manual
  runs stay open across restarts. Migration 0011 (`runs.mode`). See [docs/MANUAL_RUNS.md](docs/MANUAL_RUNS.md).
- **Every kind of web app** ([docs/WEB_APPS.md](docs/WEB_APPS.md)):
  - **Visual checkpoints** (`ui.visualCheckpoint`, until now "not available"): the first run saves a baseline; later
    runs compare pixels (allowed difference and colour tolerance, masks for changing parts) and fail with a
    difference image; the run page shows baseline, this run and the difference, and **Accept as new baseline**. A
    diagnosis rule names visual changes.
  - New steps: `ui.waitForResponse` (status, body, JSONPath checks), `ui.mockRoute` (answer, fail or slow down
    requests), `ui.setOffline`, `ui.download` (file name, size, content checks), `ui.storage` (cookies,
    localStorage, sessionStorage), `ui.setClock` (fixed or running clock, jump forward), `ui.tap`; `x`/`y` positions
    on clicks for canvas, map and chart apps.
  - Tablet and Mobile runs get a touch screen and a mobile browser identity (Chromium: Pixel 7, WebKit: iPhone 14 /
    iPad), so sites serve their mobile version.
  - **Environment browser settings**: language, time zone, dark mode, location and permissions, user agent, HTTP
    basic auth, extra headers, proxy, client certificates (mTLS), service workers, and the installed Google Chrome or
    Microsoft Edge instead of the bundled Chromium. Secrets in them are resolved at run time.
- Docs: [docs/FEATURES.md](docs/FEATURES.md) (every feature in one page), [docs/WEB_APPS.md](docs/WEB_APPS.md),
  [docs/NATIVE_APPS_PLAN.md](docs/NATIVE_APPS_PLAN.md) (plan for Android, iOS and desktop apps), and a documentation
  index in the README.
- **Page conditions**: `util.if` can check the page instead of
  comparing values — the step's element is visible, hidden, present, absent, enabled, contains a text, or matches a
  number of times (with a short wait, default 2 s) — and `util.loop` gains **repeat while** a condition holds (a value
  or a page check, re-checked before every pass; the count is a safety limit, default 100). The step form shows the
  condition's fields and the element picker; the plain-English view reads “Repeat while the "Load more" button is
  visible”. Code export marks these steps TODO for now.
- **Setup/teardown hooks**: a module's menu sets a block to run before
  and one after every test of the module and its sub-modules; a scenario's Details tab adds its own and lists the
  inherited ones. Before-hooks run outermost first and a failure skips the test; after-hooks run innermost first and
  always run, even after a failure. Hook steps are numbered `before.n`/`after.n` and fixes land in their block.
  Export/import keeps hooks; code export inlines them. Migration 0010.
- **Test data library**: an application's Test data tab holds named data
  sources — a table of rows (typed or pasted as CSV), a CSV file on this computer, a read-only SQL query on one of
  the application's connections, or an API call (rows found with JSONPath) — with a live preview per environment.
  A new `util.useData` step takes the first, a random, a given or a matching row, or one not used yet in the run,
  into `{{vars.<name>.<column>}}`; rows are read once per run. Application export/import carries data sources.
  Migration 0009.
- **Campaigns**: a saved selection of tests (all, or modules, tags and scenarios)
  with the environments, browsers and screen sizes to run them in; one click queues one run per combination as a
  campaign run; the campaign-run page shows every combination side by side and each test's result per combination;
  **Rerun failed** repeats only the failed tests, only where they failed; schedules can run a campaign; the
  `stepforge campaign` CLI command runs one in CI (one JUnit file per combination, exit code); one summary goes to the
  campaign's notification channels when it finishes; application export/import carries campaigns. Migration 0008.
- **Element repository**: an application's Elements tab holds named
  UI elements with ranked locators; steps point at an element (step form → Saved element, or "Save as element" from
  a step's locators) and run with its current locators; the Elements tab shows where each is used and asks before
  deleting one in use; when a step that uses an element fails on a changed locator, the diagnosis names the element
  and its one-click fix updates the element, fixing every step; recordings reuse an element whose best locator
  matches; exported code gets the element's locators; application export/import carries elements (and block inputs,
  which were missing).
- **Block maintenance**: blocks declare inputs (defaults or required,
  `{{vars.<name>}}` inside the block, exported as variables); "Make a block" turns selected scenario steps into a
  block; the Blocks tab shows where each block is used and what a change affects, and asks before deleting a used
  block; when a test fails inside a block, the diagnosis names the block and its one-click locator fix updates the
  block (so every test using it is fixed); run results group failures by the block step they share.

### Changed
- **Node.js 22 or newer is now required** (was 20). Node 20 reached end of life in April 2026, better-sqlite3 no
  longer publishes Node 20 binaries (so installing on Windows needed a C++ build), and the SQL Server driver's Azure
  packages need Node 22. CI and the CI files of exported projects use Node 22.
- Record from the Test Explorer: the New scenario dialog has **Create & record**, a scenario's Steps tab has
  **Record steps** (the recorded steps are added after the existing ones, reviewed first), and a module's menu and
  empty modules offer **Record a scenario**. The Recorder shows where the recording will go; the sidebar Recorder
  works as before.

### Fixed
- The recorder recorded a slow first page load twice (seen on Windows CI).
- A step's screenshot is tried once more when the first try times out on a busy machine (a CI run had a step without
  its screenshot).
- Opening an `if`/`loop` step whose nested steps were created through the API (without `locators`) crashed the
  step editor; missing fields now get their defaults.
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
