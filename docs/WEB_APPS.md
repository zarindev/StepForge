# Testing every kind of web app

_By Md Zarin Tasnim · part of the StepForge documentation_

StepForge drives a real browser (Chromium, Firefox or WebKit through Playwright, or the Google Chrome / Microsoft
Edge installed on your computer), so anything a user can do in a browser, a test can do. This page lists the kinds
of web applications people test and the StepForge features each one needs. Everything here runs locally and is free.

## At a glance

| Kind of web app | What it needs | In StepForge |
|---|---|---|
| Classic multi-page sites (PHP, Rails, Django, ASP.NET) | Navigation, forms, links | `ui.navigate`, `ui.fill`, `ui.click`, `ui.select`, `ui.check`, `ui.upload` |
| Single-page apps (React, Vue, Angular, Svelte) | Waiting for content that loads after the page, client-side routes | Auto-waiting on every action and check, `ui.waitFor` (element, URL glob, load state), `ui.waitForResponse` |
| Server-rendered / hybrid (Next.js, Nuxt, Remix) | Hydration, redirects | `ui.waitFor` with `loadState`, URL checks (`url`, `urlContains`, `urlMatches`) |
| Apps with an API behind them | Checking what the page asked the server, faking server errors | `ui.waitForResponse` (status, body, JSONPath), `ui.mockRoute` (answer, fail, slow down); API steps in the same test |
| Progressive web apps / offline-first | Offline mode, service workers | `ui.setOffline`; environment setting **Service workers: blocked** when caches get in the way |
| Responsive and mobile web | Phone and tablet sizes, touch | Run size **Mobile** / **Tablet**: touch screen, mobile browser identity (Chromium: Pixel 7, WebKit: iPhone 14 / iPad), `ui.tap` |
| Canvas, maps, charts, drawing tools, games | Clicking a point inside an element, comparing pixels | `x` / `y` on `ui.click` and `ui.tap`, `ui.visualCheckpoint` |
| Design-sensitive pages, design systems | Catching visual regressions | `ui.visualCheckpoint`: baseline, difference image, **Accept as new baseline** |
| Reports, exports, invoices | Downloading files and checking them | `ui.download` (file name, size, content checks) |
| Payment forms, embedded widgets | iframes | `ui.switchFrame` (also cross-origin) |
| Sign-in with Google / Microsoft / OAuth popups | New tabs and windows | `ui.switchTab`, `ui.closeTab` |
| Confirm / alert / prompt dialogs | Native dialogs | `ui.handleDialog` |
| Web components / design-system elements | Shadow DOM | Role, label, text, test id and CSS locators reach into open shadow roots automatically |
| Staging sites behind a login prompt | HTTP basic auth | Environment → Browser settings → **Basic auth** (password from a secret) |
| Intranet / enterprise apps | Client certificates (mTLS), proxies, Edge | Environment → Browser settings → **Client certificate**, **Proxy**, **Browser build: Microsoft Edge** |
| Feature-flagged apps, A/B tests | Extra request headers, cookies | Environment → **Extra headers**; `ui.storage` for cookies, localStorage, sessionStorage |
| Multi-language apps | Language, time zone | Environment → **Language** (`de-DE`), **Time zone** (`Europe/Berlin`) |
| Location-based apps (delivery, maps, "near me") | Geolocation and permissions | Environment → **Latitude / Longitude**, **Permissions granted** (`geolocation`) |
| Dark mode | Colour scheme | Environment → **Colour scheme: Dark** |
| Time-dependent apps (bookings, trials, countdowns) | Controlling the clock | `ui.setClock` (fixed time, a running clock from a date, jump forward) |
| Apps that send emails (sign-up, password reset, OTP) | Reading the email | Email steps (local Mailpit or IMAP) — see [EMAIL.md](EMAIL.md) |
| Data-heavy apps | Checking the database behind the page | Database steps — see [DATABASES.md](DATABASES.md) |
| Performance-sensitive apps | Web Vitals, Lighthouse, load | Performance steps — see [PERFORMANCE.md](PERFORMANCE.md) |
| Cross-browser support | Chromium, Firefox, WebKit (Safari's engine), Chrome, Edge | Run dialog browser, environment browser build, [campaigns](CAMPAIGNS.md) across browsers × sizes |

## Environment browser settings

Every environment (application → **Environments** → *Edit* → **Browser settings**) can set how the browser opens the
site. The settings apply to every test run in that environment; empty fields keep the browser's defaults.

| Setting | Example | When you need it |
|---|---|---|
| Browser build | Google Chrome / Microsoft Edge (installed) | The site supports only branded browsers, or you test on the exact browser users have. Chrome or Edge must be installed on this computer; otherwise the bundled Chromium is used. |
| Language | `de-DE` | Localised text, number and date formats (`navigator.language`, `Accept-Language`). |
| Time zone | `Asia/Dhaka` | Dates shown in the user's zone. |
| Colour scheme | Dark | Dark mode (`prefers-color-scheme`). |
| Latitude / Longitude | `23.81` / `90.41` | "Near me", maps, delivery areas. Add `geolocation` to *Permissions granted*. |
| Permissions granted | `geolocation, notifications, clipboard-read` | Features that would otherwise ask for permission. |
| User agent | — | Sites that switch on the browser identity. |
| Basic auth user / password | `qa` / `{{secret.basicPassword}}` | Staging sites behind an HTTP login prompt. |
| Extra headers | `X-Feature-Flags: new-checkout` | Feature flags, bypass headers, tenant headers. |
| Proxy | `http://proxy.local:3128` | Corporate networks. |
| Service workers | Blocked | PWAs whose cache hides changes during tests. |
| Client certificate | origin + `.pfx` (or `.pem` + key) + passphrase | Sites that require a certificate (mTLS). |

Text values can use placeholders: `{{secret.x}}` (encrypted secrets of the environment) and `{{env.x}}` (its
variables). They are resolved when a run starts; the environment stores the placeholder, never the secret.

## Network steps

- **`ui.waitForResponse`** — waits for a response whose URL contains a text or matches a glob (`**/api/orders*`),
  optionally a method and status. It takes the first matching response since the test started that no earlier step
  took, so put it *after* the click that causes the request. Assertions can check `status`, `body`, `url`,
  `header:<name>` and any JSONPath (`$.items[0].id`); `captureAs` keeps the body.
- **`ui.mockRoute`** — from this step until the end of the test, matching requests are answered by StepForge:
  `fulfill` (status, body, content type), `abort` (a network error), `delay` (slow network, then the real server) or
  `remove` (stop). `times` limits it to the next N requests. Use it to test error pages, empty states and spinners
  without breaking the real server.
- **`ui.setOffline`** — takes the browser offline (and back online) to test offline banners and PWAs.

## Visual checkpoints

`ui.visualCheckpoint` takes a screenshot (of the step's element, or the page; full page optional) and compares it with
the approved **baseline**:

1. **First run:** there is no baseline yet, so the screenshot becomes it. The step passes and says so.
2. **Later runs:** pixels are compared. The step passes when at most *Allowed difference* (default **0.1 %**) of the
   pixels differ (*Colour tolerance*, default 0.1, ignores anti-aliasing noise). Otherwise it fails, and the run page
   shows the baseline, this run and a **difference image** (changed pixels in red). A changed size fails too.
3. **Intended change?** Press **Accept as new baseline** on the step: the next run compares with the new screenshot.
   The diagnosis names the failure "The page looks different from the approved screenshot".

Baselines are kept per step, browser and screen size in `data/artifacts/baselines/`. Give a checkpoint a **Baseline
name** to share one baseline between steps (or keep it when you copy a scenario). Animations are stopped and the text
caret hidden before the screenshot; list changing parts (clocks, ads, avatars) in **Hide (CSS)** so they are masked.

## Phones and tablets

The run size **Mobile** (390×844) or **Tablet** (768×1024) — in the Run dialog, a schedule or a campaign — gives the
browser a touch screen and, on Chromium and WebKit, a mobile browser identity (user agent, pixel density, mobile
viewport), so sites that detect phones serve their mobile version. `ui.tap` taps an element (it needs a touch screen,
so it fails with a clear message at desktop size). Firefox has no mobile mode: it gets the size and touch only.

This is mobile **web** testing. Native iOS and Android apps are a different technology; see
[NATIVE_APPS_PLAN.md](NATIVE_APPS_PLAN.md).

## Time, storage and other helpers

- **`ui.setClock`** — `set`: the page sees a fixed time; `install` (put it **before** `ui.navigate`): the clock starts at
  the given time and runs, and timers can be moved; `fastForward`: jump ahead by *ms* (e.g. past a session timeout).
- **`ui.storage`** — cookies, localStorage or sessionStorage: `get` (assert on `value` or `exists`, or `captureAs`),
  `set`, `remove`, `clear`. Setting a cookie needs a page open (or the environment's base URL).
- **`ui.download`** — clicks the element and keeps the file as evidence. Assert on `fileName`, `size` or `content`
  (text files up to 5 MB); `captureAs` keeps `{ fileName, size, path }`.
- **Canvas and maps** — `x` and `y` on `ui.click` / `ui.tap` click that point inside the element (from its top-left
  corner).

## Limits

See [KNOWN_ISSUES.md](KNOWN_ISSUES.md) for the full list. In short: CAPTCHAs and real second factors are blocked on
purpose — use a test bypass in the test environment, or read the code with email steps; closed shadow roots cannot be
reached (open ones can, except by XPath); WebSocket messages are not inspected yet (check what they change on the
page); the newest browser steps are not translated by code export yet (they become `TODO(StepForge)` comments).
