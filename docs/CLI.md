# Command line (CI and unattended runs)

_By Md Zarin Tasnim · part of the StepForge documentation_

The `stepforge` command runs the same tests as the dashboard, from a terminal, the operating system's scheduler or
a CI pipeline. It works on the same data folder as the dashboard, which can stay open meanwhile: the CLI never
touches the dashboard's running tests and does not start the in-app scheduler.

## Starting it

From the StepForge folder:

| System | Command |
|---|---|
| macOS / Linux | `./stepforge.sh <command> …` |
| Windows | `stepforge.bat <command> …` |
| Any (npm) | `npm run stepforge -- <command> …` |

Use the full path to the launcher when calling it from somewhere else (schedulers, CI).

## Commands

```text
stepforge run     --app <slug> --env <name> [filters] [outputs]
stepforge list    [--app <slug>] [--json]
stepforge report  --run <id> --format html|pdf|xlsx|junit --out <file>
stepforge export  --app <slug> --out <file>
stepforge import  --file <file> [--slug <new-slug>]
stepforge secret  set --app <slug> --env <name> --key <NAME> (--from-env <VAR> | value on stdin)
stepforge codegen --app <slug> --target <id> --out <dir> [--env <name>] [--tag|--module|--scenario] [--pom] [--ci github,gitlab]
```

Every command accepts `--data-dir <dir>` (default: `./data`, or `STEPFORGE_DATA_DIR`) and `--help`.

### `run`

| Option | Meaning |
|---|---|
| `--app <slug>` | Application (the slug shown by `list`) |
| `--env <name>` | Environment name (case-insensitive) |
| `--tag <name>` / `--module <name>` / `--scenario <name>` | Run only a tag, a module (with sub-modules) or named scenarios (`--scenario` can repeat). Pick one. |
| `--browser chromium\|firefox\|webkit`, `--workers <n>`, `--retries <n>`, `--headed` | Run options, as in the dashboard's Run dialog |
| `--junit <file>` | JUnit XML for CI test viewers (one suite per module; failures carry the diagnosis) |
| `--html <file>` / `--pdf <file>` | The run report ("Prepared by …" from Settings → Reports) |
| `--notify <channel>` | Send the summary to a notification channel from Settings → Notifications (can repeat) |
| `--fail-on-gate` | Also fail when a blocking quality gate is red |
| `--json` | Print the result as JSON (run id, status, totals, gate, files, notifications, exit code) |

While it runs, each finished test is printed (`✓` passed, `✗` failed with its first error line, `!` broken,
`~` flaky, `-` skipped). Ctrl+C cancels the run cleanly.

**Exit codes:** `0` all tests passed · `1` a test failed (or the gate, with `--fail-on-gate`) · `2` usage or setup
error (unknown application, environment, tag, channel…).

Runs started by the CLI show up in the dashboard with the trigger **cli**, with all evidence, diagnoses, bugs and
analytics, exactly like dashboard runs.

### `export` / `import`

`export` writes an application as JSON: its environments (URL, variables, browser defaults), modules, tags,
scenarios with steps and test cases, reusable blocks and datasets. **Secret values are never exported**; the file
lists only the names of each environment's secrets, and `import` prints which ones to enter again. Database
connections and mail inboxes are not exported (they hold credentials); steps refer to them by name, so create them
again with the same names.

`import` creates a new application (it never overwrites one). Use `--slug` to import a second copy. References
between scenarios and blocks are rewritten to the new ids.

### `secret set`

Stores an environment secret, encrypted with the data folder's key. The value never goes on the command line
(where it would end up in shell history and process lists): pass the name of an environment variable with
`--from-env`, or pipe it on stdin:

```bash
./stepforge.sh secret set --app careclinic --env Staging --key ADMIN_PASSWORD --from-env ADMIN_PASSWORD
printf '%s' "$ADMIN_PASSWORD" | ./stepforge.sh secret set --app careclinic --env Staging --key ADMIN_PASSWORD
```

### `codegen`

Writes a ready-to-run project (or document) into a folder: `stepforge codegen --list` shows the targets
(`playwright-ts`, `cypress-js`, `selenium-java`, `k6`, `postman`, `docs-gherkin`…). `--pom` uses page objects,
`--ci github,gitlab` adds CI files. Warnings (steps that need attention) are printed. See [CODEGEN.md](CODEGEN.md).

```bash
./stepforge.sh codegen --app careclinic --target playwright-ts --out ../careclinic-tests --ci github
```

## Scheduling with the operating system

The dashboard's Schedules page only runs while StepForge is open. For runs while it is closed, let the OS start the
CLI.

**macOS / Linux (cron)**, every night at 02:00 (`crontab -e`):

```cron
0 2 * * * cd /path/to/StepForge && ./stepforge.sh run --app careclinic --env Staging --notify "QA team" >> data/cli.log 2>&1
```

**Windows (Task Scheduler)**, every night at 02:00 (Command Prompt):

```bat
schtasks /Create /SC DAILY /ST 02:00 /TN "StepForge nightly" ^
  /TR "\"C:\path\to\StepForge\stepforge.bat\" run --app careclinic --env Staging --notify \"QA team\""
```

Or in the Task Scheduler window: *Create Basic Task* → Daily → *Start a program* → Program
`C:\path\to\StepForge\stepforge.bat`, arguments `run --app careclinic --env Staging --notify "QA team"`.

## GitHub Actions

Keep the application export in your repository (`stepforge export --app careclinic --out stepforge/careclinic.json`)
and run it on a fresh StepForge in CI:

```yaml
name: StepForge tests
on:
  push:
  schedule:
    - cron: '0 2 * * *'
jobs:
  stepforge:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/checkout@v4
        with:
          repository: <owner>/StepForge   # where StepForge's source lives
          path: stepforge-app
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - name: Install StepForge
        working-directory: stepforge-app
        run: npm ci && npx playwright install --with-deps chromium
      - name: Import the tests and secrets
        working-directory: stepforge-app
        env:
          ADMIN_PASSWORD: ${{ secrets.ADMIN_PASSWORD }}
        run: |
          ./stepforge.sh import --file ../stepforge/careclinic.json
          ./stepforge.sh secret set --app careclinic --env Staging --key ADMIN_PASSWORD --from-env ADMIN_PASSWORD
      - name: Run
        working-directory: stepforge-app
        run: ./stepforge.sh run --app careclinic --env Staging --junit ../results.xml --html ../report.html
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: stepforge-report
          path: |
            results.xml
            report.html
```

The environment's base URL comes from the export; the application under test must be reachable from the runner.
Any JUnit-aware step or action can display `results.xml`.
