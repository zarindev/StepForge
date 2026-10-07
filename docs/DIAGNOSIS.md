# Failure diagnosis and bug reports

_By Md Zarin Tasnim · part of the StepForge documentation_

When a test fails, StepForge works out **where** it failed, **why** (most likely), **whose issue** it is and **how
to fix it** — with rules, not guesswork, and free: no AI service is needed. It then files a bug report with the steps
to reproduce and the evidence, or counts another occurrence of an existing one.

## What the diagnosis looks at

- the failed step, its error and its assertions (expected vs actual, numeric difference);
- API requests and responses (status, body, JSON-schema and OpenAPI contract errors);
- database results (rows, counts, constraint errors), emails, performance reports;
- the browser's console (JavaScript exceptions with their location, CORS errors) and network log (failed and slow
  requests, DNS/connection failures). JavaScript errors only count when they happened on the page the step failed
  on, so an error on an earlier page doesn't take the blame;
- the page at the moment of failure: whether the element exists, is hidden or is covered by another element (the
  covering element is named), and which elements now look like the one the step wanted (for a changed locator);
- the same test's **last passing run** ("last-green diff"): what changed in the step's result, HTTP status, response
  field types, row counts, duration, locator healing, browser and base URL;
- the test's recent history (passed/failed pattern for flakiness).

## Owners

| Owner | Meaning |
|---|---|
| Application bug | The application behaves wrongly (wrong status, missing check, crash, bad data). |
| Test needs updating | The scenario is out of date or misconfigured (locator changed, wrong SQL, missing variable). |
| Environment problem | Something around the app is wrong (server down, DNS, CORS, rate limit, unavailable service). |
| Test data problem | The data the test relies on is missing or collides (404s, 409 conflicts, constraints, empty results). |

## Categories covered

Locator changed (with a suggested locator and one-click accept), element covered or hidden, navigation timeout,
slow API (behind a timeout, or a failed response-time check), HTTP 400/401/403/404/409/422/429/500/502/503/504, missing authentication check, missing
validation (duplicate or invalid input accepted), wrong status for missing records, CORS, network offline/DNS,
JSON-schema and contract mismatch (field by field), assertion mismatch (with the value difference), database
unreachable, constraint violation, empty result, data-integrity mismatch, data-quality audit failures, email not
received, inbox unreachable, OTP not found, missing email link, JavaScript exception (with source location), flaky
timing, performance threshold exceeded (and regression against the last passing run), missing index (full table
scan), test-data collision, test configuration errors, and a catch-all.

## Locator changed: one-click fix

When no element matches the step's locators, StepForge looks for elements whose test id, accessible name, label or
text resemble the old ones, keeps only suggestions that match exactly one element, and offers
**Use testId=…** in the diagnosis. Accepting puts the suggestion first and keeps the old locators as fallbacks (a new
scenario version is recorded). The failure screenshot outlines the failing element in red when it exists.

## Writing your own rules

Rules live in YAML: the built-in ones in `packages/diagnosis/rules/`, yours in **`data/rules/*.yaml`** (a rule with
the same `id` as a built-in one replaces it). Each rule:

```yaml
- id: api-payment-declined          # lower-case words joined by dashes
  category: payment_declined
  priority: 85                      # higher wins; ties go to the higher confidence
  confidence: 0.8                   # 0–1
  owner: app                        # app | test | environment | data
  when:                             # every condition must hold
    layer: api
    status: 402
    request.url: { contains: /checkout }
  title: 'The payment provider declined the test card ({{status}})'
  explanation: '{{request.method}} {{request.url}} answered {{status}}{{responseMessage}}.'
  fix: 'Use the provider''s test card numbers for this environment.'
  evidence: { Request: '{{request.method}} {{request.url}}' }
```

**Conditions:** a value means *equals*; a list means *one of*; or an object with `equals`, `in`, `notIn`, `exists`,
`matches` (regular expression, case-insensitive), `contains`, `gt`, `gte`, `lt`, `lte`, `not`. Combine with
`any: [ … ]` (at least one) and `all: [ … ]`.

**Facts you can use** (in conditions and as `{{fact}}` in texts): `layer`, `stepType`, `stepLabel`, `errorKind`,
`message`, `itemStatus`, `assertion.target/operator/expected/actual/message`, `delta`, `deltaText`;
API: `status`, `statusText`, `expectedStatus`, `request.method`, `request.url`, `responseMessage`, `responseTimeMs`,
`schemaErrorList`, `schemaErrorCount`; browser: `locator`, `matchCount`, `visible`, `candidate`, `candidateCount`,
`pageError.text`, `pageError.location`, `corsError`, `failedRequest.method/url/status`, `slowRequest.url/durationMs`,
`slowRatio`, `networkFailure`, `timeoutMs`; database: `rowCount`, `connection`, `sql`; performance: `perfMetric`,
`perfBaselineP95`; history: `lastGreen.at`, `lastGreenDurationMs`, `durationRatio`, `flakyHistory`,
`passedRecently`, `failedRecently`.

Invalid rules are reported with the file and rule name; a rule that fails while matching is skipped, so a mistake
never breaks diagnosis. **Re-diagnose** in the run results applies the current rules to an old failure.

## Bug reports

Every failed or broken test files a bug, deduplicated by *scenario + failing step + category*: repeats increase the
occurrence count, a bug marked *fixed* that fails again is reopened, *won't fix* and *duplicate* keep their status.
Fields: Bug ID (BUG-001…), title, summary, application, module, scenario and test case, environment (URL, browser
and version, viewport, OS, date), severity (from the scenario priority and the category, editable), priority,
preconditions, **steps to reproduce in plain English with the test data filled in** (secrets shown as ••••, the
failing step marked), expected, actual, diagnosis, evidence (screenshot, request/response, plus video, trace and logs in
the run) and status.

## Exports

| What | Formats |
|---|---|
| One bug | PDF, HTML, Markdown (GitHub issue), copy as Markdown |
| Bug list | PDF (summary table + every bug), Excel, Jira CSV, Trello CSV, Markdown |
| Run report | Self-contained HTML (screenshots embedded, works offline), PDF, Excel (summary, tests, steps) |

PDFs are printed by Playwright's Chromium, offline. Every document says **"Prepared by …"** (Settings → Reports;
default *Md Zarin Tasnim*) and carries the **"StepForge by Md Zarin Tasnim"** credit; Excel files also record the
author in their properties and an *About* sheet. CSV cells starting with `=`, `+`, `-` or `@` are escaped so
spreadsheets do not run them.

## Optional: "Explain in plain English"

If [Ollama](https://ollama.com) runs on this computer (default `http://localhost:11434`, model `llama3.1`,
Settings → Local AI), failed tests show an **Explain in plain English** button that rewrites the diagnosis for
non-technical readers. Only the diagnosis (secrets already masked) is sent, and only to a localhost address. Without
Ollama the button is hidden; everything else works the same.
