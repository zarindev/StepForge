# Performance testing

_By Md Zarin Tasnim · part of the StepForge documentation_

Four kinds of measurement, all free and local:

| | What | Where |
|---|---|---|
| **Page metrics** | Web Vitals (LCP, CLS, INP, FCP, TTFB) and load time of the page the test's browser is on | `perf.pageMetrics` step; Run dialog option for every navigation |
| **Lighthouse** | Performance, accessibility, best-practices and SEO scores with the full report | Performance → Lighthouse; `perf.lighthouse` step |
| **Load tests** | Requests per second, p50/p90/p95/p99 latency, error rate under many virtual users | Performance → Load Designer; `perf.loadTest` step |
| **Query plans** | How long a query takes and whether it reads whole tables | `perf.queryPlan` step |

## Only test what you own

Load tests send many requests quickly. Running them against systems you do not own or are not authorized to test
can be illegal and can harm others. StepForge enforces this:

- Each application needs a one-time confirmation, *"I own or am authorized to load-test this system"*, stored with
  its date (Performance page). Without it, load tests refuse to start — from the designer and in runs.
- A **production** environment additionally needs the application's name typed (designer) or set as
  `confirmProduction` (step).
- Limits: at most 1000 virtual users and one hour per test. Your own computer is the real limit: one machine
  cannot simulate internet-scale traffic, and a busy laptop measures itself as much as the server.

## Load Designer

Pick the environment, then either one **endpoint** (method, URL relative to the environment, optional bearer token
such as `{{secret.apiToken}}`, headers, JSON body) or an **API scenario** whose `api.request` steps each virtual user
repeats in order. Secrets are resolved on the server and never shown.

| Profile | Shape |
|---|---|
| smoke | 1 user for up to 30 s — does it work under a load tool at all? |
| load | optional ramp-up, then the target users for the duration |
| stress | ½×, 1×, 1.5×, 2× the target users, a quarter of the time each |
| spike | 10 % of the users, a sudden jump to all of them, back to 10 % |
| soak | the target users for a long time (leaks, slow degradation) |

Thresholds: p95 / p99 latency below N ms, error rate below N % (HTTP ≥ 400, timeouts and connection errors count
as errors), at least N requests per second. Empty means not checked. The run streams a live chart (requests per
second and p95 per second); the report shows the verdict per threshold with the margin, the latency percentiles,
the status codes and the timeline. **Save as test** turns the design into a `perf.loadTest` step, so it runs in
suites, schedules and CI with its thresholds deciding pass or fail.

The built-in engine uses [autocannon](https://github.com/mcollina/autocannon); latency percentiles are exact
(0.01 ms resolution below 1 ms, 1 ms above).

## k6

k6 is optional.

- **Export k6 script** (always available) writes a standalone script with the same stages and thresholds.
  Placeholders become environment variables: `{{env.baseUrl}}` → `BASE_URL` (defaulting to the environment's URL),
  `{{secret.apiToken}}` → `SECRET_API_TOKEN`. Secrets are never written into the script. Run it with
  `k6 run -e SECRET_API_TOKEN=… script.js`.
- **Run with k6:** if k6 is found (Settings → Performance: install it, give its path, or have it on the PATH), the
  engine selector offers it. StepForge runs k6 with the requests passed through an environment variable (nothing
  secret on disk) and converts k6's summary into the same report. k6 reports no per-second timeline.

`npm run k6:install` downloads the pinned k6 release (AGPL-3.0, run as a separate program) into `data/bin/`.

## Lighthouse

Lighthouse 12 runs in its own headless Chromium (Playwright's, so nothing extra to install) against a URL of the
environment. It loads the page fresh, without the test's cookies, so use it for public pages; for pages behind a
login use `perf.pageMetrics` in a scenario after the login steps. Scores ≥ 90 are green, ≥ 50 amber. The HTML report
opens from the results.

## Page metrics

StepForge loads Google's `web-vitals` library into every test page (inside a closure; the page only gains a hidden
`__stepforgeVitals` store). `perf.pageMetrics` reads LCP, CLS, INP, FCP, TTFB and the navigation timing of the
current page. INP only exists after an interaction. Google's "good" limits: LCP ≤ 2500 ms, CLS ≤ 0.1,
INP ≤ 200 ms, FCP ≤ 1800 ms, TTFB ≤ 800 ms.

## Query plans

`perf.queryPlan` runs a read query a few times (median time) and asks the database for its plan: SQLite
`EXPLAIN QUERY PLAN`, PostgreSQL `EXPLAIN (FORMAT JSON)`, MySQL `EXPLAIN` — never `EXPLAIN ANALYZE`. Full table
scans (`SCAN orders`, `Seq Scan`, `type ALL`) are listed; `noFullScan: true` makes them fail the step. SQL Server and
MongoDB get the timing without a plan.
