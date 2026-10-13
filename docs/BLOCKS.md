# Reusable blocks

_By Md Zarin Tasnim · part of the StepForge documentation_

A **block** is a named group of steps, such as "Sign in" or "Save the patient form", that any scenario of the
application can run with a **Use block** (`util.useBlock`) step. Blocks are read fresh every time a test runs, so
**fixing a block fixes every test that uses it**. This is StepForge's version of the step library in tools such as
Cerberus Testing.

## Making blocks

- **From existing steps:** in the Test Explorer, tick the steps (they must be next to each other) and choose
  **Make a block from N steps**. The steps move into a new block and the scenario now uses it (a new scenario
  version, so you can restore the old one from History).
- **From scratch:** application → **Blocks** tab → **New block**, then add steps as in any scenario.

## Inputs

A block can declare inputs, so one "Sign in" block serves every user:

| Input | Default | Meaning |
| --- | --- | --- |
| `email` | `reception@careclinic.test` | used when a step doesn't pass one |
| `password` | _(empty = required)_ | each use must pass a value |

Inside the block, write `{{vars.email}}` and `{{vars.password}}`. Each **Use block** step shows a field per
input; values can use placeholders such as `{{secret.adminPassword}}`. A required input without a value stops the
test with a clear message. Exported code (Playwright, Cypress, Selenium…) sets the same variables before the
block's inlined steps.

## Where a block is used

The Blocks tab lists, for each block, the scenarios and other blocks that use it (inside conditions and loops too),
and how many scenarios a change affects, counting those that reach it through another block. Deleting a block that
is in use asks first and names what would break.

## When a test fails inside a block

- The diagnosis says **Inside block "Save the patient form" — used by 4 scenarios**, with a link to the block.
- When the diagnosis suggests a new locator, the button reads **Fix block "…": use …**. The fix is written into
  the block, so every scenario that uses it is repaired at once (the old locator stays as a fallback).
- Run results group failures by the block step they share, e.g. **3 failed tests stop at step 2 of block
  "Sign in"**, so you fix the cause once instead of three times.
