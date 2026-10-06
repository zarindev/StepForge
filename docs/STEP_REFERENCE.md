# Step Reference

Every step shares the same shape (see [ARCHITECTURE.md](ARCHITECTURE.md#step-model)):
`type`, `label`, `params`, `locators`, `assertions`, `enabled`, `continueOnFail`, `timeoutMs`, `retries`, `captureAs`.

Values in `params`, locator values and assertion `expected` values may use variables:
`{{env.baseUrl}}`, `{{env.<variable>}}`, `{{secret.<key>}}`, `{{data.<field>}}`, `{{vars.<name>}}`, `{{run.id}}`,
`{{random.email|uuid|number|digits6|string|timestamp}}`. A value that is exactly one placeholder keeps its type.

**Status rules.** An assertion mismatch, a missing element or a timeout makes the test `failed` (a product
problem). Configuration problems (unknown variable, unsupported step, invalid params, script error) make it
`broken`. `continueOnFail` records the failure and keeps going; the test still fails at the end (soft
assertion). `retries` re-runs only that step; run-level retries re-run the whole test and mark it `flaky` if
a later attempt passes.

## Locators (UI steps)

`locators` is a ranked list. StepForge waits for any of them, then uses the best-ranked one that matches.
If the first one fails but a later one matches, the step passes and is marked **healed** in the results.

| strategy | value | example |
|---|---|---|
| `testId` | `data-testid` / `data-test` / `data-cy` / `data-qa` | `{"strategy":"testId","value":"save-patient"}` |
| `role` | ARIA role, plus `name` (accessible name, exact) | `{"strategy":"role","value":"button","name":"Sign in"}` |
| `label` | label text (exact) | `{"strategy":"label","value":"Email"}` |
| `placeholder` | placeholder text (exact) | `{"strategy":"placeholder","value":"Search"}` |
| `text` | visible text (exact) | `{"strategy":"text","value":"Delete record"}` |
| `css` | CSS selector | `{"strategy":"css","value":"#msg"}` |
| `xpath` | XPath (last resort) | `{"strategy":"xpath","value":"//table//tr[2]"}` |

## UI steps (`ui.*`) — available since Phase 3

| type | params | notes |
|---|---|---|
| `navigate` | `url` (absolute or relative to the environment base URL), `waitUntil` (`load`/`domcontentloaded`/`networkidle`) | assertion targets: `status`, `url`, `title` |
| `click` / `dblclick` / `rightclick` / `hover` | `force`, `button` | |
| `fill` | `value` | replaces the content |
| `type` | `value`, `delay` (ms per key) | types key by key |
| `clear` | — | |
| `press` | `key` (e.g. `Enter`, `Control+A`) | on the locator, or the page when no locator |
| `select` | `value` or `label` or `index` | output: selected value |
| `check` / `uncheck` | — | |
| `upload` | `files` (array of paths) or `file` | |
| `dragDrop` | `target` (a locator list) | |
| `scroll` | `x`, `y` (page wheel) | with a locator: scrolls it into view |
| `switchTab` | `index` or `urlContains` | without params: newest tab |
| `closeTab` | — | switches to the remaining newest tab |
| `handleDialog` | `action` (`accept`/`dismiss`), `promptText` | put it **before** the step that opens the dialog; other dialogs are dismissed |
| `switchFrame` | `selector` (iframe CSS) or `main: true` | |
| `waitFor` | with locator: `state` (`visible`/`hidden`/`attached`/`detached`); else `url` (glob) or `loadState` | prefer this over `util.wait` |
| `screenshot` | `fullPage` | with a locator: element screenshot; kept as evidence |
| `extract` | `from` (`text`/`value`/`attribute`/`count`/`url`/`title`), `attribute`, `regex` (group 1) | use `captureAs` to store it |
| `assert` | `check`, `expected`, `attribute` | polls until true or timeout; see below |
| `visualCheckpoint` | — | not available yet (reported as unsupported) |

`ui.assert` checks: `visible`, `hidden`, `text`, `textContains`, `textMatches` (regex), `value`, `count`,
`attribute` (+ `attribute` name), `enabled`, `disabled`, `checked`, `unchecked`, `url`, `urlContains`,
`urlMatches`, `title`, `titleContains`.

Generic `assertions` on any UI step can target `url`, `title`, and for steps with a locator: `text`, `value`,
`visible`, `enabled`, `checked`, `count`, `attr:<name>`. Operators: `equals`, `notEquals`, `contains`,
`notContains`, `matches`, `lt`, `lte`, `gt`, `gte`, `exists`, `notExists`, `isEmpty`, `isNotEmpty`, `lengthEquals`.

## Utility steps (`util.*`)

| type | params | notes |
|---|---|---|
| `setVariable` | `name`, `value` | |
| `generateData` | `kind` (`name`, `firstName`, `lastName`, `email`, `phone`, `date`, `birthdate`, `number`, `uuid`, `word`, `sentence`, `address`, `company`, `pattern`), `pattern` (`#` digit, `?` letter, `*` either), `min`/`max`, `direction` (`past`/`future`), `name` (store as var) | generated emails use the reserved `example.test` domain |
| `wait` | `ms` | logged as a warning: prefer `ui.waitFor` |
| `log` | `message` | |
| `runScript` | `code` (JavaScript; `return` a value) | sees copies of `vars` and may set `vars.x`; no `require`, `process`, `eval`, files or network; 5 s max |
| `if` | `condition: { value, operator, expected }`, `steps` (then), `else` | any assertion operator; nested results numbered `3.1` (then) / `3e.1` (else) |
| `loop` | `count` **or** `over` (an array, e.g. `{{vars.items}}`), `as` (default `item`), `steps` | exposes `{{vars.item}}` and `{{vars.index}}`; max 1000 iterations; results `4[2].1` |
| `callScenario` | `scenarioId` | runs another scenario of the same application inline; max nesting depth 5 |
| `useBlock` | `blockId` | runs a reusable block (application → Blocks tab) |

## API steps (`api.*`) — available since Phase 5

| type | params | notes |
|---|---|---|
| `request` | `method`, `url` (absolute or relative to the environment base URL), `headers`, `query`, `body`, `bodyType` (`json`/`form`/`multipart`/`raw`/`none`), `auth`, `followRedirects`, `cookies` (default true), `contract` (`true` or `{ "specId": "…" }`) | output = response body (use `captureAs`) |
| `graphql` | `url`, `query`, `variables`, `operationName`, `headers`, `auth`, `allowErrors` | GraphQL `errors` fail the step unless `allowErrors` |
| `extract` | `from` (`body`/`header`/`status`), `path` (JSONPath), `name` (header) | reads the previous API response of the same test |

`auth` examples: `{"type":"bearer","token":"{{secret.apiToken}}"}`, `{"type":"basic","username":"ana","password":"{{secret.pw}}"}`,
`{"type":"apiKey","in":"header","name":"x-api-key","value":"{{secret.key}}"}`,
`{"type":"oauth2","tokenUrl":"…","clientId":"…","clientSecret":"{{secret.cs}}","scope":"read"}`, `{"type":"cookie","name":"sid","value":"…"}`.
Multipart file fields: `{"doc": {"file": "/path/to/file.pdf"}}`. Cookies set by responses are sent back automatically within a test.

Assertion targets: `status`, `time` (ms), `size` (bytes), `header:<name>`, `body`, `text`, and JSONPath (`$.data.id`,
`$.items[*].name` returns a list). `matchesSchema` takes a JSON Schema as `expected` and reports field-level errors.

## Database steps (`db.*`) — available since Phase 6

Steps name a **connection** (configured per environment on the application's *Databases* tab). A run uses the
connection with that name in the run's environment, so `main` can point at a local SQLite file in *Local* and at
PostgreSQL in *Staging*. Engines: SQLite, PostgreSQL, MySQL/MariaDB, SQL Server, MongoDB. See
[DATABASES.md](DATABASES.md) for connection setup and the safety rules.

| type | params | notes |
|---|---|---|
| `query` | `connection`, `sql`, `params` (array), `maxRows` (default 1000), `confirmProduction` | One statement. On MongoDB, `sql` is a JSON command (below). output = rows |
| `mongoFind` | `connection`, `collection`, `filter`, `projection`, `sort`, `limit` | MongoDB only. output = documents |
| `runScript` | `connection`, `script`, `confirmProduction` | Several statements separated by `;` (strings, comments and `$$…$$` bodies are respected). Reports the last result |
| `callProcedure` | `connection`, `procedure`, `args` (array), `confirmProduction` | PostgreSQL `CALL`, MySQL `CALL`, SQL Server `EXEC`. Always treated as a write |
| `extract` | `path` | Reads the previous DB result of the same test (targets below) |
| `dataQualityCheck` | `connection`, `tables` (array or comma list; empty = all), `checks` (`orphans`, `duplicates`, `nulls`, `formats`, `negatives`; empty = all), `duplicateColumns`, `requiredColumns`, `inferRelationships` (default true), `maxIssues` (default 0) | Fails when more than `maxIssues` issues are found; one assertion line per finding. output = the audit report |

**Parameters, not string building.** Placeholders: `?` (SQLite, MySQL), `$1` (PostgreSQL), `@p1` (SQL Server).
`"params": ["{{data.email}}"]` binds safely; writing `'{{data.email}}'` inside the SQL text inlines the value as-is.
Secrets used as parameters are masked as `••••` in stored results.

**Assertion targets** on a result: `rowCount`, `affected` (rows changed by a write), `value` (first column of the
first row — handy for `SELECT COUNT(*)`), a bare column name (that column in the first row), `rows[1].email`,
`column:email` (every value of the column), JSONPath over the rows (`$[0].id`, `$[*].total`), `rows`, `columns`, `time`.
Column-style operators: `noNulls`, `unique`, `inRange` (`expected`: `{"min":0,"max":100}`, `[0,100]` or `"0..100"`).
"Equals a variable": `{"target":"value","operator":"equals","expected":"{{vars.count}}"}`.

**MongoDB commands** (Extended JSON): `{"collection":"patients","find":{"email":"a@b.test"},"sort":{"_id":-1},"limit":5}`,
`{"collection":"orders","aggregate":[{"$match":{…}},{"$group":{…}}]}`, `{"collection":"x","countDocuments":{…}}`,
`{"collection":"x","distinct":"field","filter":{…}}`, and writes `insertOne`, `insertMany`,
`updateOne`/`updateMany` (`{"filter":…,"update":…}`), `deleteOne`/`deleteMany` (`{"filter":…}`).

**Outcomes.** A blocked write, a missing connection, SQL syntax errors and unknown tables/columns make the test
`broken` (the test needs fixing). Constraint violations and failed assertions make it `failed` (the data or app is
wrong). A connection that cannot be reached is a `failed` network error.

## Email steps (`email.*`) — available since Phase 7

Email steps read an **inbox**: StepForge's local Mailpit (Settings → Email) or an inbox configured on the
application's *Inboxes* tab (Mailpit or IMAP). See [EMAIL.md](EMAIL.md).

| type | params | notes |
|---|---|---|
| `waitForEmail` | `to`, `from`, `subject`, `contains` (body), `timeoutMs`, `inbox` (name; empty = first inbox or local Mailpit), `since` (`testStart` default / `any`), `pollMs` | Text matches are case-insensitive "contains". Only emails received after the test started count. `timeoutMs` is also the step timeout. output = `{ id, from, to, subject, date, text, links, attachments }` |
| `assertEmail` | `subjectContains`, `bodyContains`, `from`, `hasLink` (`true` or text the link contains), `hasAttachment` (`true` or part of the file name) | Checks the email from the last `waitForEmail`; one assertion line per check |
| `extractFromEmail` | `kind`: `otp` (default; `minLength` 4, `maxLength` 8), `link` (`contains`, `index`), `regex` (`pattern`, `flags`; first capture group is kept) | Use `captureAs` (e.g. `otp`) and type `{{vars.otp}}` later |
| `openEmailLink` | `contains`, `index`, or `url` | Opens the link in the test's browser when a UI step already opened one (following UI steps continue there); otherwise requests it over HTTP. Targets: `status`, `url`, `text` (HTTP only) |

**OTP extraction** finds 4–8 digit codes (`482913`, `551 204`, `551-204`), preferring numbers near words like
*code, OTP, one-time, passcode, PIN, verification, security, login*. Dates, times, prices, phone numbers and order
numbers (`#20261005`) are skipped. If an email has several unlabelled numbers it refuses to guess — use `regex`.

**Assertion targets** on an email: `subject`, `from`, `fromName`, `to`, `cc`, `text`/`body`, `html`, `links`,
`linkCount`, `attachments` (file names), `attachmentCount`, `date`, and `waitMs` on `waitForEmail`.

**Unique addresses per run:** `{"type":"util.setVariable","params":{"name":"email","value":"qa+{{run.id}}@example.test"}}`,
then use `{{vars.email}}` in the sign-up form and in `waitForEmail.to`. With Gmail, plus-addressing
(`you+{{run.id}}@gmail.com`) delivers to your normal inbox.

**Outcomes:** an email that does not arrive is a `failed` timeout ("No email to … arrived within 20 s after the test
started"); a missing code or link is `failed`; an unknown inbox or an email step without an earlier `waitForEmail`
is `broken`; an unreachable inbox is a `failed` network error.

## Performance steps (`perf.*`) — available since Phase 8

See [PERFORMANCE.md](PERFORMANCE.md) for the Load Designer, profiles, k6 and the safety rules.

| type | params | notes |
|---|---|---|
| `pageMetrics` | `url` (optional: open it first), `thresholds`: `lcpMs`, `cls`, `inpMs`, `fcpMs`, `ttfbMs`, `loadMs`; `settleMs` | Measures the test's browser page (needs an earlier UI step). Targets: `lcp`, `cls`, `inp`, `fcp`, `ttfb`, `load`, `domContentLoaded`, `transferBytes`, `requests` |
| `lighthouse` | `url`, `formFactor` (`desktop`/`mobile`), `categories`, `thresholds`: `performance`, `accessibility`, `bestPractices`, `seo` (minimum 0–100) | Fresh browser, no login. HTML report saved as evidence. Targets: category ids and `lcp`, `fcp`, `cls`, `tbt`, `speedIndex` |
| `loadTest` | `method`, `url`, `headers`, `body`, `auth` (bearer/basic/apiKey) **or** `requests: [...]`; `profile` (`smoke`/`load`/`stress`/`spike`/`soak`), `vus`, `durationS`, `rampS`, `thresholds`: `p95Ms`, `p99Ms`, `avgMs`, `maxErrorRatePct`, `minRps`; `engine` (`builtin`/`k6`), `requestTimeoutS`, `confirmProduction` | Needs the application's load-test authorization. Fails with the margin (e.g. "p95 latency 912 ms exceeded the threshold of 800 ms by 112 ms"). Targets: `rps`, `p50`, `p90`, `p95`, `p99`, `avg`, `max`, `errorRate`, `requests` |
| `queryPlan` | `connection`, `sql` (a read), `params`, `maxMs`, `noFullScan`, `repeat` (default 3) | Median time of `repeat` runs and the engine's plan (SQLite, PostgreSQL, MySQL) without running EXPLAIN ANALYZE. Targets: `durationMs`, `fullScans`, `rowCount` |

**Page metrics on every navigation:** tick *Collect page metrics (Web Vitals)* in the Run dialog (run option
`pageMetrics`) and every `ui.navigate` records LCP, CLS, TTFB, FCP and load time (no thresholds) for analytics.

All metrics are stored per step (`perf_metrics`), load tests also in `load_results`, for trends in Phase 10.
