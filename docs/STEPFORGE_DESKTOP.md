# StepForge as a desktop app (preview)

_By Md Zarin Tasnim · part of the StepForge documentation_

StepForge can run in its own window instead of a browser tab. It is the same StepForge: the same local server, the
same dashboard and the same data folder, so tests, runs and settings are shared with `npm start` and the CLI.

This is a **preview**. It runs from a clone of the repository, after `setup`; installers that need no Node.js come
next.

## Start it

```bash
npm run desktop
```

A window opens with "Starting the local server…" and shows the dashboard a few seconds later.

- **Already running?** If StepForge is already running from the same folder (for example with `npm start`), the window
  opens that server instead of starting a second one, and leaves it running when you quit the app.
- **Quitting** stops the server cleanly: a test that was running is marked *interrupted* and can be resumed, as with
  Ctrl+C in a terminal.
- **macOS:** closing the window keeps StepForge running in the Dock, so scheduled runs keep going; click the Dock icon
  to bring the window back, or quit with ⌘Q. On Windows and Linux, closing the window quits.
- **Links** to other sites open in your default browser; only the dashboard opens inside the app.

## Menu

| Item | What it does |
| --- | --- |
| File → Open in Browser | The same dashboard in your default browser |
| File → Show Server Log | The server's output (`data/logs/desktop-server.log`) |
| View | Reload, zoom and developer tools |
| Help | This documentation and the issue tracker |

## Settings

The app reads the same `.env` as `npm start` (`STEPFORGE_DATA_DIR`, `STEPFORGE_PORT` and the rest). One more:

| Variable | Default | Meaning |
| --- | --- | --- |
| `STEPFORGE_NODE` | `node` on the `PATH` | The Node.js (22 or newer) that runs the server |

## If it does not start

A message shows the last lines of the server's output and the path of the full log. The usual causes are the same as
for `npm start`: `setup` not run yet, or Node.js older than 22. "Node.js was not found" means the app could not find
`node`: install Node.js 22 or newer, or set `STEPFORGE_NODE` to its full path.
