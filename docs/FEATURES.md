# Everything StepForge does

_By Md Zarin Tasnim · part of the StepForge documentation_

A tour of every feature, grouped by what you are trying to do, with a link to the detailed guide. Everything runs on
your computer, is free and open source, and needs no account.

## Organise your tests

- **Applications and environments** — one application per product, with environments (Local, Staging, Production)
  that hold the base URL, variables, encrypted secrets, database connections, email inboxes and
  [browser settings](WEB_APPS.md#environment-browser-settings). Production environments show a red banner and ask
  for typed confirmation before anything risky.
- **Test Explorer** — modules and sub-modules, scenarios with priority, status, owner, tags and preconditions,
  filters, bulk move, duplicate, and version history with restore.
- **Test cases** — one scenario, many data rows (`{{data.x}}`): each row runs as its own test.
- **Reusable blocks** — shared step groups ("Sign in") with inputs, *Make a block* from selected steps, a "used by"
  list, and failures grouped by block. [BLOCKS.md](BLOCKS.md)
- **Before/after each test (hooks)** — a module or scenario runs a block before and after every test; after-hooks run
  even after a failure. [BLOCKS.md](BLOCKS.md#hooks)
- **Element repository** — named, shared UI elements; fix a locator once and every step follows. [ELEMENTS.md](ELEMENTS.md)
- **Test data library** — tables, CSV files, read-only SQL queries and API calls as data sources; `util.useData`
  picks the first, a random, a given, a matching or an unused row. [TEST_DATA.md](TEST_DATA.md)
- **Import and export an application** — a portable file with modules, scenarios, blocks, elements, data sources,
  campaigns and environments (without secret values).

## Create tests

- **Recorder** — click through your app; every click and field becomes a step with ranked, self-healing locators.
  Add checks (*Assert*), keep values (*Extract*) and hide values (*Mask*) from the toolbar; passwords become secrets.
  Start it from the Recorder page or from the Test Explorer (*Create & record*, *Record steps*, *Record a scenario*).
  The network traffic it sees can become an API scenario.
- **Scenario editor** — the same steps as a list, a flow diagram or plain English; typed fields per step, an element
  picker, nested steps for conditions and loops, and an advanced JSON view.
- **Every layer in one test** — UI, API, database, email and performance steps share variables, so one test can sign
  in through the page, call the API with the captured token and check the database row it created.
  [STEP_REFERENCE.md](STEP_REFERENCE.md)
- **Conditions and loops** — *if* a value compares, or *if* the page shows something (visible, hidden, present, text,
  count); repeat N times, for each item, or *while* a condition holds. [STEP_REFERENCE.md](STEP_REFERENCE.md#utility-steps-util)
- **API Client and importers** — send requests by hand, then save them as steps; import OpenAPI, Postman, cURL and HAR;
  check responses against the OpenAPI contract.

## Test any web app

Single-page apps, PWAs, canvas and map apps, downloads, iframes, popups and OAuth windows, shadow DOM, mobile web with
touch, sites behind basic auth or client certificates, localised and time-zone-dependent apps, dark mode, time-based
features and visual regressions — with network waiting and mocking, offline mode, cookies and storage, a controllable
clock and visual checkpoints. [WEB_APPS.md](WEB_APPS.md)

## Run tests

- **Run dialog** — browser (Chromium, Firefox, WebKit; or installed Chrome/Edge per environment), size (desktop,
  tablet, mobile), workers, retries, headed or headless, evidence settings.
- **Live view** — steps appear as they run, with the latest screenshot.
- **Manual testing** — tests are automated or manual (manual ones stay pending and are left out of schedules).
  **Run manually** opens the app in a browser with a StepForge panel: current step, expected result, next step,
  pass / fail / blocked / skip, notes, screenshots and screen-recording clips; the session is recorded. Mark up
  screenshots (boxes, circles, arrows, pen, text) and file bug reports (expected vs actual). [MANUAL_RUNS.md](MANUAL_RUNS.md)
- **Evidence** — screenshots, video, Playwright traces (opened in the local Trace Viewer), console and network logs,
  downloads, API requests and responses, database results, received emails.
- **Run queue** — one run at a time; waiting runs start by priority (high, normal, low — in the Run dialog, schedules,
  campaigns and `--priority` in the CLI), then oldest first. The Runs page shows the queue with **Run next**, a
  priority picker and Cancel.
- **Campaigns** — a saved test set across environments × browsers × sizes in one click, a combined report, and
  *Rerun failed* only where it failed. [CAMPAIGNS.md](CAMPAIGNS.md)
- **Schedules and notifications** — cron schedules for tests or campaigns; summaries to Slack, Microsoft Teams,
  Mattermost, Rocket.Chat, Telegram, email or any webhook (JSON).
  [SCHEDULING.md](SCHEDULING.md)
- **CLI and CI** — `stepforge run` / `campaign` with JUnit, HTML and PDF reports and exit codes for any CI.
  [CLI.md](CLI.md)

## Check more than the page

- **SOAP, Kafka and FTP** — call SOAP services (faults, XPath checks), send and wait for Kafka messages, upload,
  download and check files over FTP, FTPS or SFTP. XPath also checks any XML response. [INTEGRATIONS.md](INTEGRATIONS.md)
- **Databases** — SQLite, PostgreSQL, MySQL, SQL Server and MongoDB; read-only and rollback modes; a SQL Workbench and a
  data-quality audit (orphans, duplicates, nulls, formats). [DATABASES.md](DATABASES.md)
- **Email** — a local Mailpit or any IMAP inbox; wait for an email, check it, extract one-time codes and links.
  [EMAIL.md](EMAIL.md)
- **Performance** — Web Vitals per page, Lighthouse, load tests with percentiles and thresholds, k6 export, database
  query plans. [PERFORMANCE.md](PERFORMANCE.md)
- **Network traffic** — a breakdown of every test's requests by type and host (third parties marked), slowest and
  largest requests and failures, and `ui.networkSummary` budgets (page weight, failed requests, third-party hosts).
  [WEB_APPS.md](WEB_APPS.md#network-traffic)
- **Visual checkpoints** — screenshot comparison with a difference image and one-click *Accept as new baseline*.
  [WEB_APPS.md](WEB_APPS.md#visual-checkpoints)

## Understand failures

- **Diagnosis** — every failure gets "where, why, whose issue (application, test, environment or data) and how to
  fix", with evidence; a changed locator gets a one-click fix (also inside blocks and saved elements).
  [DIAGNOSIS.md](DIAGNOSIS.md)
- **Bug reports** — created automatically with screenshots and steps; PDF, HTML, Markdown, Jira and Trello CSV, Excel.
- **Analytics** — pass-rate trends, quality gates, flaky tests, slowest and most-failing tests, run comparison.
  [ANALYTICS.md](ANALYTICS.md)
- **Optional local AI** — "Explain in plain English" with a local Ollama, if you have one; nothing is sent anywhere.

## Take your tests elsewhere

- **Code export** to 13 targets — Playwright (TypeScript, Python), Cypress, Selenium (Python, Java), pytest + requests,
  REST Assured, k6, Postman, cURL, Markdown, Gherkin and Excel test cases — with optional page objects and CI files.
  Anything a target cannot express is marked `TODO(StepForge)`, never dropped silently. [CODEGEN.md](CODEGEN.md)

## Workspace

- **Demo workspace** — two demo apps (CareClinic and ShopDesk) with planted bugs, ready-made tests and a benchmark.
- **Settings** — runner defaults, evidence retention, notification channels, report branding, key rotation for the
  encrypted secrets.
- **Keyboard first** — `Ctrl+K` command palette, `?` shortcuts, `G` navigation chords; dark and light themes.

## Coming next

The latest additions are in [WHATS_NEW.md](WHATS_NEW.md); planned work is in the README's
[Coming next](../README.md#coming-next).

- Native mobile and desktop apps: [NATIVE_APPS_PLAN.md](NATIVE_APPS_PLAN.md).
