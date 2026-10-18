# StepForge as a desktop app (preview)

_By Md Zarin Tasnim · part of the StepForge documentation_

![StepForge in its own window](assets/screenshots/new/desktop-app.png)

StepForge can run in its own window instead of a browser tab. It is the same StepForge: the same local server, the
same dashboard and the same data folder, so tests, runs and settings are shared with `npm start` and the CLI.

This is a **preview**: the installers are not signed yet (see [First start](#first-start)).

## Install

Download the installer for your computer from the
[GitHub releases](https://github.com/zarindev/StepForge/releases) (once a release includes them):

| System | File | Install |
| --- | --- | --- |
| macOS, Apple silicon (M1 and later) | `StepForge-<version>-mac-arm64.dmg` | Open it and drag StepForge to Applications |
| macOS, Intel | `StepForge-<version>-mac-x64.dmg` | Same |
| Windows 10 and 11 | `StepForge-<version>-win-x64.exe` | Run it; choose the folder (no administrator rights needed) |
| Linux | `StepForge-<version>-linux-x86_64.AppImage` or `…-linux-amd64.deb` | AppImage: make it executable and run it; .deb: `sudo apt install ./<file>` |

Nothing else to install: the app brings its own runtime. On Linux, UI tests also need Chromium's system libraries
(`npx playwright install-deps chromium`, or the packages listed by Playwright for your distribution).

### First start

![The start screen downloading Chromium on the first start](assets/screenshots/new/desktop-first-start.png)

- **macOS:** the app is not signed with an Apple Developer certificate yet, so macOS says it cannot check it. Open it
  once with right-click → **Open** → **Open** (or System Settings → Privacy & Security → **Open Anyway**). After that it
  opens normally.
- **Windows:** SmartScreen may say "Windows protected your PC": choose **More info** → **Run anyway**.
- The first start downloads **Chromium** for UI tests (about 150 MB) and **Mailpit** for email tests (about 10 MB),
  with progress on the start screen. Later starts take a few seconds. Without internet, StepForge still opens; UI
  tests wait for Chromium, which is downloaded at the next start.

### Where your data is

| System | Folder |
| --- | --- |
| macOS | `~/Library/Application Support/StepForge/data` |
| Windows | `%APPDATA%\StepForge\data` |
| Linux | `~/.config/StepForge/data` |

Set `STEPFORGE_DATA_DIR` to use another folder, for example the `data` folder of a clone to share its tests.

## From a clone

After `setup`, `npm run desktop` opens the same app from the repository: it runs on your Node.js and uses the
repository's `data` folder, so it shares everything with `npm start` and the CLI.

## How it behaves

- A window opens with a start screen and shows the dashboard a few seconds later.
- **Already running?** If StepForge is already running on the same data folder (for example with `npm start`), the
  window opens that server instead of starting a second one, and leaves it running when you quit the app.
- **Quitting** stops the server cleanly: a test that was running is marked *interrupted* and can be resumed, as with
  Ctrl+C in a terminal.
- **macOS:** closing the window keeps StepForge running in the Dock, so scheduled runs keep going; click the Dock icon
  to bring the window back, or quit with ⌘Q. On Windows and Linux, closing the window quits.
- **Links** to other sites open in your default browser; only the dashboard opens inside the app.
- **Phone apps:** installing Appium from the app downloads a separate Node.js for it (the app's own runtime has no
  npm), into the data folder.

## Menu

| Item | What it does |
| --- | --- |
| File → Open in Browser | The same dashboard in your default browser |
| File → Show Server Log | The server's output (`logs/desktop-server.log` in the data folder) |
| View | Reload, zoom and developer tools |
| Help | This documentation and the issue tracker |

## Settings

The app reads the same settings as `npm start` (`STEPFORGE_DATA_DIR`, `STEPFORGE_PORT` and the rest) from the
environment; from a clone, also from the repository's `.env`. One more, for the clone only:

| Variable | Default | Meaning |
| --- | --- | --- |
| `STEPFORGE_NODE` | `node` on the `PATH` | The Node.js (22 or newer) that runs the server |

## If it does not start

A message shows the last lines of the server's output and the path of the full log (File → Show Server Log). From a
clone, the usual causes are the same as for `npm start`: `setup` not run yet, or Node.js older than 22. "Node.js was
not found" means the app could not find `node`: install Node.js 22 or newer, or set `STEPFORGE_NODE` to its full path.

## Building the installers

```bash
npm run desktop:package                 # this system and processor; output in apps/desktop/release
npm run desktop:package -- --arch x64   # macOS: the Intel app on an Apple-silicon Mac
npm run desktop:package -- --dir        # the app folder only, no installer (quicker)
node apps/desktop/scripts/smoke.mjs     # start the built app and run the demo tests in it
```

Each system builds its own installers (the database module is compiled for it). CI builds all of them, starts each
app and runs the demo tests in it; a version tag attaches the installers to a draft GitHub release.
