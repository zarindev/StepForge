# Final checklist (spec section 16)

_By Md Zarin Tasnim · part of the StepForge documentation_

Status of every item, with the evidence. ✅ verified · 🟡 verified in part (what is missing is said). Last reviewed
2026-10-07 (Phase 14).

| # | Item | Status | Evidence |
|---|---|---|---|
| 1 | Fresh clone on Windows and Ubuntu: only Node + Git → setup → start → onboarding → demo workspace → a hybrid run passes/fails as expected | 🟡 | Verified on **macOS** from a fresh `git clone`: `./setup.sh` → `./start.sh` → `scripts/smoke-onboarding.ts` (welcome → Load demo workspace → Run all tests → passes and failures as expected, gate red); see PROGRESS Phase 13. Re-run in Phase 14 against a fresh data folder with both demo apps: CareClinic 16 passed, 12 failed, 0 broken. The same steps for **Ubuntu and Windows** are the `fresh-clone` CI job, which has not run yet (no remote). |
| 2 | No paid API, account or subscription; fully functional with Ollama absent | ✅ | Nothing calls an external service; every test suite and E2E run without Ollama (the AI button only appears when a local Ollama answers). |
| 3 | Multiple applications with separate environments, secrets, connections and test trees | ✅ | Phase 2 and 6 tests (organisation, connections per environment), E2E organise/database specs. |
| 4 | Recorder captures UI + network; API tests generated from captured traffic | ✅ | Phase 4 recorder E2E (steps, assert/extract/mask, network capture → API scenario). |
| 5 | OpenAPI, Postman, cURL, HAR import | ✅ | Phase 5 importer tests with sample files; API E2E. |
| 6 | DB tests on SQLite + PostgreSQL + MySQL (Docker-free; users point at their own servers) | ✅ | Phase 6: real PostgreSQL 18.4, MySQL 9.7.2, MongoDB (portable servers), SQLite; CI service containers; [DATABASES.md](DATABASES.md). |
| 7 | Email OTP flow with Mailpit; IMAP adapter covered by tests | ✅ | Phase 7 sign-up OTP with real Mailpit; IMAP adapter tests against an IMAP server; demo workspace "Sign up with email verification". |
| 8 | Load test percentiles and threshold verdicts; k6 export valid | ✅ | Phase 8 load engine tests, real k6 run of the export. |
| 9 | Diagnosis labels each planted bug category; benchmarks recorded | ✅ | Two demo apps, 25 planted bugs (13 CareClinic, 12 ShopDesk) across API, database, UI, email, business logic and performance, listed in `demo/manifests/planted_bugs.json` (never read by StepForge; `apps/server/test/guard.test.ts`). `scripts/benchmark.ts` → [`docs/benchmarks.json`](benchmarks.json): 25/25 detected, 24/25 diagnosed correctly, 0 false alarms. The one miss (CC-UI-01) is KNOWN_ISSUES #61. `apps/server/test/demo.test.ts` checks every demo scenario's outcome on both apps. |
| 10 | Bug reports complete with evidence; all export formats open correctly | ✅ | Phase 9: PDF/HTML/Markdown, XLSX re-opened, Jira/Trello CSV, annotated screenshots. |
| 11 | Analytics, quality gates, run comparison and flaky detection from real runs | ✅ | Phase 10 tests and E2E from real runs; Home after the demo run (screenshot `docs/assets/screenshots/home.png`). |
| 12 | Scheduler + CLI + JUnit + notifications | ✅ | Phase 11: cron run → email (real Mailpit) and Telegram (Bot-API stand-in; real Telegram needs a token), CLI exit codes, JUnit validated with xmllint. |
| 13 | Exported Playwright project passes in CI; Cypress and Selenium exports run locally against the demo | 🟡 | `npm run verify:export`: Playwright 4/4, Cypress 4/4, Selenium (Python, Java) 4/4 and every other runnable target, with and without page objects ([CODEGEN.md](CODEGEN.md)). The `exported-code` CI job has not run on GitHub yet (no remote). |
| 14 | Secrets never appear in logs, exports, reports or generated code | ✅ | Masking tests (Phase 3–9), report tests, codegen tests with a planted secret across all 13 targets, server test with a real stored secret; request logging disabled. |
| 15 | Every screen has loading, empty and error states; `Ctrl+K` works | ✅ | Audit of every page in Phase 13 (error states added to Recorder, API Client and Exports); shell E2E for `Ctrl+K`. |
| 16 | README renders perfectly on GitHub; docs complete | 🟡 | README per spec 15.7 with banner, screenshots, export examples, Mermaid diagram; every linked file exists (checked). Rendering on GitHub is checked once the repository is pushed. Docs: README, CONTRIBUTING, SECURITY, LEGAL, CHANGELOG and `docs/*`. |
| 17 | Showcase files exist with exact sizes (slides, PDF, Upwork images, social images, listing, case study, samples) | ✅ | `scripts/export_case_study.ts` writes `docs/case-study/export/` and checks every file: 15 slides and the thumbnail at 1600×1200, Upwork images 01–06 at 1600×1200 (JPGs under 2 MB), GitHub preview 1280×640, LinkedIn/X 1200×675, a 15-page PDF; no element outside its frame, in the footer or outside the thumbnail's 90% safe area; Inter loaded locally; every number filled from `docs/benchmarks.json`. Slides checked by eye. `UPWORK_LISTING.md` (title 64/70, description 484/600), `CASE_STUDY.md`, `docs/samples/` (real exports), screenshots and WebM clips (`scripts/capture_showcase.ts`). |
| 18 | Final summary to the author | ✅ | Given at the end of Phase 14 (and PROGRESS Phase 14). |

## Manual to-dos for the author

- Push the repository to `github.com/zarindev/stepforge` (the README badges, clone commands, CONTRIBUTING and the
  case study already point there).
- After the first push: check the `fresh-clone` (Ubuntu, Windows) and `exported-code` CI jobs, and how the README
  renders on GitHub.
- Record `docs/assets/demo.gif` (the README has a comment describing the clip; WebM clips to start from are in
  `docs/assets/clips/`) and set the GitHub social preview to `docs/case-study/export/social/github-social-preview.png`.
- Fill in the Upwork portfolio from `docs/case-study/UPWORK_LISTING.md` (the GitHub and Upwork links are already in
  the README, the case study and its last slide).
- Optional: an Electron desktop installer (not built; KNOWN_ISSUES #64).
