# Changelog

## [Unreleased]

### Added
- **More code export**: the newer steps become working code instead of `TODO(StepForge)` wherever the framework can
  do what StepForge does. Playwright (TypeScript and Python) exports every one: touch taps, downloads, waiting for a
  response, faked routes, offline, cookies and storage, the page clock, the network summary, page conditions and
  "repeat while" loops (with StepForge's limit). Selenium (Python, Java) exports taps (a touch pointer), downloads,
  storage, page conditions and loops, and offline in Python; Cypress exports taps, downloads, `cy.intercept` mocks and
  response waits, storage, a fixed clock, page conditions and loops. SOAP (with XPath and fault checks), JSON Schema
  checks, OAuth2 client-credentials tokens, Kafka, FTP / FTPS / SFTP and MongoDB steps are exported to the
  Playwright, Selenium, Cypress, pytest and REST Assured projects; k6, Postman and cURL send SOAP and fetch OAuth2
  tokens, Postman checks schemas and k6 runs loops on values. Each target declares what it prints
  (`packages/codegen/src/features.ts`); anything else stays a TODO whose warning names the target, and the libraries a
  step needs are added to the generated project only when it is used. `scripts/verify-browser-export.ts` runs the
  exported projects against a small local web app, and copies with one wrong expectation per test that must fail.
- **Desktop app** (`apps/desktop`, Electron): StepForge in its own window. Installed, the server runs on Electron's
  own Node.js (better-sqlite3 rebuilt for it), data lives in the user's app-data folder, and the first start downloads
  Playwright's Chromium and Mailpit (with a connection check first, so an offline start opens at once). From a clone,
  `npm run desktop`. One window per data folder; an already running server is opened instead of starting a second;
  quitting shuts the server down over IPC, and the server stops if the app dies. `npm run desktop:package` builds the
  installers (`.dmg`, `.exe`, AppImage, `.deb`; not signed yet); `apps/desktop/scripts/smoke.mjs` starts the built app
  and runs the demo tests in it; the `Desktop app` workflow builds and tests each system and attaches the installers to
  a draft release on a version tag. Appium installs from the app use the portable Node.js (with npm).
- **Frames inside frames**: `ui.switchFrame` takes a chain, `#outer >>> #inner` (`frameChain()` in core); the recorder
  records the full chain, and Playwright (TS, Python) and the Selenium helpers (Python, Java) follow it. The Selenium
  helpers also understand `>> nth=N`.
- **Verified downloads**: `downloadRelease()` (`@stepforge/core/download`) checks Mailpit and k6 against pinned SHA-256
  hashes, or GitHub's published digest for another version.
- **Appium and Maestro export** (N7): four new targets for phone and desktop apps — `appium-py` (Appium-Python-Client
  + pytest), `appium-ts` (WebdriverIO + Mocha, TypeScript), `appium-java` (java-client + JUnit 5, Maven) for Android,
  iOS, macOS, Windows and Linux, and `maestro` (YAML flows) for Android and iOS. The plan gets a native mode: phone and
  desktop steps become `app` operations, and each element carries the Appium selectors the native executor's own
  locator mapping gives on that platform (`@stepforge/executor-native/locators`). Capabilities come from the
  environment's launch settings (`APPIUM_URL`, `APP` override). Each Appium project ships a runtime helper
  (`runtime/py/app.py`, `runtime/ts/app.ts`, `runtime/java/App.java`) that mirrors the executor's per-platform
  behaviour; Linux exports include `tools/stepforge_atspi.py`. Maestro flows map test cases to one flow each, secrets to
  `MAESTRO_*` variables, and close the keyboard before Android's Back. GitHub Actions workflows per platform; GitLab is
  not generated for these apps. The Exports page and `codegen --list` show the targets for the application's platform;
  the server refuses them for web apps (400).
- **Electron export**: for an Electron app with launch settings, the Playwright Test export starts the app with
  `_electron.launch()` (`support/electron.ts`): each test's `page` is the app's first window.
- `scripts/verify-native-export.ts` runs the exported projects against the demo apps (Android, iOS, macOS, Windows,
  Linux, Electron), with `--wrong-password` to check that failures fail; the `android`, `ios`, `macos-desktop`,
  `windows-desktop`, `linux-desktop` and `exported-code` CI jobs run it.
- **Linux desktop apps**: a new platform _Linux app_ (GTK, Qt). An environment gives the app's command, arguments,
  environment variables and working folder. StepForge's own helper (`packages/executors/native/linux/
  stepforge_atspi.py`, Python + PyGObject) drives the app through AT-SPI and speaks the WebDriver subset the native
  executor uses, so steps, locators (accessible id, name, AT-SPI roles, ElementTree XPath, pictures), menus, dialogs
  and screenshots work as on other desktops. `doctor native --platform linux`; demo app `demo/linux-app`
  (Python, GTK 3); CI job in a D-Bus session on a virtual display.
- **Image locators**: a new locator strategy `image` (a PNG picture, stored in the step as a data URL, or a `.png`
  path; `threshold` 0.5–1, default 0.9) found in a screenshot by a built-in matcher (`@stepforge/image-match`:
  normalized cross-correlation on grayscale, coarse-to-fine; no native dependency). Web and Electron: click,
  double-click, right-click, hover, tap and visible / hidden checks and waits at the match, in ranked order with the
  other locators. Phone and desktop apps: the match acts like an element (taps, long presses, typing, visible),
  through W3C pointer actions. A miss reports the best score. The step editor uploads the picture with a preview and
  a % match field; exports leave image locators out (picture-only steps become a TODO). See
  [docs/IMAGE_LOCATORS.md](docs/IMAGE_LOCATORS.md).
- **macOS and Windows desktop apps**: new platforms _macOS app_ and _Windows app_. Environments name the app: a
  bundle id or .app (with arguments and environment variables) for macOS; an .exe or Store app id (with arguments and
  a working folder) for Windows. The native executor drives them through Appium's Mac2 4.4.0 (XCTest; locators via
  accessibility ids, predicates and class chains) and NovaWindows 1.4.5 (UI Automation; AutomationId, Name, XPath
  over control types) drivers, installed by `appium:install` on the matching system. New step `ui.menu`
  (`File > Save`); `ui.press` takes shortcuts (`Meta+S`, `Control+Shift+N`) as W3C key actions; `ui.handleDialog`
  presses a dialog's button; `ui.appState` launches and closes the app. macOS screens are recorded with XCTest's
  recorder. `doctor native --platform macos|windows` (Xcode, Automation Mode, PowerShell, drivers). Demo apps in
  `demo/macos-app` (Swift/AppKit, `scripts/build-macos-demo.ts`) and `demo/windows-app` (C#/WinForms, `dotnet
  build`). CI jobs on macOS and Windows runners. See [docs/NATIVE_DESKTOP_APPS.md](docs/NATIVE_DESKTOP_APPS.md).
- **Phone gestures, recording and diagnosis** (Android and iOS): new steps `ui.swipe` (direction, or drag onto a
  `target`), `ui.longPress`, `ui.scrollTo`, `ui.back` (also the browser's Back button), `ui.hideKeyboard`,
  `ui.rotate`, `ui.appState` (launch, close, background, reset), `ui.deepLink`, `ui.setLocation`, `ui.permission`
  and `ui.pushNotification` (iOS simulators); `ui.handleDialog` answers the dialog on a phone's screen (also system
  permission dialogs, optionally by `buttonLabel`). The recorder records phone apps: the dashboard shows the screen
  (`GET /api/recorder/screen`), and taps, long presses, typing (passwords become secrets), swipes, back, hide
  keyboard and checks (`POST /api/recorder/act`) become steps with ranked locators from the element tree, each
  checked against the app. Diagnosis rules for phone apps (`rules/native.yaml`): the app crashed, the app was no
  longer on screen, a dialog covered the app, the element is below the screen, the keyboard covers it, the app did
  not start. Campaigns run desktop and phone apps once per environment (one per device). An environment that resets
  the app now installs the given app file every time (`enforceAppInstall`). The demo apps have a long-press to
  remove a patient, a `careclinic://patients` link, a scrolling footer and a Remind me dialog.
- **iOS apps**: a new platform, _iOS app_ (macOS with Xcode). An iOS app's environment names the app (.app or .zip
  for simulators, .ipa for iPhones, or an installed bundle id), the simulator (by name; empty = the first iPhone
  simulator) or iPhone, the iOS version, resetting the app, showing the simulator, and extra Appium capabilities.
  The native executor now serves Android and iOS through one session with a per-platform adapter (locators: accessibility
  identifier, label, placeholder value, label/value text, XCUIElementType roles via iOS predicates, XPath). On a Mac,
  `appium:install` also installs the XCUITest driver 12.18.1. Simulator screens are recorded with
  `xcrun simctl io recordVideo`; the system log is the console. `stepforge doctor native [--platform android|ios]`
  and `/api/native/status` report Android and iOS separately (Xcode, command-line tools, simulators). Demo app
  CareClinic mobile for iOS in `demo/ios-app` (Swift/UIKit, built by `scripts/build-ios-demo.ts` without an Xcode
  project). New CI job on a macOS runner. See [docs/IOS_APPS.md](docs/IOS_APPS.md).
- **Android apps**: a new platform, _Android app_ (no migration needed). An Android app's environment names the app
  (an .apk, or an installed package and activity), the emulator (started when needed) or phone, whether to reset
  the app's data before each test (on by default), whether to show the emulator window, and extra Appium
  capabilities. A new package, `@stepforge/executor-native`, runs the `ui.*` steps through a local Appium 3 server
  with the UiAutomator2 driver. It talks plain WebDriver, with no client library. Appium and the driver go into
  `data/tools` (`npm run appium:install` or **Install Appium** on the Environments tab), with a portable Node.js 22
  LTS when the running Node.js is outside Appium's range. Locators map to resource ids, content descriptions, hints,
  text, widget classes and XPath. Evidence: screenshots, an MP4 screen recording, the device log (crashes marked as
  errors) and the element tree (XML) at failures. `stepforge doctor native` and `GET /api/native/status` check
  Java, the SDK, adb, the emulator, devices and Appium, with fixes. Demo app CareClinic mobile in
  `demo/android-app` (built APK committed; `scripts/build-android-demo.ts` rebuilds it without Gradle). New CI job
  on an Android emulator. See [docs/ANDROID_APPS.md](docs/ANDROID_APPS.md).
- **Electron desktop apps**: applications have a platform, _web_ or _desktop app (Electron)_ (migration 0014). A
  desktop app's environment says how to start it: the packaged executable or the project folder (started with the
  Electron installed there), arguments, the app's environment variables and a working folder; variables and secrets
  work in each. Tests run in the app's windows (`ui.switchTab` reaches new windows), with video, traces, console,
  network and diagnosis; the recorder and manual runs (with the panel and session video) open the app too. Exports
  warn that UI tests of a desktop app open a browser. Demo app in `demo/desktop-app`. See
  [docs/DESKTOP_APPS.md](docs/DESKTOP_APPS.md).
- **Manual testing in the browser**: tests are **Automated** or **Manual** (Details → *How it is tested*; migration
  0013). Automated runs, schedules, campaigns and the CLI leave manual tests out; the Test Explorer shows them as
  *manual · pending* until they are run. **Run manually** (any test) opens the application in a browser with a
  StepForge panel — current step, expected result, next step, pass / fail / blocked / skip, notes, screenshots
  without the panel, screen-recording clips, jump to a step, finish — and records the whole session as the test's
  video. The run page follows live; screenshots can be marked up (boxes, circles, arrows, pen, text, eight colours)
  and failed steps turned into bug reports (expected vs actual, severity, steps to reproduce, screenshots). See
  [docs/MANUAL_RUNS.md](docs/MANUAL_RUNS.md).
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
- The plain-English description of `ui.handleDialog` reads "Accept the next dialog" (or "Press "Clear" in the dialog")
  instead of "… browser dialog", since phone and desktop apps use it too.
- StepForge's Linux helper accepts capabilities in `firstMatch` and answers `timeouts` and `window`, for WebDriver
  clients other than StepForge's own.
- **Node.js 22 or newer is now required** (was 20). Node 20 reached end of life in April 2026, better-sqlite3 no
  longer publishes Node 20 binaries (so installing on Windows needed a C++ build), and the SQL Server driver's Azure
  packages need Node 22. CI and the CI files of exported projects use Node 22.
- Record from the Test Explorer: the New scenario dialog has **Create & record**, a scenario's Steps tab has
  **Record steps** (the recorded steps are added after the existing ones, reviewed first), and a module's menu and
  empty modules offer **Record a scenario**. The Recorder shows where the recording will go; the sidebar Recorder
  works as before.

### Fixed
- A full review of this release fixed, among others: SQL data sources now refuse writes and extra statements on every
  database; CSV sources only read `.csv`/`.tsv`/`.txt` files; webhook header values are stored encrypted; errors
  never show webhook URLs or tokens; block inputs no longer leak into the caller's variables and their defaults are
  resolved; a deleted saved element no longer breaks a step that has other locators; environment deletion keeps
  campaigns working and importable; campaign launches are checked before they start; manual tests keep their
  results when the scenario changes mid-run, never open two browsers, and merge results per step; mock routes per
  method, globs starting with `/`, visual-checkpoint number checks, third-party detection for short domains, the
  "back online" step, and Kafka waits on topics that do not exist yet. Exported Cypress projects log page errors
  instead of failing on them. Visual baselines now live per application (existing ones are re-created on the next
  run).
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
