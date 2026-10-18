// StepForge desktop app (Electron main process). It starts the same local server `npm start` runs, as a child
// process, and shows the dashboard in its own window. If a StepForge server from the same data folder is already
// running, the window opens that one instead of starting a second server on the same database.
//
// Two ways to run: from a clone (`npm run desktop`: the server runs on the installed Node.js and uses the repository's
// data folder) and installed (the server runs on Electron's own Node.js, the data lives in the user's app-data folder,
// and the first start downloads Playwright's Chromium and Mailpit).
import { app, BrowserWindow, dialog, Menu, shell } from 'electron';
import { fork } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const SERVER_DIR = join(ROOT, 'apps/server');
const ICON = join(ROOT, 'apps/desktop/assets/icon.png');
const START_TIMEOUT_MS = 90_000;

app.setName('StepForge');

/** @type {import('node:child_process').ChildProcess | null} */
let server = null;
/** @type {BrowserWindow | null} */
let win = null;
let dashboardUrl = '';
let quitting = false;
const logTail = [];

// One StepForge window: opening the app again focuses it.
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => showWindow());
  app.whenReady().then(start);
}

async function start() {
  if (process.platform === 'darwin' && existsSync(ICON)) app.dock?.setIcon(ICON);
  Menu.setApplicationMenu(buildMenu());
  showWindow();
  try {
    dashboardUrl = await runningServer();
    if (!dashboardUrl) {
      if (app.isPackaged) await firstStartSetup();
      dashboardUrl = await startServer();
    }
    win?.loadURL(dashboardUrl);
  } catch (err) {
    dialog.showErrorBox(
      'StepForge could not start',
      `${err.message}\n\n${logTail.slice(-25).join('\n') || 'No output from the server.'}\n\nFull log: ${logFile()}`,
    );
    quitting = true;
    app.quit();
  }
}

function showWindow() {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
    return;
  }
  win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 960,
    minHeight: 600,
    title: 'StepForge',
    icon: existsSync(ICON) ? ICON : undefined,
    backgroundColor: '#0b0f17',
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  win.loadURL(dashboardUrl || loadingPage());
  win.on('closed', () => (win = null));
  guardNavigation(win.webContents);
}

/** Only the local dashboard opens inside StepForge; every other link opens in the default browser. */
function guardNavigation(contents) {
  const local = (url) => (dashboardUrl && url.startsWith(`${dashboardUrl}/`)) || url === dashboardUrl;
  const external = (url) => {
    if (/^(https?|mailto):/i.test(url)) void shell.openExternal(url);
  };
  contents.setWindowOpenHandler(({ url }) => {
    if (local(url)) return { action: 'allow' };
    external(url);
    return { action: 'deny' };
  });
  contents.on('will-navigate', (event, url) => {
    if (local(url) || url.startsWith('data:')) return;
    event.preventDefault();
    external(url);
  });
  contents.on('did-create-window', (child) => guardNavigation(child.webContents));
}

/**
 * The data folder, as the server reads it: STEPFORGE_DATA_DIR from the environment, else (installed) the user's
 * app-data folder or (from a clone) the repository's .env or ./data.
 */
function dataDir() {
  let raw = process.env.STEPFORGE_DATA_DIR;
  if (!raw && app.isPackaged) return join(app.getPath('userData'), 'data');
  const envFile = join(ROOT, '.env');
  if (!raw && existsSync(envFile))
    raw = readFileSync(envFile, 'utf8').match(/^\s*STEPFORGE_DATA_DIR\s*=\s*"?([^"\n]+?)"?\s*$/m)?.[1];
  raw ||= './data';
  return isAbsolute(raw) ? raw : resolve(ROOT, raw);
}

function logFile() {
  return join(dataDir(), 'logs', 'desktop-server.log');
}

/** A server from this folder that is already running (started with `npm start`, for example). */
async function runningServer() {
  const file = join(dataDir(), '.session.json');
  if (!existsSync(file)) return null;
  try {
    const { port } = JSON.parse(readFileSync(file, 'utf8'));
    const url = `http://127.0.0.1:${port}`;
    const res = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1500) });
    const body = await res.json();
    return res.ok && body.name === 'StepForge' ? url : null;
  } catch {
    return null; // left over from a server that has stopped
  }
}

/**
 * The Node.js that runs the server and its helpers: Electron's own when installed (nothing else to install), else the
 * Node.js on the PATH (or STEPFORGE_NODE), the one `setup` needs anyway.
 */
function nodeRuntime() {
  const env = { ...process.env, STEPFORGE_DATA_DIR: dataDir(), STEPFORGE_OPEN_BROWSER: '0' };
  return app.isPackaged
    ? { execPath: process.execPath, env: { ...env, ELECTRON_RUN_AS_NODE: '1' } }
    : { execPath: process.env.STEPFORGE_NODE || 'node', env: { ...env, ELECTRON_RUN_AS_NODE: undefined } };
}

/** Runs a Node.js script of StepForge's (with the same runtime as the server), showing its last line while it runs. */
function runScript(script, args, label) {
  return new Promise((resolvePromise, reject) => {
    const child = fork(join(ROOT, script), args, {
      cwd: ROOT,
      ...nodeRuntime(),
      execArgv: script.endsWith('.ts') ? ['--import', 'tsx'] : [],
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    const show = (chunk) => {
      const text = chunk.toString();
      appendFileSync(logFile(), text);
      const last = text
        .split(/[\r\n]+/)
        .map((l) => l.trim())
        .filter(Boolean)
        .at(-1);
      if (last) setStatus(label, last.slice(0, 120));
    };
    child.stdout.on('data', show);
    child.stderr.on('data', show);
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0 ? resolvePromise() : reject(new Error(`${label} failed (exit code ${code})`)),
    );
  });
}

/**
 * Installed app, first start (and after an update that brings a new Playwright): Playwright's Chromium for UI tests
 * and Mailpit for email tests, as `setup` does for a clone. A failure is reported, not fatal: everything else works.
 */
async function firstStartSetup() {
  mkdirSync(dirname(logFile()), { recursive: true });
  const playwright = JSON.parse(
    readFileSync(join(ROOT, 'node_modules/playwright/package.json'), 'utf8'),
  ).version;
  const marker = join(dataDir(), '.desktop-setup.json');
  try {
    if (JSON.parse(readFileSync(marker, 'utf8')).playwright === playwright) return;
  } catch {
    // first start
  }
  const problems = [];
  try {
    await runScript(
      'node_modules/playwright/cli.js',
      ['install', 'chromium'],
      'Downloading Chromium for UI tests (first start only)…',
    );
  } catch (err) {
    problems.push(`Chromium: ${err.message}. UI tests need it; it is downloaded again at the next start.`);
  }
  try {
    await runScript('scripts/install-mailpit.ts', [], 'Downloading Mailpit for email tests…');
  } catch (err) {
    problems.push(`Mailpit: ${err.message}. Install it later from Settings → Email.`);
  }
  if (problems.length) {
    void dialog.showMessageBox({
      type: 'warning',
      message: 'Part of the first-start setup did not finish',
      detail: `${problems.join('\n\n')}\n\nFull log: ${logFile()}`,
    });
    if (problems.some((p) => p.startsWith('Chromium'))) return; // try again next time
  }
  writeFileSync(marker, JSON.stringify({ playwright, at: new Date().toISOString() }));
}

/** Updates the loading screen while the app gets ready. */
function setStatus(title, detail = '') {
  if (!win || dashboardUrl) return;
  void win.webContents
    .executeJavaScript(
      `document.querySelector('p').textContent = ${JSON.stringify(title)};` +
        `document.querySelector('small').textContent = ${JSON.stringify(detail)};`,
    )
    .catch(() => {});
}

function startServer() {
  setStatus('Starting the local server…');
  mkdirSync(dirname(logFile()), { recursive: true });
  appendFileSync(
    logFile(),
    `\n=== ${new Date().toISOString()} StepForge desktop app starting the server ===\n`,
  );
  const child = fork(join(SERVER_DIR, 'src/index.ts'), [], {
    cwd: SERVER_DIR,
    ...nodeRuntime(),
    execArgv: ['--import', 'tsx'],
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  server = child;
  const keep = (chunk) => {
    const text = chunk.toString();
    appendFileSync(logFile(), text);
    logTail.push(...text.split('\n').filter(Boolean));
    logTail.splice(0, Math.max(0, logTail.length - 200));
  };
  child.stdout.on('data', keep);
  child.stderr.on('data', keep);

  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`The server did not start within ${START_TIMEOUT_MS / 1000} seconds.`)),
      START_TIMEOUT_MS,
    );
    child.on('message', (m) => {
      if (m?.type !== 'ready') return;
      clearTimeout(timer);
      resolvePromise(m.url);
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(
        err.code === 'ENOENT'
          ? new Error(
              'Node.js was not found. Install Node.js 22 or newer, or set STEPFORGE_NODE to its path.',
            )
          : err,
      );
    });
    child.on('exit', (code, signal) => {
      server = null;
      clearTimeout(timer);
      if (quitting) return;
      if (!dashboardUrl)
        reject(new Error(`The server stopped while starting (${signal ?? `exit code ${code}`}).`));
      else {
        dialog.showErrorBox(
          'StepForge stopped',
          `The StepForge server stopped unexpectedly (${signal ?? `exit code ${code}`}).\n\n${logTail.slice(-25).join('\n')}\n\nFull log: ${logFile()}`,
        );
        quitting = true;
        app.quit();
      }
    });
  });
}

// Quitting lets the server finish cleanly: a running test is marked interrupted (resumable), not lost.
app.on('before-quit', (event) => {
  quitting = true;
  if (!server) return;
  event.preventDefault();
  const child = server;
  const force = setTimeout(() => child.kill('SIGKILL'), 15_000);
  child.once('exit', () => {
    clearTimeout(force);
    server = null;
    app.quit();
  });
  if (child.connected) child.send({ type: 'shutdown' });
  else child.kill('SIGTERM');
});

// macOS keeps apps running with no window (scheduled runs keep going); the dock icon brings the window back.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
app.on('activate', () => {
  if (app.isReady() && !quitting) showWindow();
});

function buildMenu() {
  const mac = process.platform === 'darwin';
  return Menu.buildFromTemplate([
    ...(mac ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [
        {
          label: 'Open in Browser',
          accelerator: 'CmdOrCtrl+Shift+O',
          click: () => dashboardUrl && shell.openExternal(dashboardUrl),
        },
        { label: 'Show Server Log', click: () => shell.openPath(logFile()) },
        { type: 'separator' },
        mac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        {
          label: 'StepForge Documentation',
          click: () => shell.openExternal('https://github.com/zarindev/StepForge#documentation'),
        },
        {
          label: 'Report a Problem',
          click: () => shell.openExternal('https://github.com/zarindev/StepForge/issues'),
        },
      ],
    },
  ]);
}

function loadingPage() {
  const logo = readFileSync(join(ROOT, 'apps/desktop/assets/logo.svg'), 'utf8');
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>StepForge</title><style>
    :root { color-scheme: light dark; --bg: #f8fafc; --fg: #0f172a; --muted: #64748b; }
    @media (prefers-color-scheme: dark) { :root { --bg: #0b0f17; --fg: #e2e8f0; --muted: #94a3b8; } }
    body { margin: 0; height: 100vh; display: grid; place-items: center; background: var(--bg); color: var(--fg);
      font: 15px/1.5 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
    main { text-align: center; } svg { width: 72px; height: 72px; }
    h1 { font-size: 20px; margin: 16px 0 4px; } p { margin: 0; color: var(--muted); }
    small { display: block; margin-top: 14px; min-height: 1.5em; color: var(--muted); font: 12px ui-monospace, Menlo, monospace; max-width: 70vw; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .bar { width: 160px; height: 3px; margin: 20px auto 0; border-radius: 3px; background: color-mix(in srgb, var(--muted) 25%, transparent); overflow: hidden; }
    .bar::after { content: ''; display: block; width: 40%; height: 100%; background: #f97316; animation: slide 1.1s ease-in-out infinite; }
    @keyframes slide { from { transform: translateX(-100%); } to { transform: translateX(250%); } }
  </style></head><body><main>${logo}<h1>StepForge</h1><p>Starting StepForge…</p><div class="bar"></div><small></small></main></body></html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}
