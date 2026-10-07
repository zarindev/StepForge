# StepForge — Upwork portfolio listing

_By Md Zarin Tasnim · part of the StepForge documentation_

Copy these fields into **Upwork → Profile → Portfolio → Add project**. Every number comes from
[`docs/benchmarks.json`](../benchmarks.json) (measured by `scripts/benchmark.ts`). If you rerun the benchmark, update
the numbers here to match.

## Project title (64 / 70 characters)

```
StepForge: Local QA Studio for UI, API, Database & Email Testing
```

## Your role

```
Creator and sole developer — product design, architecture, implementation and tests
```

## Project description (484 / 600 characters)

```
StepForge is a free, open-source QA studio I designed and built. Record a user journey once, test it across the UI, API, database, email and performance in one scenario, and export clean Playwright, Cypress or Selenium code. Every failure gets an automatic diagnosis and bug report. Benchmarked on two demo apps with 25 planted bugs: all 25 detected, 24 diagnosed correctly, 0 false alarms, 51 tests in 83.6 s. Runs 100% locally with Node.js, TypeScript, React, Playwright and SQLite.
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
https://github.com/YOUR_GITHUB_USERNAME/stepforge
```

Replace `YOUR_GITHUB_USERNAME` once the repository is public. The case study's last slide also links
`https://www.upwork.com/freelancers/YOUR_UPWORK_PROFILE`: replace it in `case-study.html` and rerun
`npx tsx scripts/export_case_study.ts`.

## Rebuilding the images

```bash
npm run build
npx tsx scripts/benchmark.ts          # real numbers → docs/benchmarks.json
npx tsx scripts/capture_showcase.ts   # screenshots, clips and samples
npx tsx scripts/export_case_study.ts  # PDF, slides, Upwork and social images (checks sizes and overflow)
```
