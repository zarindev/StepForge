# StepForge — Build Progress

| # | Phase | Status |
|---|---|---|
| 1 | Foundation: monorepo, core, db, crypto, server, web shell, scripts, CI | ✅ Done |
| 2 | Applications, environments, secrets, modules, tags, Test Explorer, CRUD, versions | ⏳ Next |
| 3 | Scenario engine, UI executor, runner, live view, evidence, results | — |
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

## Phase 1 — Foundation (2026-10-06)

**Delivered**
- npm-workspaces monorepo (`apps/*`, `packages/*`, `packages/executors/*`), strict TypeScript, ESM, one `tsc --noEmit` for server + packages and a separate one for the web app.
- `@stepforge/core`: ULID ids; the unified **step model** (Zod) with the full Section 5 catalogue (50 step types across 6 groups), locators, assertions, `deriveScenarioKind`; entity input schemas; `VariableResolver` (`env/secret/data/run/vars/random` scopes, type-preserving whole-placeholder resolution, descriptive errors, secret masking).
- `@stepforge/db`: complete Section 6 schema in Drizzle (28 tables incl. `load_test_authorizations` for Section 12), generated SQL migration, `openDatabase()` with WAL, foreign keys, busy timeout and a `VACUUM INTO` backup to `data/backups/` before any migration on an existing DB (keeps the last 10), typed settings helpers.
- `@stepforge/crypto`: AES-256-GCM encrypt/decrypt/rotate, master key auto-created at `data/.key` (0600).
- `@stepforge/server` (Fastify 5): hard-coded `127.0.0.1` bind with next-free-port fallback, per-start session token (header or `?token=` for WebSocket, timing-safe compare), Host allow-list against DNS rebinding, request logging disabled (no secrets in logs), Zod → 400 error mapping, `/api/health`, `/api/system`, `/api/settings` (validated per key), `/api/ws` live channel, SPA hosting with token injection, unfinished runs marked `interrupted` on boot.
- `@stepforge/web`: React 19 + Vite 7 + Tailwind v4 + TanStack Router/Query + motion. Dark-first theme tokens with light mode, icon rail for all 12 sections, top bar (app switcher placeholder, search, live-connection indicator, Run button), `Ctrl+K` command palette, `?` shortcuts overlay, `G`-chord navigation, skeleton/empty/error states, Home KPIs from real counts, working theme setting. Inter + JetBrains Mono bundled locally (no CDN).
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
