# Step Reference

Every step shares the same shape (see [ARCHITECTURE.md](ARCHITECTURE.md#step-model)):
`type`, `label`, `params`, `locators`, `assertions`, `enabled`, `continueOnFail`, `timeoutMs`, `retries`, `captureAs`.

Values in `params`, locator values and assertion `expected` values may use variables:
`{{env.baseUrl}}`, `{{env.<variable>}}`, `{{secret.<key>}}`, `{{data.<field>}}`, `{{vars.<name>}}`, `{{run.id}}`,
`{{random.email|uuid|number|digits6|string|timestamp}}`. A value that is exactly one placeholder keeps its type.

**Status rules.** An assertion mismatch, a missing element or a timeout makes the test `failed` (a product
problem). Configuration problems (unknown variable, unsupported step, invalid params, script error) make it
`broken`. `continueOnFail` records the failure and keeps going; the test still fails at the end (soft
assertion). `retries` re-runs only that step; run-level retries re-run the whole test and mark it `flaky` if
a later attempt passes.

## Locators (UI steps)

`locators` is a ranked list. StepForge waits for any of them, then uses the best-ranked one that matches.
If the first one fails but a later one matches, the step passes and is marked **healed** in the results.

| strategy | value | example |
|---|---|---|
| `testId` | `data-testid` / `data-test` / `data-cy` / `data-qa` | `{"strategy":"testId","value":"save-patient"}` |
| `role` | ARIA role, plus `name` (accessible name, exact) | `{"strategy":"role","value":"button","name":"Sign in"}` |
| `label` | label text (exact) | `{"strategy":"label","value":"Email"}` |
| `placeholder` | placeholder text (exact) | `{"strategy":"placeholder","value":"Search"}` |
| `text` | visible text (exact) | `{"strategy":"text","value":"Delete record"}` |
| `css` | CSS selector | `{"strategy":"css","value":"#msg"}` |
| `xpath` | XPath (last resort) | `{"strategy":"xpath","value":"//table//tr[2]"}` |

## UI steps (`ui.*`) — available since Phase 3

| type | params | notes |
|---|---|---|
| `navigate` | `url` (absolute or relative to the environment base URL), `waitUntil` (`load`/`domcontentloaded`/`networkidle`) | assertion targets: `status`, `url`, `title` |
| `click` / `dblclick` / `rightclick` / `hover` | `force`, `button` | |
| `fill` | `value` | replaces the content |
| `type` | `value`, `delay` (ms per key) | types key by key |
| `clear` | — | |
| `press` | `key` (e.g. `Enter`, `Control+A`) | on the locator, or the page when no locator |
| `select` | `value` or `label` or `index` | output: selected value |
| `check` / `uncheck` | — | |
| `upload` | `files` (array of paths) or `file` | |
| `dragDrop` | `target` (a locator list) | |
| `scroll` | `x`, `y` (page wheel) | with a locator: scrolls it into view |
| `switchTab` | `index` or `urlContains` | without params: newest tab |
| `closeTab` | — | switches to the remaining newest tab |
| `handleDialog` | `action` (`accept`/`dismiss`), `promptText` | put it **before** the step that opens the dialog; other dialogs are dismissed |
| `switchFrame` | `selector` (iframe CSS) or `main: true` | |
| `waitFor` | with locator: `state` (`visible`/`hidden`/`attached`/`detached`); else `url` (glob) or `loadState` | prefer this over `util.wait` |
| `screenshot` | `fullPage` | with a locator: element screenshot; kept as evidence |
| `extract` | `from` (`text`/`value`/`attribute`/`count`/`url`/`title`), `attribute`, `regex` (group 1) | use `captureAs` to store it |
| `assert` | `check`, `expected`, `attribute` | polls until true or timeout; see below |
| `visualCheckpoint` | — | not available yet (reported as unsupported) |

`ui.assert` checks: `visible`, `hidden`, `text`, `textContains`, `textMatches` (regex), `value`, `count`,
`attribute` (+ `attribute` name), `enabled`, `disabled`, `checked`, `unchecked`, `url`, `urlContains`,
`urlMatches`, `title`, `titleContains`.

Generic `assertions` on any UI step can target `url`, `title`, and for steps with a locator: `text`, `value`,
`visible`, `enabled`, `checked`, `count`, `attr:<name>`. Operators: `equals`, `notEquals`, `contains`,
`notContains`, `matches`, `lt`, `lte`, `gt`, `gte`, `exists`, `notExists`, `isEmpty`, `isNotEmpty`, `lengthEquals`.

## Utility steps (`util.*`)

| type | params | notes |
|---|---|---|
| `setVariable` | `name`, `value` | |
| `generateData` | `kind` (`name`, `firstName`, `lastName`, `email`, `phone`, `date`, `birthdate`, `number`, `uuid`, `word`, `sentence`, `address`, `company`, `pattern`), `pattern` (`#` digit, `?` letter, `*` either), `min`/`max`, `direction` (`past`/`future`), `name` (store as var) | generated emails use the reserved `example.test` domain |
| `wait` | `ms` | logged as a warning: prefer `ui.waitFor` |
| `log` | `message` | |
| `runScript` | `code` (JavaScript; `return` a value) | sees copies of `vars` and may set `vars.x`; no `require`, `process`, `eval`, files or network; 5 s max |
| `if` / `loop` / `callScenario` / `useBlock` | — | arrive in Phase 4 |

API, database, email and performance steps are documented as their phases land.
