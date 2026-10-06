# StepForge — Build Progress

| # | Phase | Status |
|---|---|---|
| 1 | Foundation: monorepo, core, db, crypto, server, web shell, scripts, CI | ✅ Done |
| 2 | Applications, environments, secrets, modules, tags, Test Explorer, CRUD, versions | ✅ Done |
| 3 | Scenario engine, UI executor, runner, live view, evidence, results | ✅ Done |
| 4 | Recorder, Scenario Editor (list/flow/plain-English) | ✅ Done |
| 5 | API module, API Client, importers, contract check | ✅ Done |
| 6 | Database module, SQL Workbench, data-quality audit, rollback | ✅ Done |
| 7 | Email (Mailpit + IMAP), OTP/link extraction | ⏳ Next |
| 8 | Performance (metrics, Lighthouse, load, k6, query plans) | — |
| 9 | Diagnosis engine, bug reports, report exports | — |
| 10 | Analytics, quality gates, run comparison, flaky detection | — |
| 11 | Scheduler, CLI, notifications, JUnit/HTML | — |
| 12 | Code generators + snapshot tests | — |
| 13 | Public-repo polish, onboarding, fresh-clone test | — |
| 14 | Showcase package, optional Electron | — |

---

## Phase 6 — Database testing (2026-10-06)

**Delivered**
- **DB executor** (`@stepforge/executor-db`, `packages/executors/database`): drivers for SQLite (`better-sqlite3`), PostgreSQL (`pg`), MySQL/MariaDB (`mysql2`), SQL Server (`mssql`) and MongoDB (`mongodb`), loaded on first use; one `DbClient` interface (query, procedures, transactions, schema introspection with columns, primary/foreign keys and indexes). Steps `db.query`, `db.mongoFind`, `db.runScript`, `db.callProcedure`, `db.extract`, `db.dataQualityCheck`; assertion targets `rowCount`, `affected`, `value`, column names, `rows[i].col`, `column:col`, JSONPath; new core operators `noNulls`, `unique`, `inRange`. Parameters are bound (`?`/`$1`/`@p1`) and masked like every secret in stored results.
- **Safety (Section 12, in code):** a conservative SQL classifier (comments/strings stripped per dialect; a statement is a write if *any* dialect's lexing reveals one, so `'a\'; DROP …` cannot slip through), driver-level read-only sessions where engines support them, **rollback mode** that opens a transaction at the first write and rolls back at the end (reads before it see the app's commits; MySQL uses READ COMMITTED), transaction statements refused in rollback mode, and **typed application-name confirmation** for writes on production connections (workbench dialog / `confirmProduction` in steps).
- **Data-quality audit** (`runAudit`): orphaned references (declared FKs **and** relationships inferred from `x_id` naming), duplicates (email/phone/code-like columns without a unique index, name + date of birth), missing required values, invalid email/phone formats, negative money/quantity values; sampled checks for MongoDB. Every finding carries sample rows and the query that found it.
- **Connections** per environment (repo + API): unique name per environment (migration `0002_db_connections`), password stored as an encrypted secret outside the environment's secret list and never returned; secrets are purged when a connection, environment or application is deleted; connections cannot point at StepForge's own database. `POST …/connections/test` for drafts, schema (cached 60 s), query and audit endpoints with HTTP mapping (blocked 403, SQL error 422, unreachable 502).
- **Dashboard:** application **Databases** tab (add/edit/test/delete, read-only and rollback badges, production warning); **SQL Workbench** (connection picker, production banner, schema browser, Monaco with schema-aware autocomplete incl. aliases, Ctrl/Cmd+Enter runs the selection, results grid with NULLs and CSV export, rollback notice, typed confirmation for production writes, drafts per connection); **Data quality audit** tab (checks, tables, findings with samples, open query, save finding as test, save audit as a step); **Save as DB test** with an assertion builder; typed forms for every `db.*` step with a connection picker; query + rows panel in run results; plain-English descriptions.
- **CareClinic:** schema versioning (old demo databases are rebuilt), and planted DB bugs **CC-DB-01** (deleting a patient leaves orphan appointments; no FK) and **CC-DB-02** (the same patient can be registered twice), recorded in `demo/manifests/planted_bugs.json` (never read by StepForge).
- `docs/DATABASES.md` (engines, connecting your own servers without Docker, safety rules, workbench, audit, integration tests); STEP_REFERENCE database section; CI job `databases` with PostgreSQL, MySQL, SQL Server and MongoDB service containers.

**Verified**
- `npm test`: 179 tests (+5 SQL Server tests skipped without a server). New: 17 DB-executor tests on SQLite (classifier incl. cross-dialect tricks, script splitting, policy, driver-level read-only, every step type, rollback vs commit, broken vs failed classification, secret masking of parameters, audit findings and options), 11 server tests (connection API never leaks the password, encrypted at rest, purged with its environment, own-DB refusal, draft test + schema, workbench read/blocked/rollback/syntax error, production confirmation, audit, runs), assertion operator and update-schema tests.
- **Real servers:** the same integration suite passed against **PostgreSQL 18.4**, **MySQL 9.7.2** and **MongoDB** started locally from portable npm packages (schema, driver-level read-only, rollback while seeing other clients' commits, parameters, procedures, assertions, audit). SQL Server runs in CI only (see KNOWN_ISSUES #20).
- **Done-when check:** a hybrid scenario — UI login and patient registration in the browser, `db.query` asserting the new row (row count, phone, date of birth, code format), `db.extract`, an API login and search by the extracted code, and `unique`/`noNulls` column checks — **passes**. Scenarios aimed at the planted DB bugs fail with precise messages (orphaned appointments still present; duplicate registration accepted, found by both a count assertion and `db.dataQualityCheck`).
- `npm run test:e2e`: 12 tests. The Phase 6 E2E adds a SQLite connection through the dialog (tests it first, read-only + rollback by default), browses the schema, queries a table, sees a DELETE blocked, saves a query as a DB test with suggested assertions, audits the database clean, deletes a patient via the API, and finds the orphaned appointment (inferred relationship), then runs the finding's query.
- The app was started on the existing `data/` folder: two pending migrations applied after an automatic backup.
- Bugs found and fixed: **zod 4's `.partial()` keeps defaults**, so every PATCH silently reset omitted fields to their defaults (renaming an environment cleared `isProduction` and its variables; editing a connection wiped its file path) — all update schemas now use `patchOf()` without defaults, with a regression test; Monaco's `addCommand` shortcut bound to the wrong editor (now handled on the editor wrapper); `@faker-js/faker` upgraded to 10.x for a high-severity advisory.

---

## Phase 5 — API testing (2026-10-06)

**Delivered**
- **API executor** (`@stepforge/executor-api`): `api.request` (any method; JSON, form, multipart, raw bodies; query; auth bearer / basic / API key / OAuth2 client credentials (cached) / cookie; per-test cookie jar; redirects; timeout and cancellation), `api.graphql` (GraphQL errors fail the step unless allowed), `api.extract` (JSONPath/header/status from the last response). Assertion targets: `status`, `time`, `size`, `header:<name>`, `body`, `text`, any JSONPath (`$.items[0].id`, `$.items[*].name`); operators incl. `lengthEquals`, `matches` and **`matchesSchema`** (Ajv + formats, OpenAPI `nullable` supported, field-level messages like `items.1.fee should be number`). `contract` param validates the response against the stored OpenAPI spec (documented status + body schema).
- **Engine**: executors can judge special assertions (`evaluate` hook) and report their own checks (`assertions`); request/response/query payloads and assertion values are **masked** before leaving the engine; a failing assertion now keeps the step's real request/response (previously lost).
- **Importers** (`@stepforge/importers`, pure plans): **OpenAPI 3 / Swagger 2** (JSON or YAML, dereferenced) → modules per tag; per operation a happy path (spec examples or schema samples, status + JSON Schema + response time) and negative tests (unauthorized, not found, missing required fields, wrong type, invalid enum); login operations are detected and turned into an **Authenticate block** with password fields replaced by secrets; DELETE happy paths only on request. **Postman v2.1** (folders, `{{vars}}` → `{{env.x}}`, inherited auth, raw/urlencoded/form-data/GraphQL bodies, simple `pm.response.to.have.status()` scripts). **cURL** (devtools style: quotes, `-H`, `-d`/`--data-raw`/`--json`, `-u`, `-F`, `-G`, `-b`). **HAR** (XHR/fetch, noise filtered, deduped by path template). Captured-request conversion moved here from the recorder.
- **Server**: stored API specs (from text, absolute URL, or a path on an environment), `POST /api/applications/:id/import` (plans materialised in one transaction with blocks and tags), `POST /api/api-client/send` (variables + secrets resolved server-side, masked in the response, contract + assertion results), contract resolver wired into runs.
- **Dashboard**: **API Client** (specs list with “Generate”, API scenarios list, method/URL/environment, Params/Headers/Body (Monaco)/Auth tabs, response status/time/size, Body/Headers/Contract tabs, “Save as API test”, “Update scenario step”), **Import dialog** (OpenAPI URL or paste/upload with negative/contract/destructive options, Postman, cURL, HAR; result with secrets to set and warnings) also reachable from the Test Explorer; typed forms for API steps; request/response panels in run results.
- **CareClinic**: OpenAPI 3 spec at `/api/openapi.json`; stricter input validation (types, time slots, existing ids) so only intentional bugs remain; **planted API bugs** CC-API-01 (doctor fee as string), CC-API-02 (appointments listed without auth), CC-API-03 (DELETE unknown patient → 204) in `demo/manifests/planted_bugs.json` (never read by StepForge).

**Verified**
- `npm test`: 128 tests. New: 8 API-executor tests on a local server (assertions, field-level schema errors, bodies, secret masking of the bearer token in stored requests, cookie jar, basic, OAuth2, GraphQL, extract, contract hook, timeout, ECONNREFUSED, evidence on assertion failure), 6 importer tests (CareClinic spec, YAML/Swagger 2, operation matching, Postman, cURL, HAR), 3 server tests.
- **Done-when check** (server test + E2E): importing CareClinic's spec from its URL generates 6 modules, 1 Authenticate block and the suite; running it after a demo reset passes everything **except exactly the three planted bugs**, each with a precise message (`fee should be number`, `Expected status equals 401, but got 200`, `Expected status equals 404, but got 204`).
- `npm run test:e2e`: 11 tests, stable on repeated runs. The Phase 5 E2E imports the spec through the dialog, sends a login request with a secret (masked, contract ok), loads a generated scenario, sees the contract violation on `/api/doctors`, runs the generated module with 4 workers and checks the three failures and their request/response evidence.
- Bugs found and fixed: CareClinic returned 500 on a wrong-typed login email (found by the generated negative test); failing API assertions dropped the request/response evidence.

---

## Phase 4 — Recorder and Scenario Editor (2026-10-06)

**Delivered**
- **Recorder** (`@stepforge/recorder`): headed Chromium with the StepForge toolbar injected via `addInitScript` into every page and frame, rendered in a **Shadow DOM**, wired with `exposeBinding`. Toolbar: Record/Pause, **Assert** (pick an element → visible / text equals / contains / value / URL contains / hidden), **Extract** (save text into a variable), **Mask** (store any field as a secret), **Insert** (API request, DB query, wait for email, note, wait), Undo, Stop. Captures clicks, double-clicks, typing (debounced to one `fill` per field visit), selects (by label), checkboxes/radios, file inputs, Enter/Escape, typed navigations, new tabs (`switchTab`), closed tabs, dialogs (`handleDialog` inserted *before* the triggering action) and iframes (`switchFrame` in and out). Ignores focus clicks, label clicks that toggle a control, and the browser's synthetic submit click after Enter.
- **Locator ranking** in the page: `data-testid/data-test/data-cy/data-qa` → ARIA role + accessible name → label → placeholder → stable text → stable CSS (hashed/auto-generated ids and classes ignored) → XPath, with uniqueness-aware scores. Weak structural fallbacks are dropped when two strong locators exist (they caused false "healing" onto the wrong element).
- **Secrets:** password fields are auto-masked into `{{secret.<key>}}`; the value stays server-side and is saved encrypted into the environment on save.
- **Network capture** of XHR/fetch (noise and static assets filtered, JSON bodies ≤ 64 KB) and `networkToApiSteps()` (dedupe by method + path template, `{{env.baseUrl}}`, auth headers → secrets, status + time assertions).
- **Server**: one recording at a time, live `recorder.updated` events, `start/stop/undo/discard/save`; saving creates the scenario, optionally an API scenario from selected requests, and stores captured secrets.
- **Engine control flow**: `util.if` (value conditions with any assertion operator, then/else), `util.loop` (count or array, `vars.item`/`vars.index`, max 1000), `util.callScenario`, `util.useBlock` (max call depth 5) with nested results numbered like `2`, `3.1`, `4[2].1`, `5e.1`. Nested steps are validated on save.
- **Reusable blocks**: repository + API + Blocks tab on the application page.
- **Plain English** (`describeStep` / `describeSteps` in core): readable sentences preferring human locators (“Click the "Sign in" button”), used by the editor now and by bug reports/docs later.
- **Scenario Editor**: List / **Flow** (React Flow, layer colours, branches fan out, click a node to edit) / **Plain English** views; typed forms for 30 step types; **locator editor** (reorder, make primary, add/remove fallbacks); nested then/else/loop lists; **Monaco** (bundled locally, lazy-loaded) for JSON, SQL and scripts; advanced JSON for assertions.
- **Generate variants** (rule-based, `generateVariants` in core): empty, whitespace, too long, numeric boundaries, invalid email/phone/date, HTML/script and SQL-quote inputs → new test cases with technique and expected result.
- **Explorer**: “Move module to…” (keyboard alternative to drag-and-drop); deep links into another application now switch the app automatically (bug found by E2E). Run results show nested step paths with indentation.
- CareClinic dashboard now loads “Next appointments” via `fetch`, so recordings capture real API traffic.

**Verified**
- `npm test`: 111 tests. New: 4 control-flow engine tests, plain-English (11 cases) and variants tests, 3 recorder tests driving a real browser against CareClinic (login + booking with Assert/Extract via the toolbar, masked password, network capture, then **replay with the engine on fresh demo data passes**; typed navigation, undo, pause and dialog ordering; API dedupe), 2 server tests (record → save with secret + API scenario → run passes; blocks + `useBlock` inside a loop, nested-step validation).
- `npm run test:e2e`: 10 tests, run serially (specs share one CareClinic instance; resetting it logs everyone out). The Phase 4 E2E starts a recording **from the dashboard**, drives the server-launched browser over CDP, sees 13 steps arrive live, reviews and saves, checks the Plain English and Flow views and the locator editor, then replays the recording → passed. A second E2E covers variants, move module, blocks and a nested `useBlock` loop built in the typed form.
- Bugs found and fixed: implicit form submission recorded an extra click; weak CSS fallbacks healed onto the wrong element; a URL typed right after starting was ignored; cross-application deep links showed an empty panel.

---

## Phase 3 — Engine, UI executor, runner and results (2026-10-06)

**Delivered**
- **Scenario engine** (`@stepforge/core/engine`): `runTestCase()` shared by server and (later) CLI. Lazily creates one executor session per step group, resolves variables per step, enforces step timeouts (plus an outer guard), step-level retries, `continueOnFail` (soft failure), `captureAs`, generic assertions (`evaluateAssertion`, 15 operators), cancellation via `AbortSignal`, failure evidence hooks and secret masking of messages and captured vars. Failures are classified (`assertion`, `timeout`, `element_not_found`, `network`, … → `failed`; `variable`, `unsupported`, `invalid_params`, `script` → `broken`).
- **UI executor** (`@stepforge/executor-ui`, Playwright 1.63): browser pool per run, fresh context per test case, all `ui.*` steps except `visualCheckpoint`; ranked multi-strategy locators with one native wait (clean traces) and **self-healing** reporting; dialogs, tabs and iframes; per-step JPEG screenshots; on failure a PNG screenshot and DOM snapshot; console (incl. page errors with location) and network logs; video and Playwright trace kept per policy (`off`/`onFailure`/`always`).
- **Utility executor** (`@stepforge/executor-util`): `setVariable`, `generateData` (Faker + patterns), `wait` (flagged), `log`, sandboxed `runScript` (`node:vm`, timeout, no require/process/eval).
- **Runner** (`apps/server/src/runner`): scope expansion (application, module incl. sub-modules, tag, scenarios, test cases; deprecated scenarios and skipped test cases left out unless explicitly chosen), persisted queue, one run at a time with N parallel workers, run-level retries → `flaky`, stop on first failure, cancel, resume interrupted runs, delete with artifacts, graceful shutdown marks the active run interrupted. Run items keep a label snapshot so history stays readable after edits/deletes (migration `0001_run_details`, with a hand-fixed `ON DELETE SET NULL`).
- **API**: `POST/GET /api/runs`, `GET /api/runs/:id`, `GET /api/run-items/:id`, `cancel`, `resume`, `DELETE`, `/api/applications/:id/last-results`; evidence files at `/api/artifacts/files/*` (token required, HTTP range support for video); Playwright **Trace Viewer** served locally at `/trace-viewer/`.
- **Dashboard**: Run dialog (scope, environment with production warning, browser, viewport, workers, retries, video/trace, headed, stop on first failure; remembers your choices), Run buttons in the top bar, scenario panel, module menu and bulk bar; **Runs** list (status, totals bar, resume, delete); **live run / results view** (progress, per-test status, current step, live screenshot, streamed log, cancel, run again, filters, step timeline with durations, assertion results, healed-locator notes, screenshot lightbox, video player, embedded Trace Viewer, console and network tables); last-result icons in the Test Explorer.
- **CareClinic demo app** (first slice, `demo/clinic-app`, port 8101): login with three roles, dashboard, patients (search, register with validation), appointments (booking with double-booking check), REST API with bearer/cookie auth, `POST /api/reset`; about half the elements carry `data-testid`. `demo/start-demos.sh|bat`, `npm run demo:clinic`.
- `docs/STEP_REFERENCE.md` for UI and utility steps.

**Verified**
- `npm test`: 89 tests. New: 9 engine tests + 12 assertion cases, 5 util-executor tests, 6 UI-executor tests on a fixture page (all locator strategies, healing, dialogs, tabs, iframe, evidence kept/discarded by policy, not-found message), 3 CareClinic tests, 5 runner integration tests driving real Chromium against CareClinic (13-step booking flow passes with per-step screenshots and no secret persisted; failing login keeps video/trace/DOM/console/network and serves video with HTTP 206; retry-then-pass becomes `flaky`; module run with 2 workers cancelled → all skipped; empty scope rejected; run delete).
- `npm run test:e2e`: 8 tests, stable across repeated parallel runs. The new Phase 3 E2E runs a scenario from the Explorer against CareClinic and checks 11 timeline steps with screenshots, then a module run (1 passed, 1 failed) with the error, video, embedded Trace Viewer, network tab, and the failed icon in the Explorer.
- Bugs found and fixed during the phase: the engine kept retrying after a non-retryable failure; Drizzle dropped `ON DELETE SET NULL` from an `ALTER TABLE` foreign key; locator polling flooded Playwright traces with "Query count" actions.

---

## Phase 2 — Organisation (2026-10-06)

**Delivered**
- `@stepforge/db/repos`: repository layer for applications (with summary counts and `hasProduction`), environments, secrets (AES-256-GCM, write-only, plaintext never returned; `resolveSecrets` reserved for the run engine), modules (unlimited nesting, cycle and cross-application protection, recursive delete), tags, scenarios, steps, test cases, version history, Test Explorer tree, search and bulk actions. `RepoError` carries HTTP status codes; SQLite UNIQUE violations become readable 409s.
- **Versioning:** every change to a scenario's details or steps bumps `version` and stores a full snapshot (details + steps). Restoring creates a *new* version with the old content, so history is never rewritten. Step IDs are preserved across edits, so run history stays linked to steps.
- **Test case codes** are generated as `TC-<first 3 letters of module>-NNN`, unique within the application, unless a code is given.
- REST API: `/api/applications[/:id]`, `/environments`, `/secrets`, `/tags`, `/tree`, `/modules`, `/scenarios` (+ `/steps`, `/tags`, `/duplicate`, `/versions`, `/versions/:v/restore`), `/test-cases`, `/scenarios/bulk`, `/search`. Live `tree.changed` events keep every open tab in sync.
- **Safety in code:** deleting an application, or a production environment, requires the application name in the request body; the UI asks the user to type it.
- Dashboard: Applications grid + create/edit dialog (auto slug), application detail (KPIs, production banner, Environments with variables/browser defaults/production switch, Secrets per environment, Tags, Settings with archive and typed-confirm delete), working **app switcher**, **Test Explorer** (nested tree, search incl. TC codes, filters by priority/layer/status/tag, drag-and-drop to move scenarios and nest modules, multi-select bulk tag/move/status/duplicate/delete), scenario panel with **Steps** list editor (typed step picker grouped by layer, JSON params/locators/assertions with validation, enable/continue-on-fail/retries/timeout/captureAs, reorder by drag or arrows, duplicate, delete, dirty tracking), **Test cases** table + dialog, **Details** form + tag toggles, **History** with line diff and restore. `Ctrl+K` now searches scenarios, test cases and applications.
- Shared schemas: `@stepforge/core` now runs in the browser too (Web Crypto instead of `node:crypto`).

**Verified**
- `npm test`: 48 tests (18 repository tests, 4 API-level organisation tests including full CareClinic and ShopDesk trees, plus Phase 1 tests).
- `npm run test:e2e`: 7 tests. The new Phase 2 E2E drives the real UI end to end: create app → two environments (one production → banner) → secret (value never rendered) → tag → nested modules → scenario → 3 steps (kind becomes `hybrid`, v2) → test case `TC-REG-001` → details (v3) → tag toggle → history diff → restore v1 (v4) → `Ctrl+K` finds the test case → drag scenario between modules → bulk tag → tree search/filters → delete app with typed confirmation.
- Bug found and fixed by E2E: the command palette focused its input on a timer, dropping fast keystrokes; now uses `autoFocus`.

**Deferred (by plan)**
- Demo apps and a demo-workspace seed arrive with Phase 3–4, so the "organise the demo apps" criterion is covered here by the API test building the CareClinic/ShopDesk trees and the UI E2E building CareClinic.
- DB connections UI → Phase 6, mail inboxes → Phase 7, reusable blocks and datasets → Phase 3/4 (with `util.useBlock` / data-driven runs), `.stepforge.zip` import/export → Phase 13.
- Monaco editors, flow view and plain-English view → Phase 4.

---

## Phase 1 — Foundation (2026-10-06)

**Delivered**
- npm-workspaces monorepo (`apps/*`, `packages/*`, `packages/executors/*`), strict TypeScript, ESM, one `tsc --noEmit` for server + packages and a separate one for the web app.
- `@stepforge/core`: ULID ids; the unified **step model** (Zod) with the full Section 5 catalogue (50 step types across 6 groups), locators, assertions, `deriveScenarioKind`; entity input schemas; `VariableResolver` (`env/secret/data/run/vars/random` scopes, type-preserving whole-placeholder resolution, descriptive errors, secret masking).
- `@stepforge/db`: complete Section 6 schema in Drizzle (28 tables incl. `load_test_authorizations` for Section 12), generated SQL migration, `openDatabase()` with WAL, foreign keys, busy timeout and a `VACUUM INTO` backup to `data/backups/` before any migration on an existing DB (keeps the last 10), typed settings helpers.
- `@stepforge/crypto`: AES-256-GCM encrypt/decrypt/rotate, master key auto-created at `data/.key` (0600).
- `@stepforge/server` (Fastify 5): hard-coded `127.0.0.1` bind with next-free-port fallback, per-start session token (header or `?token=` for WebSocket, timing-safe compare), Host allow-list against DNS rebinding, request logging disabled (no secrets in logs), Zod → 400 error mapping, `/api/health`, `/api/system`, `/api/settings` (validated per key), `/api/ws` live channel, SPA hosting with token injection, unfinished runs marked `interrupted` on boot.
- `@stepforge/web`: React 19 + Vite 8 + Tailwind v4 + TanStack Router/Query + motion. Dark-first theme tokens with light mode, icon rail for all 12 sections, top bar (app switcher placeholder, search, live-connection indicator, Run button), `Ctrl+K` command palette, `?` shortcuts overlay, `G`-chord navigation, skeleton/empty/error states, Home KPIs from real counts, working theme setting. Inter + JetBrains Mono bundled locally (no CDN).
- `setup.sh/.bat`, `start.sh/.bat`, `npm run dev` (server watch + Vite HMR with token injection), `.env.example`, `.npmrc`, MIT license.
- CI (Ubuntu + Windows): secrets check, lint, typecheck, unit tests, build, Playwright E2E.

**Verified**
- `npm run lint`, `npm run typecheck` — clean.
- `npm test` — 31 unit tests passing (core, crypto, db, server).
- `npm run test:e2e` — 5 Playwright tests passing (home loads with live WS, rail + deep links, Ctrl+K, `?` overlay, theme persistence).
- Manual: `npm start` → migrations applied, `/api/system` 401 without token / 200 with token, foreign Host → 403, WebSocket rejected without token, SPA deep link serves `index.html` with injected token.
- `npm audit --omit=dev` — 0 vulnerabilities.

**Not verified in this phase**
- `setup.bat` / `start.bat` were written but not executed on Windows (development machine is macOS); the Windows CI job covers `npm ci`/build/tests, not the `.bat` files. Tracked in KNOWN_ISSUES.
