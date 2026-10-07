# Sample outputs

_By Md Zarin Tasnim · part of the StepForge documentation_

Real files that StepForge produced from the bundled demo workspace. `scripts/capture_showcase.ts` regenerates all of
them: it starts a throwaway StepForge, loads the demo (`--demo`), runs the CareClinic suite and saves what the
dashboard's export buttons would give you. Nothing here is edited by hand.

| File | What it is | Made by |
| --- | --- | --- |
| [`bug-report.pdf`](bug-report.pdf) | The automatic bug report for the billing bug (insured patients don't get their 20% discount): diagnosis, failed step, screenshots, steps to reproduce | Bugs → Export → PDF |
| [`run-report.xlsx`](run-report.xlsx) | A full CareClinic run as a spreadsheet: summary, every test, failures and diagnoses | Run → Export → Excel |
| [`run-report.html`](run-report.html) | The same run as one self-contained HTML file (screenshots embedded) | Run → Export → HTML |
| [`playwright-project/`](playwright-project/) | The whole CareClinic suite exported as a Playwright Test project with a GitHub Actions workflow. CI runs this export against the demo app (`npm run verify:export`) | Exports → Playwright Test |
| [`cypress/book-an-appointment.cy.js`](cypress/book-an-appointment.cy.js) | One scenario exported as a Cypress spec | Exports → Cypress |
| [`selenium/test_book_an_appointment.py`](selenium/test_book_an_appointment.py) | The same scenario as a Selenium + pytest test | Exports → Selenium + pytest |
| [`k6/careclinic-health.js`](k6/careclinic-health.js) | A load test (10 virtual users, p95 and error-rate thresholds) as a k6 script | Performance → Export k6 script |

Notes:

- The exported code points at `http://127.0.0.1:8101`, CareClinic's documented address. The capture sets the demo
  environment to it before exporting, whichever free port the demo app happened to use during the capture.
- Secrets never appear in exports: the generated projects read them from environment variables listed in
  `.env.example`. The literal `Reception123!` in `a-wrong-password-is-refused.spec.ts` is part of that scenario's test
  data (a wrong-account login), not a stored secret.
- The Cypress and Selenium files are single specs. Their full projects (support files, config, CI) come with a
  download from the Exports screen.
