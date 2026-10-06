# StepForge — Build Progress

| # | Phase | Status |
|---|---|---|
| 1 | Foundation: monorepo, core, db, crypto, server, web shell, scripts, CI | ✅ Done |
| 2 | Applications, environments, secrets, modules, tags, Test Explorer, CRUD, versions | ✅ Done |
| 3 | Scenario engine, UI executor, runner, live view, evidence, results | ⏳ Next |
| 4 | Recorder, Scenario Editor (list/flow/plain-English) | — |
| 5 | API module, API Client, importers, contract check | — |
| 6 | Database module, SQL Workbench, data-quality audit, rollback | — |
| 7 | Email (Mailpit + IMAP), OTP/link extraction | — |
| 8 | Performance (metrics, Lighthouse, load, k6, query plans) | — |
| 9 | Diagnosis engine, bug reports, report exports | — |
| 10 | Analytics, quality gates, run comparison, flaky detection | — |
| 11 | Scheduler, CLI, notifications, JUnit/HTML | — |
| 12 | Code generators + snapshot tests | — |
| 13 | Public-repo polish, onboarding, fresh-clone test | — |
| 14 | Showcase package, optional Electron | — |

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
