# BUILD PROMPT — StepForge

> Save this file in an empty folder named `stepforge`, open it in VS Code, and tell Claude Code:
> **"Read STEPFORGE_BUILD_PROMPT.md and execute it phase by phase."**
> In later sessions: **"Continue STEPFORGE_BUILD_PROMPT.md from Phase X. Check git log and docs/PROGRESS.md."**

---

## 0. Project variables

```
PROJECT_NAME   = StepForge
TAGLINE        = Record once. Test every layer. Export anywhere.
SUBTITLE       = The free, local QA studio for UI, API, database, email and performance testing.
AUTHOR_NAME    = Muzahidul Rahman
AUTHOR_ROLE    = QA Automation Engineer & Test Tooling Developer
GITHUB_URL     = https://github.com/YOUR_USERNAME/stepforge     (placeholder)
UPWORK_URL     = https://www.upwork.com/freelancers/YOUR_PROFILE (placeholder)
BRAND_PRIMARY  = #F97316   (forge orange)
BRAND_SECOND   = #6366F1   (indigo)
BRAND_PASS     = #22C55E   BRAND_FAIL = #EF4444   BRAND_WARN = #EAB308   BRAND_SKIP = #64748B
BRAND_DARK     = #0B0D12
FONTS          = Inter (UI), JetBrains Mono (code, IDs, logs)
LOGO IDEA      = an anvil whose top surface is a play/record button, with a spark
```

---

## 1. Mission

You are a senior test-tooling architect, full-stack TypeScript engineer and product designer. Build **StepForge**, a **free, open-source, local-first QA studio** that runs entirely on the user's computer and can test **any web application in any industry**.

The user can:
1. Save **multiple applications** under test, each with environments, credentials, database connections and API specs.
2. **Record** scenarios by clicking through any web app in a real browser; steps, assertions and network calls are captured.
3. Build **hybrid scenarios** that mix **UI, API, database, SQL, email, performance and utility steps** in one test.
4. **Organize** everything into Applications → Modules (nested) → Scenarios → Test Cases, with tags, priorities and owners.
5. Define **pass/fail** through assertions and performance thresholds.
6. **Run** tests from a built-in runner (one, many, suite, tag, whole app) with live progress, video, screenshots and Playwright traces.
7. Get **automatic bug reports** and a **rule-based failure diagnosis** (where it failed, likely cause, who it likely belongs to, suggested fix).
8. **Schedule** runs and get notifications.
9. View an **analytics dashboard** with trends, quality gates and drill-downs.
10. **Export** scenarios as Playwright, Cypress or Selenium code, API tests in several formats, and test documentation.

### Hard constraints
- **Zero cost:** no paid APIs, no subscriptions, no cloud services, no accounts. Only free, open-source dependencies. AI is **optional** and only through a locally installed **Ollama**; the app must be fully functional without any AI.
- **Local only:** runs on `localhost`. Nothing leaves the machine except the traffic of the tests themselves (and optional Telegram/email notifications the user configures).
- **No database server:** StepForge's own data lives in **one embedded SQLite file** (`data/stepforge.db`) plus an artifacts folder. Nothing to install or run besides Node.js.
- **Public repo quality:** anyone can clone it and be running in under 5 minutes.

### Working rules
1. **Plan first:** output the implementation plan and folder tree, then proceed without waiting unless truly blocked.
2. **Phase by phase** (Section 13). After each phase: tests, run the app, fix errors, update `docs/PROGRESS.md`, `git commit` (e.g. `feat(phase-3): api testing module`).
3. **Never fake results.** Sample data only behind an explicit `--demo` seed.
4. Validate against the **demo apps you build** (Section 14) and public practice sites: `https://www.saucedemo.com`, `https://automationexercise.com`, `https://the-internet.herokuapp.com`, `https://restful-booker.herokuapp.com` (API).
5. **Windows first, cross-platform always:** `.bat` and `.sh` scripts, `path` utilities, no shell-specific assumptions.
6. Unverifiable behavior → fallback + logged warning + entry in `docs/KNOWN_ISSUES.md`.
7. Safety rules (Section 12) are enforced in code, not only documented.

---

## 2. Tech stack (all free / open source)

| Area | Choice |
|---|---|
| Runtime | **Node.js 20 LTS+**, **TypeScript** (strict), npm workspaces monorepo |
| Server | **Fastify** + `@fastify/websocket` (live runs) + `@fastify/static` |
| Validation / shared types | **Zod** schemas shared by server, UI, CLI and codegen |
| Own storage | **SQLite** via `better-sqlite3` + **Drizzle ORM** + Drizzle migrations; WAL mode |
| Artifacts | Filesystem: `data/artifacts/...` (videos, traces, screenshots, HAR, logs, exports) |
| Frontend | **React + Vite + TypeScript + Tailwind + shadcn/ui + lucide-react**, TanStack Query + TanStack Router, Framer Motion |
| Charts | **Apache ECharts** (`echarts-for-react`) |
| Editors | **Monaco Editor** (SQL, JSON, JS snippets, code preview) |
| Flow view | **React Flow** (scenario as a node graph) |
| UI automation + recording | **Playwright** (Chromium, Firefox, WebKit) |
| HTTP | `undici`; GraphQL via plain POST |
| API schema | `ajv` + `ajv-formats`; OpenAPI via `@apidevtools/swagger-parser` |
| DB drivers | `pg`, `mysql2`, `mssql`, `better-sqlite3`, `mongodb` |
| Load testing | built-in engine on `autocannon`; optional **k6** integration if the binary is installed (export k6 scripts always) |
| Frontend perf | `web-vitals` (injected), **Lighthouse** (optional per page) |
| Email | **Mailpit** (local SMTP catcher, downloaded by setup script from its GitHub releases), `imapflow` + `mailparser` (any IMAP inbox, e.g. Gmail with app password) |
| Scheduling | `node-cron` (in-app) + CLI for Windows Task Scheduler / cron / CI |
| Reports | `exceljs` (XLSX), Playwright `page.pdf()` from HTML templates (PDF), CSV, Markdown, JUnit XML, self-contained HTML |
| Notifications | Telegram Bot API, SMTP via `nodemailer` (both optional) |
| Secrets | Node `crypto` AES-256-GCM; master key generated on first run into `data/.key` |
| Logging | `pino` |
| Testing | **Vitest** (unit), **Playwright Test** (StepForge's own E2E), snapshot tests for code generators |
| Quality | ESLint, Prettier, `tsc --noEmit`, GitHub Actions CI |
| Optional | **Ollama** (local LLM "explain this failure"), **Electron** desktop packaging (final phase) |

**Prerequisites for users:** Node.js 20+, Git. `setup` installs dependencies, Playwright Chromium, Mailpit and builds the UI. Google Chrome is **not** required (Playwright's Chromium is used).

---

## 3. Monorepo structure

```
stepforge/
├── apps/
│   ├── server/                 # Fastify API, WebSocket, static UI hosting, scheduler host
│   └── web/                    # React dashboard
├── packages/
│   ├── core/                   # Zod schemas, step model, variable resolver, scenario engine
│   ├── db/                     # Drizzle schema, migrations, repositories
│   ├── executors/
│   │   ├── ui/                 # Playwright step executor, locator healing
│   │   ├── api/                # HTTP/GraphQL executor, assertions, schema validation
│   │   ├── database/           # SQL/Mongo executor, assertions, data-quality checks
│   │   ├── email/              # Mailpit + IMAP adapters
│   │   ├── perf/               # web-vitals, Lighthouse, load engine, k6 bridge
│   │   └── util/               # variables, conditions, loops, sandboxed JS, faker data
│   ├── recorder/               # browser launcher, injected toolbar, event + network capture
│   ├── importers/              # OpenAPI, Postman, cURL, HAR, CSV datasets
│   ├── codegen/                # Playwright TS/Py, Cypress, Selenium Py/Java, API formats, docs
│   ├── diagnosis/              # rule engine, last-green diff, rules/*.yaml, optional Ollama
│   ├── reporting/              # bug reports, PDF/XLSX/CSV/MD/JUnit/HTML, templates
│   ├── analytics/              # aggregations, quality gates
│   ├── notify/                 # telegram, email
│   ├── crypto/                 # secret encryption
│   └── cli/                    # `stepforge` CLI
├── demo/
│   ├── clinic-app/             # full-stack demo (UI + REST + OpenAPI + SQLite + email/OTP)
│   ├── shop-app/               # second app (UI + REST + SQLite) to show multi-app support
│   ├── manifests/              # planted_bugs.json (StepForge must NEVER read these)
│   └── start-demos.bat / .sh
├── data/                       # gitignored: stepforge.db, artifacts/, .key, bin/ (mailpit, k6)
├── docs/
│   ├── assets/ (banner.svg, logo.svg, social-preview.png, screenshots/, demo.gif)
│   ├── samples/ (sample bug report PDF, XLSX, HTML run report, exported code)
│   ├── case-study/ (case-study.html, CASE_STUDY.md, UPWORK_LISTING.md, export/)
│   ├── ARCHITECTURE.md, DATA_MODEL.md, STEP_REFERENCE.md, CODEGEN.md, DIAGNOSIS_RULES.md,
│   ├── CLI.md, PROGRESS.md, KNOWN_ISSUES.md, TROUBLESHOOTING.md, LEGAL.md
│   └── benchmarks.json
├── scripts/ (setup helpers, capture_screenshots.ts, export_case_study.ts, benchmark.ts, seed_demo.ts)
├── .github/ (workflows/ci.yml, ISSUE_TEMPLATE/, pull_request_template.md)
├── setup.bat / setup.sh, start.bat / start.sh
├── .env.example, .gitignore, README.md, LICENSE (MIT), CHANGELOG.md, CONTRIBUTING.md, SECURITY.md
```

---

## 4. System architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│ WEB DASHBOARD (React)                                                │
│ Home analytics · Applications · Test explorer · Scenario editor ·    │
│ Recorder · API client · SQL workbench · Load designer · Runs ·       │
│ Bugs · Schedules · Exports · Settings                                │
└────────────────────────────────┬─────────────────────────────────────┘
                     REST (JSON) │ WebSocket (live run + recorder events)
┌────────────────────────────────▼─────────────────────────────────────┐
│ LOCAL SERVER (Fastify)                                               │
│  Routes · Job queue (in-process, concurrency-limited) · Scheduler    │
├──────────────────────────────────────────────────────────────────────┤
│ SCENARIO ENGINE (packages/core)                                      │
│  resolve variables → expand test case data → run steps → collect     │
│  results → hooks (before/after) → retries → artifacts                │
├────────┬────────┬──────────┬────────┬────────┬───────────────────────┤
│ UI     │ API    │ DATABASE │ EMAIL  │ PERF   │ UTIL                  │
├────────┴────────┴──────────┴────────┴────────┴───────────────────────┤
│ RECORDER · IMPORTERS · CODEGEN · DIAGNOSIS · REPORTING · ANALYTICS · │
│ NOTIFY · CRYPTO                                                      │
├──────────────────────────────────────────────────────────────────────┤
│ STORAGE: SQLite (data/stepforge.db) + data/artifacts/ filesystem     │
└──────────────────────────────────────────────────────────────────────┘
          ▲ same engine used by ▶  CLI (`stepforge run ...`) for schedulers/CI
```

**Principles**
- One **unified step model**: every step has `type`, `params`, `assertions`, `enabled`, `continueOnFail`, `timeout`, `retries`, `captureAs` (store output in a variable). Executors are plugins registered by type prefix, so new step types never change the engine.
- The **CLI and the server share the same engine**; the dashboard is just a client.
- **Isolation:** each test case runs in a fresh browser context (configurable: reuse a logged-in storage state).
- **Concurrency:** configurable parallel workers; queue persists in SQLite, so runs survive restarts (marked `interrupted`, resumable).

---

## 5. Step catalogue (types)

| Group | Step types |
|---|---|
| **ui** | `navigate`, `click`, `dblclick`, `rightclick`, `hover`, `type`, `fill`, `clear`, `press`, `select`, `check`, `uncheck`, `upload`, `dragDrop`, `scroll`, `switchTab`, `closeTab`, `handleDialog`, `switchFrame`, `waitFor`, `screenshot`, `extract` (text/attr/value → variable), `assert` (visible, hidden, text equals/contains/regex, value, count, attribute, url, title, enabled, checked), `visualCheckpoint` (compare against approved baseline) |
| **api** | `request` (REST: method, url, headers, query, body json/form/multipart/raw, auth: bearer/basic/apiKey/oauth2-client-credentials/cookie), `graphql`; assertions on status, time, headers, JSONPath, array length, regex, JSON Schema, OpenAPI contract; `extract` to variables |
| **db** | `query` (SQL), `mongoFind`, `runScript` (SQL file), `callProcedure`; assertions on row count, cell value, no-nulls, unique, in-range, equals variable; `extract`; `dataQualityCheck` (orphans, duplicates, invalid formats, negative values) |
| **email** | `waitForEmail` (to, from, subject, timeout), `assertEmail` (subject/body contains, has link, has attachment), `extractFromEmail` (regex, OTP pattern, first link), `openEmailLink` |
| **perf** | `pageMetrics` (LCP, CLS, INP, TTFB, load time with thresholds), `lighthouse` (score thresholds), `loadTest` (endpoint or API step group; profile smoke/load/stress/spike/soak; VUs, duration, ramp; thresholds on p95, p99, error rate, RPS), `queryPlan` (EXPLAIN + slow-query threshold) |
| **util** | `setVariable`, `generateData` (Faker: name, email, phone, date, number, uuid, custom pattern), `wait` (discouraged, flagged), `if/else`, `loop` (count or over dataset), `callScenario`, `useBlock` (reusable step block), `runScript` (sandboxed JS via `node:vm` with timeout, no fs/network), `log` |

**Variables:** `{{env.baseUrl}}`, `{{secret.adminPassword}}`, `{{data.email}}` (from the test case/dataset row), `{{run.id}}`, `{{random.email}}`, `{{vars.otp}}`. Masked in logs and reports.

---

## 6. Data model (SQLite via Drizzle)

All IDs are ULIDs. Every table has `created_at`, `updated_at`. JSON columns validated by Zod. Write `docs/DATA_MODEL.md` with an ER diagram (Mermaid).

**Workspace and applications**
- `applications` (id, name, slug, description, icon, color, category, tags_json, archived)
- `environments` (id, application_id, name, base_url, is_production, variables_json, browser_defaults_json)
- `secrets` (id, environment_id, key, ciphertext, iv, tag) — never returned to the UI in plaintext
- `db_connections` (id, environment_id, name, engine pg|mysql|mssql|sqlite|mongo, host, port, database, username, secret_id, options_json, read_only default 1, rollback_mode default 1)
- `mail_inboxes` (id, application_id, kind mailpit|imap, config_json, secret_id)
- `api_specs` (id, application_id, name, source openapi|postman|har, raw_path, parsed_json, version)

**Test organisation**
- `modules` (id, application_id, parent_id nullable, name, description, sort_order) → unlimited nesting (e.g. Patients → Registration)
- `tags` (id, application_id, name, color); `scenario_tags` (scenario_id, tag_id)
- `scenarios` (id, module_id, name, description, kind ui|api|db|perf|hybrid (derived), priority P1–P4, status draft|ready|deprecated, owner, preconditions, version, setup_block_id, teardown_block_id)
- `steps` (id, scenario_id, position, type, label, params_json, locators_json, assertions_json, enabled, continue_on_fail, timeout_ms, retries, capture_as)
- `blocks` (id, application_id, name, description) + `block_steps` (same shape as steps) → reusable step groups such as "Login as Admin"
- `test_cases` (id, scenario_id, code e.g. TC-PAT-001, title, data_json, expected_result, priority, technique, status active|skipped)
- `datasets` (id, application_id, name, columns_json, rows_json) → data-driven runs
- `scenario_versions` (id, scenario_id, version, snapshot_json, created_at) → change history and restore

**Execution**
- `runs` (id, application_id, environment_id, trigger manual|schedule|cli|retry, scope_json, browser, viewport, workers, status queued|running|passed|failed|interrupted|cancelled, totals_json, started_at, finished_at, duration_ms, quality_gate_json)
- `run_items` (id, run_id, test_case_id, scenario_version, status passed|failed|broken|skipped|flaky, attempt, duration_ms, error_message, failed_step_id, diagnosis_json)
- `step_results` (id, run_item_id, step_id, position, status, duration_ms, message, request_json, response_json, query_json, screenshot_path)
- `artifacts` (id, run_item_id, kind video|trace|screenshot|har|console|network|email|lighthouse|load_report, path, size)
- `perf_metrics` (id, run_item_id, step_id, metric, value, unit, threshold, passed)
- `load_results` (id, run_item_id, profile, vus, duration_s, rps, p50, p90, p95, p99, error_rate, timeline_path)

**Quality and automation**
- `bugs` (id, application_id, run_item_id, code BUG-001, title, summary, severity, priority, status open|in_progress|fixed|wont_fix|duplicate, environment_json, preconditions, steps_to_reproduce_json, expected, actual, diagnosis_json, owner_hint test|app|environment|data, fingerprint, occurrences)
- `schedules` (id, application_id, environment_id, name, cron, scope_json, enabled, notify_channel_ids_json, last_run_id, next_run_at)
- `notify_channels` (id, kind telegram|email, config_json, secret_id)
- `quality_gates` (id, application_id, name, rules_json) e.g. P1 pass rate = 100%, no open critical bugs, API p95 < 800 ms
- `exports` (id, application_id, kind, options_json, path, created_at)
- `analytics_daily` (application_id, date, runs, tests, passed, failed, flaky, avg_duration_ms, p95_api_ms) → pre-aggregated for fast charts
- `settings` (key, value_json)

**Artifacts on disk:** `data/artifacts/runs/<run_id>/<run_item_id>/{video.webm, trace.zip, step-XX.png, har.json, console.json, network.json, emails/}`. Retention policy in Settings (keep failures, prune passes after N days).

**Portability:** an application can be **exported/imported as a `.stepforge.zip`** (JSON of all its definitions, no secrets, optional artifacts), so test suites can be shared or version-controlled.

---

## 7. Module specifications

### 7.1 Applications and organisation
- Applications grid; each has environments (Local/Staging/Production), secrets, DB connections, inboxes, API specs, modules, tags, datasets, blocks, quality gates.
- **Test Explorer:** left tree (Application → Modules → Scenarios → Test Cases) with drag-and-drop, search, filters (tag, priority, kind, status, last result), multi-select actions (run, tag, move, export, duplicate, delete).

### 7.2 Recorder
- Pick application + environment → Playwright launches a **headed Chromium** with the StepForge toolbar injected via `addInitScript` inside a **Shadow DOM** (no CSS clashes) and wired with `exposeBinding`.
- Toolbar: Record/Pause, **Assert mode** (click an element → choose assertion), **Extract** (save text to variable), **Insert step** (API/DB/email/wait/comment), **Mask** (mark field as secret), Undo last, Stop.
- Captures clicks, inputs (debounced into one `fill`), selects, checks, uploads, key presses, navigations, new tabs/popups, dialogs, iframes.
- **Locators:** store multiple strategies per element, ranked: `data-testid`/`data-test`/`data-cy` → ARIA role + accessible name → label → placeholder → stable text → stable CSS (ignore hashed/auto-generated classes) → XPath (last resort). Show the chosen one and allow switching.
- **Network capture:** record XHR/fetch traffic during recording; afterwards offer "Create API tests from N captured requests" (dedupe by method + path template, strip noise like analytics/fonts).
- Inputs typed into password fields are **auto-masked** into secrets.
- Recording ends in the **Scenario Editor** for review.

### 7.3 Scenario Editor
- **List view** (ordered steps with icons by type, inline edit, enable/disable, drag to reorder, duplicate, comment) and **Flow view** (React Flow nodes coloured by layer: UI blue, API indigo, DB green, Email amber, Perf pink, Util grey).
- Step side panel with typed forms per step type; Monaco for JSON, SQL and scripts.
- **Plain-English view:** every scenario renders as readable steps ("1. Open /login 2. Type `{{data.email}}` into *Email* …"), used for docs and bug reports.
- **Test cases tab:** table of data rows, expected results, technique labels (positive, negative, boundary, etc.); "Generate variants" helper produces boundary/negative data for selected fields **using rules (no AI)**.
- Version history with diff and restore.
- **Run this scenario** button (choose test cases, environment, browser, headed/headless).

### 7.4 API Client (standalone + steps)
- Postman-like interface: collections = modules, requests = API scenarios, environments, auth, chaining, assertions, response viewer (pretty JSON, headers, timing breakdown, size).
- **Import:** OpenAPI 3 / Swagger 2 (auto-generate per endpoint: a happy-path test using spec examples, plus negative tests for missing required fields, wrong types, invalid enum, unauthorized), Postman v2.1 collections, cURL, HAR.
- **Contract check:** validate live responses against the imported spec.

### 7.5 SQL Workbench (standalone + steps)
- Connection manager with "Test connection", read-only badge, production warning banner.
- Schema browser (tables, columns, keys, indexes), Monaco SQL editor with autocomplete from schema, result grid with export to CSV.
- "Save as DB test" turns a query into a scenario step with assertions.
- **Data Quality Audit:** pick tables → run checks (orphaned FKs, duplicates on chosen columns, NULLs in required columns, invalid email/phone formats, negative numerics) → report.
- **Rollback mode:** wrap test runs in a transaction and roll back at the end; write queries blocked on read-only connections.

### 7.6 Email Testing
- **Mailpit** started/stopped from Settings (binary in `data/bin/`); UI shows the captured inbox.
- **IMAP** adapter for any provider (Gmail + app password, with plus-addressing `user+{{run.id}}@gmail.com` documented as the trick for unique sign-ups).
- Built-in OTP extractor (4–8 digit codes, common phrasing) and link extractor; custom regex supported.

### 7.7 Performance
- `pageMetrics` collected automatically on every UI navigation (toggle), thresholds as assertions.
- Lighthouse runs on demand per URL or as a step.
- **Load Designer:** choose an API step or group, profile, VUs, duration, ramp; live chart of RPS, latency percentiles, errors; built-in engine (autocannon); "Export as k6 script"; run via k6 if detected.
- Clear UI warning: only load-test systems you own or are authorized to test; local machine limits apply.

### 7.8 Runner
- Run scopes: test case, scenario, module (recursive), tag, saved selection, whole application.
- Options: environment, browser(s), viewport presets (desktop 1440, tablet 768, mobile 390), headed/headless, workers, retries, stop on first failure, video (off / on failure / always), trace (off / on failure / always).
- **Live Run view:** progress, per-test status, current step highlighted, live screenshot thumbnail, logs stream; cancel.
- **Results view:** summary, filters, each test → step timeline with durations, screenshots, request/response, query results, email preview, perf metrics, video player, **embedded Playwright Trace Viewer** (serve `trace.zip` with Playwright's trace viewer assets), console/network logs.
- **Flaky detection:** failed then passed on retry → `flaky`.

### 7.9 Diagnosis Engine (free, rule-based)
- Inputs: failed step, error, DOM snapshot at failure, console, network log, API/DB responses, timings, plus the **same test's last passing run**.
- **Last-green diff:** DOM diff around the target, locator candidates now found, API response diff, timing diff, environment/browser diff.
- **Rules** in `packages/diagnosis/rules/*.yaml` (user-extendable), each with: match conditions → `category`, `title`, `explanation` (templated with real values), `owner_hint` (test | app | environment | data), `suggested_fix`, `confidence`. Cover at least:
  locator changed (with healed candidate + one-click accept), element hidden/covered, navigation timeout, slow API correlated with timeout, 400/401/403/404/409/422/429/500/502/503, CORS, network offline/DNS, JSON schema mismatch (field-level), assertion mismatch (value diff + numeric difference), DB connection refused, DB constraint violation, empty result set, email not received in time, OTP pattern not found, JS console exception (with source location), flaky timing, perf threshold exceeded (by how much vs baseline), test-data collision.
- Output appears on the failed test and in the bug report: **Where** (step + screenshot), **Why (likely)**, **Whose issue**, **How to fix**, **Evidence**.
- Optional "Explain in plain English" button only if Ollama is reachable at `localhost:11434` (model configurable); hidden otherwise.

### 7.10 Bug reports
- Auto-created on failure (deduplicated by fingerprint: scenario + failed step + error category; occurrences counted).
- Fields: Bug ID · Title · Summary · Application · Module · Environment (URL, browser + version, OS, viewport, date/time) · Severity (derived from priority + category, editable) · Priority · Preconditions · **Steps to Reproduce (plain-English steps with data)** · Expected · Actual · Diagnosis · Evidence (annotated screenshot with failing element highlighted, video clip, trace, logs, request/response) · Linked test case · Status.
- Exports: single-bug PDF, bug list PDF, XLSX, Jira/Trello-compatible CSV, Markdown (GitHub issue format).

### 7.11 Analytics dashboard
- **Home:** KPI cards (applications, scenarios, test cases, runs this week, pass rate, flaky rate, open bugs, avg duration), **Quality Gate** status per application (green/amber/red with failing rules), pass/fail trend (stacked area), recent runs, upcoming schedules.
- **Application analytics:** results by module, by layer (UI/API/DB/Email/Perf), by tag, by environment; failure categories (from diagnosis); top failing tests; slowest tests; flaky list; performance trends (page LCP, API p95, load results); calendar heatmap; **run comparison** (pick two runs: fixed, new failures, still failing, perf deltas).
- Everything drills down to the failing step.

### 7.12 Scheduling, CLI, notifications
- Schedules: cron builder UI (presets + custom), scope, environment, notify channels, enable/disable, next-run preview, history.
- CLI (`npx stepforge` / `stepforge.bat`): `run --app <slug> --env staging --tag smoke --workers 2`, `list`, `export`, `import`, `report --run <id> --format pdf`. Exit code 0/1, `--junit out.xml`, `--html report.html`. Docs explain Windows Task Scheduler and GitHub Actions usage.
- Notifications: Telegram and email with summary, failed tests, diagnosis titles, quality gate status; "Send test" button.

### 7.13 Code generation
| Source | Targets |
|---|---|
| UI / hybrid scenarios | **Playwright Test (TypeScript)**, Playwright (Python + pytest), **Cypress (JavaScript)**, **Selenium (Python + pytest)**, Selenium (Java + JUnit 5); option: plain specs or **Page Object Model** |
| API scenarios | Playwright `request` tests, Cypress `cy.request`, Python `pytest + requests`, Java **REST Assured**, **k6** script, Postman v2.1 collection, cURL |
| DB steps | SQL files, helper module per target (pg/mysql2 for JS, psycopg/pymysql for Python, JDBC for Java) |
| Email steps | helper module per target (Mailpit API / IMAP) |
| Docs | Test cases XLSX, Markdown, **Gherkin** `.feature` |
| CI | GitHub Actions workflow, GitLab CI file |

- Output is a ready-to-run project folder (package.json / requirements.txt / pom.xml, config with environment variables, README).
- Each generator has **snapshot tests**; CI runs the exported **Playwright** project against the demo app to prove generated code works (Cypress and Selenium exports verified locally and documented).
- Steps that cannot be translated exactly (e.g. multi-tab or cross-origin in Cypress) produce a `// TODO(StepForge): ...` comment and a warning list in the export dialog. Never emit silently broken code.

### 7.14 Settings
Theme, artifact retention, default browser/viewport/timeouts, workers, Mailpit control, k6 path, Ollama URL/model, encryption key rotation, notification channels, branding for reports (logo, company name, colours), import/export of applications, danger zone.

---

## 8. UI / UX direction

- Premium dark-first developer tool (Linear × Postman × Grafana), light mode supported. `BRAND_DARK` surfaces, orange primary actions, indigo secondary, status colours as defined, 12px radius, 1px subtle borders, glassy elevated panels, smooth Framer Motion transitions.
- **Layout:** left icon rail (Home, Applications, Test Explorer, Recorder, API, SQL, Performance, Runs, Bugs, Schedules, Exports, Settings) + application switcher at top + `Ctrl+K` command palette (jump to any scenario, run anything) + global "Run" button.
- Every screen has loading skeletons, empty states with a clear next action, and error states with retry.
- **First-run onboarding:** welcome → "Load demo workspace" (seeds the two demo apps with ready scenarios) or "Create your first application" → guided recorder tour.
- Keyboard shortcuts documented in a `?` overlay.
- Responsive from 1280px wide; dashboard readable on 1024px.

---

## 9. Security of StepForge itself
- Server binds to `127.0.0.1` only. Random session token generated at start and required by the UI and WebSocket (prevents other local sites from calling the API).
- Secrets encrypted with AES-256-GCM; never logged, never exported, masked as `••••` in UI, reports and generated code (generated code reads them from environment variables).
- `data/` gitignored; CI check fails if `data/` or `.env` content is committed.
- Sandboxed JS steps: `node:vm` with timeout and no `require`, `process`, filesystem or network.

---

## 10. Storage, performance and reliability
- SQLite in WAL mode; migrations run automatically on startup with a backup copy taken first (`data/backups/`).
- Large payloads (bodies, DOM snapshots) stored as artifacts, not in table rows (store paths).
- `analytics_daily` updated after each run; heavy charts query only aggregates.
- Artifact retention job runs daily.
- Graceful shutdown: running jobs marked `interrupted`; resumable from the Runs page.

---

## 11. Testing StepForge itself
- Vitest for core (variable resolver, step validation, locator ranking, diagnosis rules with fixture inputs, analytics aggregation, codegen snapshots, importers with sample OpenAPI/Postman/HAR files).
- Playwright Test E2E for the dashboard (create app, record against the demo, run, view result, export).
- CI on Windows and Ubuntu: lint, typecheck, unit tests, build, E2E against demo apps, run an exported Playwright project.

---

## 12. Safety and responsible use (enforce in code)
- Applications marked **Production** show a red banner; destructive DB queries and load tests on production require typing the application name to confirm.
- DB connections default to **read-only + rollback mode**.
- Load tests require an "I own or am authorized to test this system" confirmation per application (stored with timestamp).
- No CAPTCHA solving or 2FA bypass; recommend saved logged-in sessions (storage state) or test environments.
- `docs/LEGAL.md` explains authorized testing.

---

## 13. Build phases

| # | Phase | Done when |
|---|---|---|
| 1 | Monorepo, Zod core, Drizzle schema + migrations, crypto, Fastify skeleton, React shell, setup/start scripts, CI | `start.bat` opens an empty dashboard; tests green |
| 2 | Applications, environments, secrets, modules, tags, Test Explorer, scenario + step + test case CRUD, version history | Organise a full test tree for the demo apps |
| 3 | Scenario engine + UI executor + runner + live view + video/screenshots/trace + results view | Manually built UI scenario runs with evidence |
| 4 | Recorder (toolbar, assertions, extract, masking, locators, network capture) + Scenario Editor list & flow views + plain-English view | Record a login + booking flow on the clinic demo and replay it |
| 5 | API module + API Client + importers (OpenAPI, Postman, cURL, HAR) + contract check + captured-requests → API tests | OpenAPI import generates a passing/failing suite for the demo |
| 6 | Database module + SQL Workbench + data-quality audit + rollback mode | DB assertions inside a hybrid scenario pass |
| 7 | Email module (Mailpit + IMAP) + OTP/link extraction | Demo sign-up with email OTP passes end to end |
| 8 | Performance (page metrics, Lighthouse, load designer, k6 export/bridge, query plans) | Load test report with thresholds |
| 9 | Diagnosis engine + last-green diff + bug reports + all report exports | Planted bugs produce correct diagnoses |
| 10 | Analytics dashboard + quality gates + run comparison + flaky detection | Dashboard populated from real runs |
| 11 | Scheduler + CLI + notifications + JUnit/HTML outputs | Scheduled run sends a Telegram/email summary |
| 12 | Code generators (all targets) + export dialog + snapshot tests + exported-code CI check | Exported Playwright project passes in CI |
| 13 | Public-repo polish: README, docs, onboarding, fresh-clone test on Windows and Linux | Section 16 checklist passes |
| 14 | Showcase package (Section 15) + optional Electron build | All showcase files exist with exact sizes |

---

## 14. Demo apps (the proof)

Build two small, realistic full-stack apps in `demo/` (Node + Express or Fastify, server-rendered or light React UI, **SQLite** database, **REST API with an OpenAPI 3 spec**, `data-testid` on about half the elements so locator healing is exercised):

- **CareClinic** (`:8101`, API `:8101/api`): roles Admin, Doctor, Receptionist; patients, doctors, appointments, prescriptions, billing; **sign-up with email verification + login OTP via Mailpit**.
- **ShopDesk** (`:8102`): roles Admin, Cashier; products, stock, sales, purchases, profit report.

Seed fake data; "Reset demo" endpoint. `start-demos.bat/.sh` starts both plus Mailpit.

Plant **bugs at every layer** (12–15 per app): UI (wrong label, broken button on mobile, JS error), API (wrong status code, schema violation, missing auth check), DB (orphan rows after delete, negative stock allowed, duplicate patients), email (OTP expires instantly, wrong link), business logic (bill ignores insurance, double-booking allowed, profit miscalculated), performance (one deliberately slow endpoint and an N+1 query). Document them in `demo/manifests/planted_bugs.json`, which **StepForge must never read**. `scripts/benchmark.ts` runs the bundled demo suites and records real detection numbers, run times and diagnosis accuracy to `docs/benchmarks.json`. **Only these real numbers may appear in the README, case study and Upwork assets.**

Ship the **demo workspace** (`.stepforge.zip` for each demo app) with well-organised scenarios covering UI, API, DB, email, perf and hybrid flows, so new users see a populated, impressive dashboard within a minute.

---

## 15. Showcase package (GitHub + portfolio + Upwork)

### 15.1 Screenshots
`scripts/capture_screenshots.ts` runs StepForge with the demo workspace and captures every major screen at 1440×900 @2x (dark; plus light for Home, Scenario Editor, Results) into `docs/assets/screenshots/`. Also produce `docs/assets/demo.gif`-ready short clips with Playwright video for: recorder in action, live run, failure diagnosis.

### 15.2 Samples
From real demo runs, copy into `docs/samples/`: bug report PDF, run report XLSX, self-contained HTML run report, one exported Playwright project, one exported Cypress spec, one exported Selenium test, one k6 script.

### 15.3 Case study slides: `docs/case-study/case-study.html`
Self-contained HTML (inline CSS, Inter), dark premium style, each slide exactly **1600×1200**, real screenshots in browser mockups:
1. Cover (name, tagline, hero, tags: QA Automation · Playwright · Cypress · Selenium · API · SQL, author)
2. The Problem (QA tools are fragmented, paid, or locked to one framework; teams test layers separately)
3. The Solution (one sentence + 6 layer icons)
4. Record Once (recorder + captured API calls)
5. Every Layer in One Test (hybrid scenario flow view)
6. API & Database Testing (API client + SQL workbench)
7. Email & OTP Testing
8. Performance (page metrics + load test chart)
9. Smart Failure Diagnosis (diagnosis panel with Where / Why / Whose / Fix)
10. Analytics & Quality Gates
11. Export Anywhere (same scenario in Playwright, Cypress, Selenium side by side)
12. Engineering Highlights (unified step model, plugin executors, self-healing locators, last-green diff, local-first, zero cost)
13. Results (real numbers from `docs/benchmarks.json` only)
14. Tech Stack
15. Call to Action (AUTHOR_NAME, "Need test automation or QA tooling? Let's talk.", Upwork link)

### 15.4 Export: `scripts/export_case_study.ts`
Using Playwright, produce in `docs/case-study/export/`:
```
StepForge-Case-Study.pdf              # all slides, one per page, fonts embedded
slides/slide-01.png … slide-15.png    # 1600×1200
upwork/00-thumbnail.png               # 1600×1200 cover: big name, one benefit line, hero screenshot,
                                      #   bold real-stat badge, high contrast, content inside centred 90% safe area
upwork/01 … 06.png                    # gallery: hybrid flow, recorder, API+SQL, diagnosis, analytics, export
upwork/jpg/                           # same as optimized JPG < 2 MB each
social/github-social-preview.png      # 1280×640
social/linkedin-x-post.png            # 1200×675
```
Verify dimensions and file sizes programmatically and visually check for text overflow.

### 15.5 `docs/case-study/UPWORK_LISTING.md`
Title (≤70 chars), role, description (≤600 chars, real numbers only), 5 skill tags, image upload order, PDF to attach, project URL placeholder.

### 15.6 `docs/case-study/CASE_STUDY.md`
Full story in markdown embedding the slide PNGs.

### 15.7 README.md (public repository)
1. Centred `docs/assets/banner.svg` (create: 1280×400, dark, forge-orange glow, logo, name, tagline) + shields.io badges (CI, Node, TypeScript, Playwright, Cypress export, Selenium export, License MIT, "100% Local", "Zero Cost").
2. Pitch paragraph + `demo.gif` (HTML comment describing what the author should record).
3. Table of contents.
4. **Why StepForge:** comparison table vs "recorder-only tools" and "paid platforms" (feature checkmarks, factual, no competitor bashing).
5. **Features** by layer (UI, API, DB, Email, Performance, Diagnosis, Analytics, Scheduling, Export) with ✅.
6. **Quick start** (copy-paste): prerequisites table (Node 20+, Git; note nothing else needed); Windows: `git clone` → `cd stepforge` → `setup.bat` → `start.bat`; macOS/Linux with `.sh`; "Load demo workspace in 60 seconds" walkthrough with demo credentials.
7. **Your first recorded test** (5 numbered steps with screenshots).
8. **How it works:** Mermaid architecture diagram + step model explanation.
9. **Screenshots** grid (HTML table with captions).
10. **Export examples:** the same scenario shown in Playwright, Cypress and Selenium inside `<details>` blocks.
11. **CLI & CI** usage.
12. **Benchmarks** (real).
13. **Data & privacy:** everything local, where data lives, how secrets are encrypted.
14. **Configuration** (`.env`, Settings) in `<details>`.
15. **Safety & responsible use** (link LEGAL.md).
16. **Troubleshooting / FAQ** (port in use, Playwright browser install, PowerShell execution policy, antivirus, Mailpit port, IMAP app passwords).
17. Roadmap (checkboxes), Contributing, License.
18. Centred author card with Upwork + GitHub `for-the-badge` buttons.

All image paths must exist; all commands verified on a fresh clone.

---

## 16. Final checklist

- [ ] Fresh clone on Windows and Ubuntu: only Node + Git installed → `setup` → `start` → onboarding → demo workspace loads → a hybrid run passes/fails as expected.
- [ ] No paid API, account or subscription required anywhere; app fully functional with Ollama absent.
- [ ] Multiple applications with separate environments, secrets, connections and test trees.
- [ ] Recorder captures UI + network; API tests generated from captured traffic.
- [ ] OpenAPI, Postman, cURL, HAR import works.
- [ ] DB tests on SQLite + PostgreSQL + MySQL verified (Docker-free: document how users point to their own servers; CI may use service containers).
- [ ] Email OTP flow works with Mailpit; IMAP adapter covered by tests.
- [ ] Load test produces percentiles and threshold verdicts; k6 export valid.
- [ ] Diagnosis correctly labels each planted bug category; benchmarks recorded.
- [ ] Bug reports complete with evidence; all export formats open correctly.
- [ ] Analytics, quality gates, run comparison and flaky detection populated from real runs.
- [ ] Scheduler + CLI + JUnit + notifications work.
- [ ] Exported Playwright project passes in CI; Cypress and Selenium exports run locally against the demo.
- [ ] Secrets never appear in logs, exports, reports or generated code.
- [ ] Every screen has loading, empty and error states; `Ctrl+K` works.
- [ ] README renders perfectly on GitHub; docs complete.
- [ ] Showcase files exist with exact sizes (15 slides, PDF, Upwork thumbnail + 6 gallery PNG/JPG, social images, UPWORK_LISTING.md, CASE_STUDY.md, samples).
- [ ] Final summary to the author: what was built, how to run it, real benchmark results, known limitations, manual to-dos (record demo GIF, set GitHub social preview, replace URL placeholders, optional Electron installer).

**Start now with the plan and Phase 1.**
