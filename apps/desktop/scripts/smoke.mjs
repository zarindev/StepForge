// Starts the packaged StepForge app (apps/desktop/release) with an empty data folder and checks it end to end: the
// first-start setup, the dashboard, the demo workspace and a real test run, then a clean quit.
//
//   node apps/desktop/scripts/smoke.mjs [--arch arm64|x64]
import { _electron } from 'playwright';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const RELEASE = resolve(dirname(fileURLToPath(import.meta.url)), '../release');
const { values } = parseArgs({ options: { arch: { type: 'string', default: process.arch } } });
const exe = {
  darwin: join(
    RELEASE,
    values.arch === 'arm64' ? 'mac-arm64' : 'mac',
    'StepForge.app/Contents/MacOS/StepForge',
  ),
  win32: join(RELEASE, 'win-unpacked', 'StepForge.exe'),
  linux: join(RELEASE, 'linux-unpacked', 'stepforge'),
}[process.platform];
if (!exe || !existsSync(exe)) throw new Error(`No packaged app at ${exe}: run npm run desktop:package first`);

const data = mkdtempSync(join(tmpdir(), 'stepforge-smoke-'));
const env = { ...process.env, STEPFORGE_DATA_DIR: data };
delete env.ELECTRON_RUN_AS_NODE;
const step = (m) => console.log(`[smoke] ${m}`);
const t0 = Date.now();
const app = await _electron.launch({
  executablePath: exe,
  // Linux CI: the unpacked app's sandbox helper is not set up as root.
  args: process.platform === 'linux' ? ['--no-sandbox'] : [],
  env,
  timeout: 120_000,
});
try {
  const win = await app.firstWindow();
  step('window open; waiting for the first-start setup and the server');
  await win.waitForURL(/^http:\/\/127\.0\.0\.1:\d+/, { timeout: 900_000 });
  await win.waitForLoadState('networkidle');
  const base = new URL(win.url()).origin;
  step(`dashboard at ${base} after ${Math.round((Date.now() - t0) / 1000)} s`);
  if (!existsSync(join(data, '.desktop-setup.json'))) throw new Error('the first-start setup did not finish');

  const token = await win.evaluate(() => globalThis.__STEPFORGE__?.token);
  const api = async (method, path, body) => {
    const r = await fetch(base + path, {
      method,
      headers: { 'x-stepforge-token': token, 'content-type': 'application/json' },
      body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`${method} ${path} → ${r.status} ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : null;
  };
  const demo = await api('POST', '/api/demo/load');
  step(
    `demo workspace: ${demo.applications.map((a) => a.name).join(', ')}; Mailpit ${demo.mailpit ? 'running' : 'not running'}`,
  );
  if (!demo.mailpit) throw new Error(`Mailpit did not start: ${demo.warnings.join(' ')}`);

  const clinic = (await api('GET', '/api/applications')).find((a) => a.name === 'CareClinic');
  const [environment] = await api('GET', `/api/applications/${clinic.id}/environments`);
  const started = await api('POST', '/api/runs', {
    applicationId: clinic.id,
    environmentId: environment.id,
    scope: { type: 'application' },
  });
  let run;
  for (let i = 0; i < 900; i++) {
    const r = await api('GET', `/api/runs/${started.id}`);
    run = r.run ?? r;
    if (!['queued', 'running'].includes(run.status)) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  const totals = run.totalsJson ?? run.totals ?? {};
  step(
    `CareClinic run: ${run.status}, ${totals.passed} passed, ${totals.failed} failed, ${totals.broken} broken of ${totals.total}`,
  );
  // The demo apps have planted bugs, so some tests fail on purpose; a broken test or none passing is a real problem.
  if (!totals.total || !totals.passed || totals.broken) throw new Error('the test run did not work');
} finally {
  const pid = app.process().pid;
  await app.close();
  step(`quit (app process ${pid})`);
}
const log = readFileSync(join(data, 'logs', 'desktop-server.log'), 'utf8');
if (!/shutting down/.test(log)) throw new Error('the server did not shut down cleanly');
step('server shut down cleanly; all checks passed');
rmSync(data, { recursive: true, force: true });
