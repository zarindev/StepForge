# Manual testing

_By Md Zarin Tasnim · part of the StepForge documentation_

Some checks need a person: a printout, a judgement about how something looks, a flow nobody has automated yet, or an
exploratory pass before a release. StepForge runs those tests with you: it opens the application in a browser with
the steps beside it, records the session, takes screenshots you can mark up, and turns a failure into a bug report.
The results are ordinary run results, so run history, analytics, quality gates and the HTML / PDF / Excel reports
include them.

## Automated and manual tests

Every test (scenario) is either **Automated** or **Manual** — Test Explorer → the test → **Details** → _How it is
tested_.

|                                          | Automated    | Manual                                     |
| ---------------------------------------- | ------------ | ------------------------------------------ |
| Who runs it                              | StepForge    | A tester                                   |
| Automated runs, schedules, campaigns, CI | ✅ included  | left out                                   |
| Status until it is run                   | —            | **manual · pending** in the Test Explorer  |
| Start it                                 | **Run**      | **Run manually**                           |

Any test — automated ones too — can also be run by hand with **Run manually** (or Run → _How: Manual_). A manual
test's steps are usually `util.manual` steps (_what the tester does_ and the _expected result_), mixed with ordinary
steps such as "Open /checkout", which read as instructions too.

## Running a test by hand

1. **Run manually** on a test (or Run → _How: Manual_ for a module, a tag or the whole application) → pick the
   environment → **Start manual run**. With _Open the browser now_ (on by default), StepForge opens a browser at the
   test's first page.
2. **The browser** shows the application with a **StepForge panel** on top (drag it anywhere, minimise it):
   - the current step and what to **expect**, and the **next** step;
   - **✓ Pass**, **✗ Fail**, **⊘ Blocked** (could not be done), **→ Skip** — the panel moves on to the next step;
   - a **note** for what happened;
   - **📷 Screenshot** — the page without the panel, kept with the step (as many as you like);
   - **● Record clip / ■ Stop clip** — marks a part of the screen recording for the step;
   - a list to jump to any step, and **Finish test**.
3. **The whole browser session is recorded** as a video. When the browser closes (Finish test, Close browser, or
   closing the window), the video becomes the test's evidence, and each clip plays its part of it.
4. **The run page** follows along live: the checklist shows every step's result, note, screenshots and clips. You can
   also mark steps there, attach screenshots from your computer, and **Open browser** again later.

## Marking up screenshots

Click a screenshot (or **Mark up**) to draw on it: **boxes**, **circles**, **arrows**, **pen**, and **text**, in eight
colours and three line widths, with undo and clear. **Save marked-up copy** keeps the marked-up image with the step
(the original file is kept too).

## Reporting a bug

A failed or blocked step has **Report a bug**: a title, **how it should behave** (filled from the step's expected
result), **how it behaves** (filled from your note) and the severity. The bug appears on the **Bugs** page with the
steps to reproduce (the test's steps up to that one), the environment and the step's screenshot; the step links to it
(BUG-001…). Bug exports (PDF, Markdown, Jira and Trello CSV, Excel) include it like any other bug.

## Results

| The test is…     | when                                                     |
| ---------------- | -------------------------------------------------------- |
| Failed           | any step failed                                          |
| Broken (blocked) | no step failed, but one was blocked                      |
| Passed           | at least one step passed and none failed or was blocked  |
| Skipped          | no step was recorded as passed, failed or blocked        |

Steps left open when you finish a test count as skipped. The first failed (or blocked) step and its note become the
test's error message, shown on the run page and in the reports. The checklist is fixed when the test is first opened, so editing or deleting the scenario during the run does not move or lose recorded results. **Finish run** ends the run at any time; tests nobody
finished are marked _skipped — not tested_. A manual run stays open while StepForge restarts; **Cancel** discards the
rest.

## What the checklist shows

Each test's steps are written out in plain English, numbered like an automated run: **blocks are expanded** under
their step with their inputs filled in, **before/after hooks** appear as `before.1` / `after.1` groups, **called
scenarios** are expanded, **test data and environment variables are filled in** (`{{data.total}}`,
`{{env.baseUrl}}`), secrets stay as `{{secret.name}}` placeholders, and **saved elements** are described by their
locators.

## Web and desktop applications

For a web application, manual testing opens a web browser (Chromium) at the run's screen size. For an Electron desktop
app it starts the app as the environment says, with the same panel in its window; closing the app finishes the
session ([DESKTOP_APPS.md](DESKTOP_APPS.md)). For an Android app, the tester uses the
app on the phone or emulator and marks the steps on the run page ([ANDROID_APPS.md](ANDROID_APPS.md)). The panel
for native apps, iOS and other desktop apps come with the native-app work — see
[NATIVE_APPS_PLAN.md](NATIVE_APPS_PLAN.md).

## API

| Request                                                | What it does                                                                                                                     |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/runs` with `"mode": "manual"`               | Starts a manual run (status `running`, tests `queued`); manual tests are only included in manual runs                            |
| `GET /api/run-items/:id/manual`                        | The test's checklist, results (notes, screenshots, clips, linked bug), session video, and whether its browser is open            |
| `PUT /api/run-items/:id/manual`                        | `{ result: {…} }` (one step) or `{ results: [{ number, status, note?, screenshots?, clips? }] }`, plus `done` / `reopen` — merged per step, so steps not sent keep what is stored; `status` is `passed`, `failed`, `blocked`, `skipped` or `pending`. A finished test stays finished unless `reopen` is sent |
| `POST /api/run-items/:id/manual/browser` · `DELETE …`  | Opens (or brings forward) / closes the tester's browser                                                                          |
| `POST /api/run-items/:id/manual/attachments`           | `{ number, dataUrl }` (PNG/JPEG) → `{ path }` to add to a step's `screenshots`                                                   |
| `POST /api/run-items/:id/manual/bug`                   | `{ number, title, expected, actual, severity }` → the bug                                                                        |
| `POST /api/runs/:id/manual/finish`                     | Ends the run; unfinished tests become skipped                                                                                    |
