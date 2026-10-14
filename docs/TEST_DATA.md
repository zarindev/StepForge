# Test data library

_By Md Zarin Tasnim · part of the StepForge documentation_

The **test data library** holds named data sources that any test can read rows from, instead of hard-coding values
in its steps. Everything is read on your computer, and nothing is sent anywhere else.

## Data sources

Application → **Test data** → **New data source**:

| Kind | Rows come from |
| --- | --- |
| **Table** | Rows kept in StepForge: type them, or **Paste CSV** (the first line names the columns) |
| **CSV file** | A file on this computer: an absolute path, or one relative to StepForge's data folder. Only `.csv`, `.tsv` and `.txt` files are read (so StepForge's own key and database files are never reachable) |
| **SQL query** | A query on one of the application's database connections, chosen by name, so each environment uses its own database. The query **always runs read-only**, even on a connection that allows writes: one statement only, and anything that would change data is refused before it reaches the database |
| **API call** | A GET or POST to the application (absolute, or relative to the environment's base URL), with optional headers. **Rows at** is a JSONPath to the list, e.g. `$.items` |

The settings of CSV, SQL and API sources can use `{{env.…}}` and `{{secret.…}}`; they are filled in from the run's
environment. **Preview rows** shows what a source returns in any environment.

## Reading a row: `util.useData`

Add a **util.useData** step and choose:

| Which row | Takes |
| --- | --- |
| `first` | the first row |
| `random` | any row |
| `unused` | a row no other test took **in this run**: each test case, also in parallel, gets a different row; when they are all taken the step fails clearly |
| `row` | row number *n* |
| `match` | the first row whose *column* equals a value |

The row becomes a variable: with **Store as variable** `patient` (by default, the source name in camelCase), later
steps write `{{vars.patient.full_name}}`. Assertions on the step can check a column directly (target `full_name`,
equals `Ana Lopez`). Rows are read **once per run** per source, so many tests reading the same query cost one query.

## Notes

- Steps refer to sources by name, like database connections. The Test data tab shows how many steps read each
  source, and deleting one that is in use asks first.
- Application export/import carries data sources: table rows, the CSV path, the SQL query and the API settings.
  Secrets stay as `{{secret.…}}` placeholders.
- Code export cannot read StepForge's data library: `util.useData` steps are marked `TODO(StepForge)` with a warning.

Steps refer to a source by name. **Renaming a source updates every step that reads it** (in scenarios and blocks, nested
steps included).
