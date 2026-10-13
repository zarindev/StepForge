# Campaigns

_By Md Zarin Tasnim · part of the StepForge documentation_

A **campaign** runs a saved set of tests in every **environment × browser × screen size** you choose, with one click.
For example, all smoke tests on Local and Staging, in Chromium and WebKit, at desktop and mobile size, is 8 runs. The
results come back as one **campaign run** with a combined report. This is StepForge's version of the campaigns in
tools such as Cerberus Testing. Everything runs locally, one run after another, through StepForge's normal queue.

## Creating a campaign

**Campaigns** (left rail) → **New campaign**:

| Field | Meaning |
| --- | --- |
| Tests | **All tests**, or any mix of modules (with their sub-modules), tags and single scenarios |
| Environments | One or more environments of the application |
| Browsers | Chromium, Firefox and/or WebKit |
| Screen sizes | Desktop, tablet and/or mobile |
| Parallel tests, retries | Used by every run of the campaign |
| Send one summary to | Notification channels that get **one** summary when the whole campaign has finished |

The dialog shows how many runs one campaign run makes.

## Running it

- **Run** on the campaign starts a campaign run and opens its page.
- **Schedules:** in a schedule's **Tests** list, choose the campaign. Its environments, browsers and sizes are used.
- **CLI / CI:** `stepforge campaign --app <slug> --name "<campaign>" --junit results/` (see [CLI.md](CLI.md)).

## The campaign-run page

- One card per combination (environment · browser · screen size) with its result, linking to that run's evidence
  and diagnoses.
- A grid with every test and its result in every combination, failing tests first. A test that fails only on
  "Staging · webkit · mobile" stands out at a glance. Each icon opens that test's result.
- **Rerun failed** starts a new campaign run with only the tests that failed, only in the combinations where they
  failed. It links back to the run it repeats.
- **Cancel** stops the queued and running runs of the campaign run.

The runs of a campaign are ordinary runs: they appear in **Runs**, count in analytics and quality gates, and file
bugs. Each one links back to its campaign run.

## Export and import

Application export/import includes campaigns. Environments and tags are matched by name, modules and scenarios by
their place in the export. Notification channels are not exported, because they hold credentials; choose them again
after importing.
