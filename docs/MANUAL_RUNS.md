# Manual test runs

_By Md Zarin Tasnim · part of the StepForge documentation_

Some checks need a person: a printout, a phone call, a physical device, a judgement about how something looks, or a
test nobody has automated yet. A **manual run** (like Cerberus Testing's manual executions) lets a tester follow a
test's steps by hand and record what happened, step by step. The results are ordinary run results, so run history,
analytics, quality gates and the HTML / PDF / Excel run reports include them.

## Starting one

**Run** → *How* → **Manual — a person follows the steps and records results** → choose what to run and the
environment → **Start manual run**. Nothing is executed. The run page opens with the first test's checklist.

## The checklist

Each test's steps are written out in plain English, numbered like an automated run:

- **Blocks are expanded** under their step ("Run a reusable block — Sign in" → 1.1, 1.2 …), with block inputs filled in.
- **Before/after hooks** appear as `before.1` / `after.1` groups; **called scenarios** are expanded too.
- **Test data and environment variables are filled in**: `{{data.total}}` shows the test case's value, `{{env.baseUrl}}`
  the environment's. Secrets stay as `{{secret.name}}` placeholders — they are never shown.
- **Saved elements** are described by their locators ("Click the "Save" button").

For every step, choose **Passed**, **Failed**, **Blocked** (could not be done — e.g. the environment is down) or
**Skipped**, add a **note** (asked for when a step fails or is blocked) and **attach a screenshot** (PNG or JPEG, up to
10 MB). **Save progress** keeps what you have; **Finish test** records the test's result and moves to the next open
test.

| The test is… | when |
|---|---|
| Failed | any step failed |
| Broken (blocked) | no step failed, but one was blocked |
| Passed | at least one step passed and none failed or was blocked |
| Skipped | no step was recorded as passed, failed or blocked |

Steps left open when you finish a test count as skipped. The first failed (or blocked) step and its note become the
test's error message, shown on the run page and in the reports.

**Finish run** ends the run at any time; tests nobody finished are marked *skipped — not tested*. A manual run stays
open while StepForge restarts (it is never marked "interrupted"); **Cancel** discards the rest.

## Manual steps in automated tests

The step type **`util.manual`** (*what the tester does* and the *expected result*) describes something only a
person can do, inside any scenario. In a manual run it is a normal checklist line ("Print the invoice — expect: the
total matches"). An **automated** run skips it without failing the test, with the message "Manual check, done in a
manual run: …", so one scenario can mix automated and manual steps. Code export turns it into a
`TODO(StepForge)` comment.

## API

| Request | What it does |
|---|---|
| `POST /api/runs` with `"mode": "manual"` | Starts a manual run (status `running`, tests `queued`) |
| `GET /api/run-items/:id/manual` | The test's checklist lines and the results so far |
| `PUT /api/run-items/:id/manual` | `{ results: [{ number, status, note?, screenshot? }], done }` — `status` is `passed`, `failed`, `blocked`, `skipped` or `pending` |
| `POST /api/run-items/:id/manual/attachments` | `{ number, dataUrl }` (PNG/JPEG data URL) → `{ path }` to use as `screenshot` |
| `POST /api/runs/:id/manual/finish` | Ends the run; unfinished tests become skipped |
