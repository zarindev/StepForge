# Image locators

_By Md Zarin Tasnim · part of the StepForge documentation_

Some things on a screen have no id, label or text to find them by: a pin on a map, an icon drawn in a canvas, a
button inside a game, a remote desktop, a chart. An **image locator** finds them by a small **picture** of them, in a
screenshot taken at that moment. It works for every kind of app: web pages, Electron, Android, iOS, macOS and
Windows.

Use it as a last resort. Ids and text survive redesigns; a picture breaks when the element's look changes.

## Adding one

In a step's **Locators**: **Add locator** → strategy **image** → **Choose picture** (a PNG) → optionally set how
close the match must be (**% match**, default 90 %).

The picture travels with the step (it is stored in it), so exports, imports and other computers have it too.

**Making the picture:** crop the element from a screenshot of the **same app on the same kind of screen**. Good ways
to get one:

- a **Screenshot** step with the element's locator saves exactly that element, at the screen's scale;
- the screenshot of a failed step (run page → Evidence), cropped in any image editor;
- a screenshot of the device or window, cropped.

The picture is matched at its own size: a picture from a Retina Mac does not match a non-Retina screen, and a
phone picture does not match a tablet. Crop tightly, and include some detail (a flat block of one colour is
refused).

## What it can do

| Step | With an image locator |
| --- | --- |
| Click, double-click, right-click, hover, tap | Done at the centre of the match |
| Long press, swipe on it (phone apps) | Done at the match |
| Fill / type (phone and desktop apps) | Taps the match, then types |
| Assert **visible** / **hidden**, wait for visible / hidden | Whether the picture is on the screen |
| Read text, values or attributes | Not available: a picture has no text. Add a locator with an id, text or label |

Like any locator, it can be one of several in the ranked list. Put the id or text locators first: StepForge tries
them in order, and only falls back to the picture when they do not match (the step is then marked **healed**).

## How matching works

StepForge compares the picture with every place on the screenshot using normalized cross-correlation on grayscale
pixels. A score of 100 % means identical, and a uniform change in brightness or contrast does not change the score.
To be fast, it first compares shrunken copies, then checks the best candidates at full size. A phone screenshot
takes well under a second. Pictures that look alike but differ (Sign in and Sign out buttons) score clearly lower:
85 % or less in StepForge's own tests.

When the picture is not found, the step says how close the best place came: _The picture was not found on the
screen within 15000 ms (best match 62%, needs 90%)_. If the element is there but changed a little (a new colour,
anti-aliasing), lower the % match. If it changed a lot, crop a new picture.

## Limits

- The picture is matched at the same size and rotation only: it does not find a scaled or rotated copy.
- Anything drawn on top (a tooltip, a cursor) can lower the score.
- Image locators are not exported to code: the export leaves them out and marks a picture-only step as a TODO.
