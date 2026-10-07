# StepForge — Upwork portfolio listing

_By Md Zarin Tasnim · part of the StepForge documentation_

Copy these fields into **Upwork → Profile → Portfolio → Add project**. Every number comes from
[`docs/benchmarks.json`](../benchmarks.json) (measured by `scripts/benchmark.ts`). If you rerun the benchmark, update
the numbers here to match.

## Project title (64 / 70 characters)

```
StepForge – Open-Source QA Studio: Record Once, Test Every Layer
```

## Your role

```
Creator and sole developer — product design, architecture, implementation and tests
```

## Project description (506 / 600 characters)

```
I designed and built StepForge, a free, open-source test automation studio. Record a user journey once, then test the UI, API, database, email and performance in a single scenario. Every failure gets a plain-English diagnosis and an automatic bug report, and the tests export as clean Playwright, Cypress or Selenium code. In a benchmark on two demo apps with 25 planted bugs, it caught all 25, diagnosed 24 correctly and raised 0 false alarms. Built with TypeScript, Node.js, React, Playwright and SQLite.
```

## Skills (5)

1. Playwright
2. Test Automation
3. API Testing
4. TypeScript
5. Quality Assurance

## Images, in this order

All images are 1600×1200 (Upwork's 4:3). Use the PNGs, or the JPGs in `export/upwork/jpg/` if the upload is too large
(each JPG is under 2 MB).

| # | File | What it shows |
| --- | --- | --- |
| 1 (thumbnail) | `export/upwork/00-thumbnail.png` | Name, benefit line, the diagnosis screen and the 25/25 badge |
| 2 | `export/upwork/01-hybrid-flow.png` | One scenario across UI, API and database |
| 3 | `export/upwork/02-recorder.png` | The recorder: app with toolbar + live step list |
| 4 | `export/upwork/03-api-sql.png` | API client and SQL workbench |
| 5 | `export/upwork/04-diagnosis.png` | Automatic failure diagnosis |
| 6 | `export/upwork/05-analytics.png` | Analytics and quality gates |
| 7 | `export/upwork/06-export.png` | Code export to 13 targets |

## Attachment

- `export/StepForge-Case-Study.pdf`: the 15-slide case study, 1600×1200 pages.

## Project URL

```
https://github.com/zarindev/StepForge
```

The repository must be public at that address before you add it. The case study's last slide links both the
repository and the Upwork profile, <https://www.upwork.com/freelancers/~01b847509724f9e1ff>.

## Rebuilding the images

```bash
npm run build
npx tsx scripts/benchmark.ts          # real numbers → docs/benchmarks.json
npx tsx scripts/capture_showcase.ts   # screenshots, clips and samples
npx tsx scripts/export_case_study.ts  # PDF, slides, Upwork and social images (checks sizes and overflow)
```
