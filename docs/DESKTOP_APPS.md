# Desktop apps (Electron)

_By Md Zarin Tasnim · part of the StepForge documentation_

StepForge tests **Electron desktop apps** on Windows, macOS and Linux with the same tests it uses for web apps. Many
desktop apps are built with Electron (editors, chat apps, internal tools). Each test starts the app, runs its steps
in the app's windows, and closes the app. Recording, manual testing, evidence and diagnosis work as they do on the
web.

This is step N1 of the [native apps plan](NATIVE_APPS_PLAN.md). Android, iOS and other desktop apps come next.

## Set up a desktop app

1. **Applications → New application**, then set **Platform** to _Desktop app (Electron)_. You can also change it
   later with **Edit**.
2. **Add environment**. A desktop app's environment says how to start the app instead of which browser to use:

| Field | What to put |
| --- | --- |
| **App executable** | The packaged app: `C:\Program Files\Notes\Notes.exe`, `/Applications/Notes.app/Contents/MacOS/Notes`, `/opt/notes/notes` |
| **or app project folder** | The app's source folder (the one with its `package.json`). StepForge starts it with the Electron installed in that project, as `npm start` would |
| **Arguments** | Extra command-line arguments, one per line |
| **App environment variables** | `KEY=value` lines for the app's process, for example `NODE_ENV=test` |
| **Working folder** | Optional. Relative paths start here |

Set either the executable or the project folder. If you set both, the executable is used. Variables and secrets work
in every field, for example `{{env.appFolder}}` or `API_TOKEN={{secret.token}}`, so one test can start a different
build in each environment. The **Base URL** is only a name for reports, for example `app://notes`.

## Writing tests

Tests are written as usual: record them, or add steps in the editor.

- **The app's first window is the test's page.** There is no "Open page" step at the start; the app opens its own
  window. A full URL can still be opened with `ui.goto` when the app loads web content.
- **Locators work the same way**: role, label, text, placeholder, test id, CSS. They are ranked and self-healing as on
  the web.
- **New windows are like new tabs.** When the app opens a window (About, Settings, a dialog window), use
  `ui.switchTab` with `urlContains`, for example `about.html`. A window the app closes is handled like a closed tab.
- **Evidence**: screenshots, a video of every window, the Playwright trace, console messages and errors, and network
  requests the windows make.
- **Diagnosis**: failures are explained as on the web. For example, an assertion that expected "3 notes" and found
  "2 notes" says so and points at the step.

## Recording

**Record** on a desktop app starts the app (from the chosen environment) with the recording toolbar. Clicks and typing
in any of its windows become steps. Close the app or press **Stop** to finish.

## Manual testing

**Run manually** opens the desktop app with the StepForge panel, the same panel used on the web: steps, pass / fail /
blocked / skip, notes, screenshots and clips. The whole session is recorded as the test's video. Closing the app
finishes the session. See [Manual testing](MANUAL_RUNS.md).

## What is different from web apps

| Web setting | For a desktop app |
| --- | --- |
| Browser (Chromium, Firefox, WebKit) | Not used: the app runs in its own Electron. Campaigns that pick browsers run the same app for each |
| Headless | Not available: the app's windows open on the screen. On a Linux server, use a virtual display (`xvfb-run -a`) |
| Screen sizes and mobile devices | The app decides its window size |
| Language, time zone, location, proxy and the other browser settings | Set them in the app or through its arguments and environment variables |
| Web Vitals and Lighthouse | Web pages only |
| Code export | Exported UI tests open a browser at the base URL, and the export warns about this. Start the app with Playwright's `_electron.launch()` in the exported project |

## Running in CI

Desktop-app tests run from the CLI and in CI like any other tests (`stepforge run --app notes`). Windows and macOS
runners show the windows on their desktop. Linux runners need a virtual display and Electron's sandbox helper:

```yaml
- run: node node_modules/electron/install.js   # Electron downloads its binary on first use: fetch it now
- name: Set up Electron (Linux)
  run: |
    sudo chown root:root node_modules/electron/dist/chrome-sandbox
    sudo chmod 4755 node_modules/electron/dist/chrome-sandbox
- run: xvfb-run -a npx stepforge run --app notes
```

For a packaged app, the sandbox helper sits next to the app's executable. Another option is to add `--no-sandbox` to
the environment's arguments on a CI machine that is not shared.

## The demo desktop app

`demo/desktop-app` is a small Electron "Notes" app used by StepForge's own tests. It has a note field, an **Add**
button, a counter, a list, and an **About** window. Point an environment's **app project folder** at it to try desktop
testing. It has one planted bug: from three notes on, the counter is one short.

## Troubleshooting

| Message | What to do |
| --- | --- |
| _Set the app executable or the app folder in the environment_ | Edit the environment and fill in one of the two |
| _The app folder was not found_ / _The app executable was not found_ | Check the path. Relative paths start at the working folder, or at StepForge's folder if none is set |
| _No Electron found for …_ | Run `npm install` in the app's project, or point at the packaged executable instead |
| _The desktop app did not start: …_ | Start the app by hand with the same arguments to see its error. On Linux, check the display and the sandbox (see above). If StepForge itself is started from a terminal of a VS Code-based editor, this is handled: StepForge removes `ELECTRON_RUN_AS_NODE` from the app's environment |
