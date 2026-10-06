# Analytics and quality gates

_By Md Zarin Tasnim · part of the StepForge documentation_

Every finished run updates StepForge's analytics: nothing to configure, no external service. Long ranges read
pre-aggregated daily rows (`analytics_daily`), so the dashboard stays fast as history grows.

## Home

- **KPIs:** applications, scenarios, test cases, runs this week, pass rate and flaky rate (last 7 days), open bugs,
  average run duration.
- **Pass/fail trend:** results per day for the last 30 days (passed, flaky, failed).
- **Quality gates:** the status of every application (green, amber, red, or "no data"), with the rules that are not
  met.
- **Recent runs**, and upcoming schedules (scheduling comes with its own phase).

A fresh workspace shows the welcome panel until the first run finishes.

## Application analytics

Application → **Analytics** (or click an application in the Home gates). Choose the period (7, 30, 90 or 365 days)
and an environment.

| Section | What it shows |
|---|---|
| Totals | runs, test results, pass rate, failures, flaky results |
| By module / layer / tag / environment | pass rate and passed/flaky/failed bars per group (layer = UI, API, DB, email, perf, hybrid) |
| Top failing tests | failures out of runs, the latest diagnosis and its category; click to open **that failing test in its run** (with the diagnosis and evidence) |
| Failure categories | how failures were diagnosed (server error, locator changed, missing auth…) |
| Flaky tests | score, recent results as dots; click to open the latest result |
| Slowest tests | average and maximum duration |
| Performance trends | API response time per day (average and p95), page LCP, load test results |
| Calendar | daily pass rate for the last 12 months |

### Flaky detection

A test is flaky when it **passed only on retry**, or when its result **flips between pass and fail across runs of the
same scenario version** (at least 3 runs and 2 flips). Changing the scenario resets the comparison: a test that
failed and then passed after you edited it is not flaky. The score is the share of flips (or of retry passes).

## Quality gates

A gate is a set of rules evaluated on the application's **latest completed run**, its **open bugs** and the **last
7 days** (flakiness). Each rule either **blocks** (the gate turns red) or **warns** (amber). A rule without data
(e.g. no load test in the latest run) is shown with "?" and makes the gate amber. Without any completed run the
gate shows "no data" — unless a blocking rule already fails (e.g. an open critical bug).

| Rule | Example |
|---|---|
| Pass rate (all tests, a priority, or a tag) | P1 tests ≥ 100%; tests tagged "smoke" ≥ 100% |
| Open bugs at a severity or worse | open critical bugs ≤ 0 |
| Flaky rate (7 days) | ≤ 5% |
| API p95 | < 800 ms (from API steps of the latest run) |
| Load test p95 | < 800 ms (worst load test in the latest run) |
| Page LCP (p75) | < 2500 ms (from page metrics in the latest run) |
| Run duration | ≤ 30 min |

**Release readiness** is offered as a starting gate: P1 tests 100%, all tests ≥ 95% (warning), no open critical bugs,
API p95 < 800 ms (warning). Each run stores the verdict of the gates at the time it finished.

## Run comparison

Runs → **Compare**: pick a "before" and an "after" run (default: the two latest). StepForge lists tests that were
**fixed**, **new failures** (including newly added tests that fail), tests **still failing**, how many still pass,
added and removed tests, and **performance changes** of the same metric of the same test (average before → after,
percentage change).
