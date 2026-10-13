# Element repository

_By Md Zarin Tasnim · part of the StepForge documentation_

An **element** is a named UI element of an application, such as "Save patient button" or "Email field", with its
ranked locators (test id, role, label, text, CSS…). Steps can point at an element instead of keeping their own
locators. At run time a step that uses an element gets the element's **current** locators, so **fixing an element
fixes every step that uses it**. This is StepForge's version of the application objects in tools such as Cerberus
Testing, and the element-level counterpart of [reusable blocks](BLOCKS.md).

Everything stays local: elements live in StepForge's SQLite database next to your scenarios.

## Making elements

- **From a step:** open a UI step in the Test Explorer, then choose **Save as element**. Give it a name and,
  optionally, a page (e.g. "New patient"). The step's locators become the element's, and the step now uses it.
  Save the steps.
- **From scratch:** application → **Elements** tab → **New element**.
- **While recording:** when a recorded step's best locator matches a saved element's best locator, the saved step
  uses the element automatically.

## Using elements

In a UI step, **Saved element** lists the application's elements grouped by page. With an element chosen, the step
shows the element's locators and how many steps share it. **Detach** copies the locators back into the step, which
then no longer follows the element. The step list and the plain-English view show the element's name or its
readable locators, never an id.

## Where an element is used

The Elements tab lists each element with how many steps use it, and which scenarios and blocks they are in. Saving
an element shows how many steps take the change. Deleting an element that is in use asks first; a step whose
element was deleted stops with "The saved element this step uses was deleted".

## When a step fails on a changed locator

If the step uses an element, the diagnosis says **Uses saved element "Save patient button" — used by 4 steps**, and
the suggestion button reads **Fix element "…": use …**. The new locator becomes the element's primary one (the old
ones stay as fallbacks), so all four steps work again.

## Export and import

- Exported code (Playwright, Cypress, Selenium…) contains the element's locators, best first, so it runs without
  StepForge.
- Application export/import (JSON) includes elements; imported steps point at the imported copies.
