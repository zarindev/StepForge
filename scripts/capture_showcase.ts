/**
 * Captures the showcase material (StepForge by Md Zarin Tasnim) from a throwaway StepForge with the demo workspace and
 * real runs — nothing here is mocked:
 *
 *   docs/assets/screenshots/  every major screen at 1440×900 @2x, dark (plus light for Home, the editor and results)
 *   docs/assets/clips/        demo.gif-ready WebM clips: the recorder in action, a live run, a failure diagnosis
 *   docs/samples/             a bug report PDF, run reports (XLSX, HTML), an exported Playwright project, a Cypress
 *                             spec, a Selenium test and a k6 script
 *
 *   npm run build && npx tsx scripts/capture_showcase.ts        (needs Mailpit: npm run mailpit:install)
 */
import JSZip from 'jszip';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const SHOTS = join(ROOT, 'docs/assets/screenshots');
const CLIPS = join(ROOT, 'docs/assets/clips');
const SAMPLES = join(ROOT, 'docs/samples');
/** The demo apps' documented port: the samples use it whichever free port this capture happened to get. */
const CLINIC_DEFAULT_URL = 'http://127.0.0.1:8101';
const VIEW = { width: 1440, height: 900 };

const freePort = () =>
  new Promise<number>((r) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => r(port));
    });
  });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Item = { id: string; status: string; labelJson: { scenario: string } };

async function main() {
  for (const d of [SHOTS, CLIPS, SAMPLES]) mkdirSync(d, { recursive: true });
  const dataDir = mkdtempSync(join(tmpdir(), 'stepforge-showcase-'));
  const port = await freePort();
  const cdpPort = await freePort();
  const server = spawn('npm', ['start'], {
    cwd: ROOT,
    env: {
      ...process.env,
      STEPFORGE_PORT: String(port),
      STEPFORGE_DATA_DIR: dataDir,
      STEPFORGE_OPEN_BROWSER: '0',
      STEPFORGE_LOG_LEVEL: 'warn',
      STEPFORGE_BIN_DIR: process.env.STEPFORGE_BIN_DIR ?? 'data/bin',
      STEPFORGE_MAILPIT_PORT: String(await freePort()),
      STEPFORGE_MAILPIT_SMTP_PORT: String(await freePort()),
      // The recorder's browser runs headless here and is driven over CDP, like the E2E suite does.
      STEPFORGE_RECORDER_HEADLESS: '1',
      STEPFORGE_RECORDER_CDP_PORT: String(cdpPort),
    },
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  const base = `http://127.0.0.1:${port}`;
  const browser = await chromium.launch();
  try {
    for (let i = 0; ; i++) {
      if (
        await fetch(`${base}/api/health`)
          .then((r) => r.ok)
          .catch(() => false)
      )
        break;
      if (i > 120) throw new Error('StepForge did not start');
      await sleep(500);
    }
    const token = (JSON.parse(readFileSync(join(dataDir, '.session.json'), 'utf8')) as { token: string })
      .token;
    const api = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
      const res = await fetch(`${base}${path}`, {
        method,
        headers: {
          'x-stepforge-token': token,
          ...(body !== undefined && { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${await res.text()}`);
      return (res.status === 204 ? null : res.json()) as T;
    };
    const download = async (path: string, body?: unknown): Promise<Buffer> => {
      const res = await fetch(`${base}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'x-stepforge-token': token, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`${path} → ${res.status} ${await res.text()}`);
      return Buffer.from(await res.arrayBuffer());
    };
    const waitRun = async (runId: string) => {
      for (;;) {
        const r = await api<{ status: string; items: Item[] }>('GET', `/api/runs/${runId}`);
        if (!['queued', 'running'].includes(r.status)) return r;
        await sleep(1000);
      }
    };

    const ctx = await browser.newContext({ viewport: VIEW, deviceScaleFactor: 2, colorScheme: 'dark' });
    const page = await ctx.newPage();
    const shot = async (name: string, path: string | null, wait?: (p: Page) => Promise<unknown>) => {
      if (path !== null) {
        await page.goto(`${base}${path}`);
        await page.waitForLoadState('networkidle');
      }
      if (wait) await wait(page);
      await page.waitForTimeout(600); // charts and transitions settle
      await page.screenshot({ path: join(SHOTS, `${name}.png`) });
      console.log(`  screenshots/${name}.png`);
    };

    // ─── Demo workspace ────────────────────────────────────────────────────
    await shot('onboarding', '/', (p) => p.getByTestId('welcome').waitFor());
    const demo = await api<{
      applicationId: string;
      clinicUrl: string;
      applications: { key: string; applicationId: string; url: string }[];
    }>('POST', '/api/demo/load');
    const appId = demo.applicationId;
    const shopId = demo.applications.find((a) => a.key === 'shop')!.applicationId;
    const envOf = async (id: string) =>
      (await api<{ id: string }[]>('GET', `/api/applications/${id}/environments`))[0]!;
    const env = await envOf(appId);
    const startRun = async (applicationId: string, environmentId: string) =>
      (
        await api<{ id: string }>('POST', '/api/runs', {
          applicationId,
          environmentId,
          scope: { type: 'application' },
        })
      ).id;
    const clipContext = (dir: string) =>
      browser.newContext({
        viewport: VIEW,
        deviceScaleFactor: 2,
        colorScheme: 'dark',
        recordVideo: { dir, size: VIEW },
      });
    const saveClip = async (c: BrowserContext, p: Page, name: string) => {
      const video = p.video()!;
      await c.close();
      await video.saveAs(join(CLIPS, `${name}.webm`));
      console.log(`  clips/${name}.webm`);
    };
    const openApp = async (p: Page, id: string) => {
      await p.goto(base);
      await p.evaluate((x) => localStorage.setItem('stepforge.currentApp', x), id);
    };
    const clipTmp = mkdtempSync(join(tmpdir(), 'stepforge-clips-'));

    // Clip: a live run of the whole CareClinic suite (the first of two runs, so trends have something to show).
    let runId: string;
    {
      const c = await clipContext(clipTmp);
      const p = await c.newPage();
      await openApp(p, appId);
      runId = await startRun(appId, env.id);
      await p.goto(`${base}/runs/${runId}`);
      await waitRun(runId);
      await p.waitForTimeout(2500);
      await saveClip(c, p, 'live-run');
    }
    runId = await startRun(appId, env.id);
    await waitRun(runId);
    const shopRun = await startRun(shopId, (await envOf(shopId)).id);
    await waitRun(shopRun);
    await page.evaluate((id) => localStorage.setItem('stepforge.currentApp', id), appId);

    const tree = await api<{
      scenarios: { id: string; name: string }[];
      modules: { id: string; name: string }[];
    }>('GET', `/api/applications/${appId}/tree`);
    const scenarioId = (name: string) => tree.scenarios.find((s) => s.name.startsWith(name))!.id;
    const hybrid = scenarioId('Register in the UI');
    const run = await api<{ items: Item[] }>('GET', `/api/runs/${runId}`);
    const itemOf = (name: string) => run.items.find((i) => i.labelJson.scenario === name)!.id;
    const failed = itemOf('Doctors match the documented schema');
    const discount = itemOf('Insured patients get 20% off');
    const waitFix = (p: Page) =>
      p
        .getByText('How to fix')
        .first()
        .waitFor({ timeout: 15_000 })
        .catch(() => undefined);

    // ─── Screenshots ───────────────────────────────────────────────────────
    await shot('home', '/', (p) => p.getByTestId('home-gates').waitFor());
    await shot('applications', '/applications');
    await shot('application', `/applications/${appId}`);
    await shot('scenario-editor', `/explorer?scenario=${hybrid}`, (p) =>
      p.getByRole('list').first().waitFor(),
    );
    await shot('api-client', '/api-client', async (p) => {
      await p.getByLabel('Method').selectOption('POST');
      await p.getByLabel('Request URL').fill('{{env.baseUrl}}/api/auth/login');
      await p.getByRole('tab', { name: 'Body' }).click();
      await p.getByLabel('Body type').selectOption('json');
      await p.getByTestId('code-Request body').click();
      await p.keyboard.press('ControlOrMeta+a');
      await p.keyboard.insertText('{"email":"admin@careclinic.test","password":"{{secret.adminPassword}}"}');
      await p.getByRole('button', { name: 'Send' }).click();
      await p.getByTestId('response-status').waitFor();
    });
    await shot('sql-workbench', '/sql', async (p) => {
      await p.getByTestId('code-SQL editor').click();
      await p.keyboard.press('ControlOrMeta+a');
      await p.keyboard.press('Delete');
      await p.keyboard.insertText(
        'SELECT d.name AS doctor, d.specialty, COUNT(a.id) AS appointments\nFROM doctors d LEFT JOIN appointments a ON a.doctor_id = d.id\nGROUP BY d.id ORDER BY appointments DESC;',
      );
      await p.getByRole('button', { name: 'Run query' }).click();
      await p.getByTestId('results-grid').waitFor();
    });
    await shot('performance', '/performance', async (p) => {
      // The demo app is the author's own local demo, so the load-test authorization is truthful.
      const gate = p.getByRole('alert').filter({ hasText: 'Only load-test systems you own' });
      if (await gate.isVisible()) {
        await gate.getByRole('checkbox').check();
        await gate.getByRole('button', { name: /^Confirm for/ }).click();
      }
      await p.getByLabel('URL').fill('/api/health');
      await p.getByLabel('Profile').selectOption('load');
      await p.getByLabel('Virtual users').fill('10');
      await p.getByLabel('Duration').fill('10');
      await p.getByLabel('Ramp-up').fill('2');
      await p.getByLabel('p95 threshold').fill('500');
      await p.getByRole('button', { name: 'Run load test' }).click();
      await p
        .getByTestId('load-report')
        .getByText(/Thresholds (passed|failed)/)
        .waitFor({ timeout: 60_000 });
      await p.getByRole('heading', { level: 1 }).scrollIntoViewIfNeeded();
    });
    await shot('run-results', `/runs/${runId}?item=${failed}`, waitFix);
    await shot('diagnosis', `/runs/${runId}?item=${discount}`, waitFix);
    await shot('email-run', `/runs/${runId}?item=${itemOf('Sign up with email verification')}`);
    await shot('bugs', '/bugs');
    await shot('analytics', `/applications/${appId}/analytics`);
    await shot('schedules', '/schedules');
    await shot('exports', '/exports', async (p) => {
      await p.getByRole('button', { name: 'Preview' }).click();
      await p.getByTestId('export-files').waitFor();
      await p
        .getByTestId('export-files')
        .getByText(/appointments\/book-an-appointment\.spec/)
        .click()
        .catch(() => undefined);
      await p.getByRole('heading', { level: 1 }).scrollIntoViewIfNeeded();
    });
    await shot('settings', '/settings');

    await api('PUT', '/api/settings/theme', { value: 'light' });
    await shot('home-light', '/', (p) => p.getByTestId('home-gates').waitFor());
    await shot('scenario-editor-light', `/explorer?scenario=${hybrid}`);
    await shot('run-results-light', `/runs/${runId}?item=${failed}`, waitFix);
    await api('PUT', '/api/settings/theme', { value: 'dark' });

    // ─── Clip: a failure and its diagnosis ─────────────────────────────────
    {
      const c = await clipContext(clipTmp);
      const p = await c.newPage();
      await openApp(p, appId);
      await p.goto(`${base}/runs/${runId}`);
      await p.waitForLoadState('networkidle');
      await p.waitForTimeout(1500);
      for (const name of ['Insured patients get 20% off', 'Doctors match the documented schema']) {
        await p.getByText(name, { exact: true }).first().click();
        await waitFix(p);
        await p.waitForTimeout(1500);
        await p.mouse.move(VIEW.width * 0.7, VIEW.height * 0.6);
        for (let i = 0; i < 6; i++) {
          await p.mouse.wheel(0, 160);
          await p.waitForTimeout(250);
        }
        await p.waitForTimeout(1500);
      }
      await saveClip(c, p, 'failure-diagnosis');
    }

    // ─── Clip: the recorder, started from a new scenario in the Test Explorer ("Record steps") ──
    {
      // A throwaway scenario, deleted afterwards so the samples export only the demo suite.
      const draft = await api<{ id: string }>(
        'POST',
        `/api/modules/${tree.modules.find((m) => m.name === 'Appointments')!.id}/scenarios`,
        { name: 'Receptionist books a follow-up' },
      );
      const c = await clipContext(clipTmp);
      const p = await c.newPage();
      await openApp(p, appId);
      await p.goto(`${base}/explorer?scenario=${draft.id}`);
      await p.getByText('No steps yet').waitFor();
      await p.waitForTimeout(1200);
      await p.screenshot({ path: join(SHOTS, 'explorer-record.png') });
      console.log('  screenshots/explorer-record.png');
      await p.getByRole('button', { name: 'Record steps' }).click();
      await p.getByText('Recording steps for').waitFor();
      await p.waitForTimeout(800);
      await p.getByLabel('Start page').fill('/login');
      await p.getByRole('button', { name: 'Start recording' }).click();
      await p.getByText('Recording', { exact: true }).waitFor({ timeout: 20_000 });
      const cdp = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
      await recordBooking(cdp, demo.clinicUrl, p);
      await p.getByRole('list', { name: 'Recorded steps' }).getByRole('listitem').nth(12).waitFor();
      await p.waitForTimeout(800);
      await p.screenshot({ path: join(SHOTS, 'recorder.png') });
      console.log('  screenshots/recorder.png');
      await p.waitForTimeout(1500);
      await p.getByRole('button', { name: 'Stop & review' }).click();
      await cdp.close().catch(() => undefined);
      await p.getByText(/^Review \d+ recorded steps/).waitFor();
      await p.waitForTimeout(2000);
      await saveClip(c, p, 'recorder');
      await api('POST', '/api/recorder/discard').catch(() => undefined);
      await api('DELETE', `/api/scenarios/${draft.id}`);
    }
    rmSync(clipTmp, { recursive: true, force: true });

    // ─── Samples (real exports of the demo run) ────────────────────────────
    rmSync(SAMPLES, { recursive: true, force: true });
    mkdirSync(SAMPLES, { recursive: true });
    const put = (rel: string, data: string | Buffer) => {
      mkdirSync(dirname(join(SAMPLES, rel)), { recursive: true });
      writeFileSync(join(SAMPLES, rel), data);
      console.log(`  samples/${rel}`);
    };
    const bugs = await api<{ id: string; scenarioId: string | null }[]>(
      'GET',
      `/api/applications/${appId}/bugs`,
    );
    const bug = bugs.find((b) => b.scenarioId === scenarioId('Insured patients get 20% off')) ?? bugs[0]!;
    put('bug-report.pdf', await download(`/api/bugs/${bug.id}/export?format=pdf`));
    put('run-report.xlsx', await download(`/api/runs/${runId}/report?format=xlsx`));
    put('run-report.html', await download(`/api/runs/${runId}/report?format=html`));

    // Exported code points at the demo app's documented address, not this capture's free port.
    await api('PATCH', `/api/environments/${env.id}`, { baseUrl: CLINIC_DEFAULT_URL });
    const zip = await JSZip.loadAsync(
      await download(`/api/applications/${appId}/codegen/download`, {
        target: 'playwright-ts',
        ci: ['github'],
      }),
    );
    for (const [path, file] of Object.entries(zip.files))
      if (!file.dir) put(path.replace(/^[^/]+/, 'playwright-project'), await file.async('nodebuffer'));
    const one = async (target: string, pick: RegExp, out: string) => {
      const pv = await api<{ files: { path: string; content?: string }[] }>(
        'POST',
        `/api/applications/${appId}/codegen/preview`,
        { target },
      );
      const f = pv.files.find((x) => pick.test(x.path) && x.content);
      if (!f)
        throw new Error(`${target}: no file matches ${pick} (${pv.files.map((x) => x.path).join(', ')})`);
      put(out, f.content!);
    };
    await one('cypress-js', /\/book-an-appointment\.cy\.js$/, 'cypress/book-an-appointment.cy.js');
    await one('selenium-py', /\/test_book_an_appointment\.py$/, 'selenium/test_book_an_appointment.py');
    const k6 = await api<{ script: string }>('POST', '/api/perf/k6-export', {
      environmentId: env.id,
      name: 'CareClinic health check',
      params: {
        requests: [{ method: 'GET', url: '/api/health' }],
        profile: 'load',
        vus: 10,
        durationS: 30,
        rampS: 5,
        thresholds: { p95Ms: 500, maxErrorRatePct: 1 },
      },
    });
    put('k6/careclinic-health.js', k6.script);
    console.log(`Done: ${SHOTS}, ${CLIPS}, ${SAMPLES}`);
  } finally {
    await browser.close();
    server.kill('SIGINT');
  }
}

/** Uses CareClinic in the recorder's browser the way a person would: sign in, check the user, book a visit. */
async function recordBooking(cdp: Browser, clinicUrl: string, studio: Page) {
  const rec = cdp
    .contexts()
    .flatMap((c) => c.pages())
    .find((p) => p.url().includes('/login'))!;
  const toolbar = rec.locator('stepforge-recorder');
  await toolbar.getByRole('button', { name: 'Stop' }).waitFor();
  const human = async (fn: () => Promise<unknown>) => {
    await fn();
    await studio.waitForTimeout(700); // so the clip shows each step arrive
  };
  await human(() => rec.getByLabel('Email').pressSequentially('reception@careclinic.test', { delay: 30 }));
  await human(() => rec.getByLabel('Password').fill('Reception123!'));
  await human(() => rec.getByRole('button', { name: 'Sign in' }).click());
  await rec.waitForURL(`${clinicUrl}/`);
  await human(() => toolbar.getByRole('button', { name: 'Assert' }).click());
  await human(() => rec.locator('#current-user').click());
  await human(() => toolbar.getByRole('button', { name: /^text is/ }).click());
  await human(() => rec.getByTestId('nav-appointments').click());
  await human(() => rec.getByTestId('new-appointment').click());
  await human(() => rec.getByLabel('Patient').selectOption({ label: 'Ben Carter (PAT-1002)' }));
  await human(() => rec.getByLabel('Doctor').selectOption({ label: 'Dr. Omar Haddad · Cardiology' }));
  await human(() => rec.getByLabel('Date').fill('2026-12-21'));
  await human(() => rec.getByLabel('Reason for visit').pressSequentially('Follow-up', { delay: 40 }));
  await human(() => rec.getByTestId('book-appointment').click());
  await rec.waitForURL(/flash=/);
  await human(() => toolbar.getByRole('button', { name: 'Assert' }).click());
  await human(() => rec.getByTestId('flash').click());
  await human(() => toolbar.getByRole('button', { name: /^text is/ }).click());
  await rec.screenshot({ path: join(SHOTS, 'recorder-browser.png') });
  console.log('  screenshots/recorder-browser.png');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
