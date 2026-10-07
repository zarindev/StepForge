/**
 * Captures the dashboard for the README and docs (StepForge by Md Zarin Tasnim): a throwaway StepForge with the demo
 * workspace and a real run, every major screen at 1440×900 @2x in dark (plus light for Home, the scenario editor and
 * run results), into docs/assets/screenshots/.
 *
 *   npm run build && npx tsx scripts/capture_screenshots.ts
 */
import { chromium, type Page } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const OUT = join(ROOT, 'docs/assets/screenshots');
const freePort = () =>
  new Promise<number>((r) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => r(port));
    });
  });

async function api<T>(base: string, token: string, method: string, path: string, body?: unknown): Promise<T> {
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
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const dataDir = mkdtempSync(join(tmpdir(), 'stepforge-shots-'));
  const port = await freePort();
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
      await new Promise((r) => setTimeout(r, 500));
    }
    const token = (JSON.parse(readFileSync(join(dataDir, '.session.json'), 'utf8')) as { token: string })
      .token;
    const ctx = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 2,
      colorScheme: 'dark',
    });
    const page = await ctx.newPage();
    const theme = async (t: 'dark' | 'light') => {
      await api(base, token, 'PUT', '/api/settings/theme', { value: t });
      await page.reload();
      await page.waitForLoadState('networkidle');
    };
    const shot = async (name: string, path: string, wait?: (p: Page) => Promise<unknown>) => {
      await page.goto(`${base}${path}`);
      await page.waitForLoadState('networkidle');
      if (wait) await wait(page);
      await page.waitForTimeout(600); // charts and transitions settle
      await page.screenshot({ path: join(OUT, `${name}.png`) });
      console.log(`  ${name}.png`);
    };

    await shot('onboarding', '/', (p) => p.getByTestId('welcome').waitFor());
    const demo = await api<{ applicationId: string }>(base, token, 'POST', '/api/demo/load');
    const appId = demo.applicationId;
    await page.evaluate((id) => localStorage.setItem('stepforge.currentApp', id), appId);
    const env = (
      await api<{ id: string }[]>(base, token, 'GET', `/api/applications/${appId}/environments`)
    )[0]!;
    // Two runs so trends and comparisons have something to show.
    let runId = '';
    for (let i = 0; i < 2; i++) {
      runId = (
        await api<{ id: string }>(base, token, 'POST', '/api/runs', {
          applicationId: appId,
          environmentId: env.id,
          scope: { type: 'application' },
        })
      ).id;
      for (;;) {
        const r = await api<{ status: string }>(base, token, 'GET', `/api/runs/${runId}`);
        if (!['queued', 'running'].includes(r.status)) break;
        await new Promise((res) => setTimeout(res, 1000));
      }
    }
    const tree = await api<{ scenarios: { id: string; name: string }[] }>(
      base,
      token,
      'GET',
      `/api/applications/${appId}/tree`,
    );
    const hybrid = tree.scenarios.find((s) => s.name.startsWith('Register in the UI'))!.id;
    const run = await api<{ items: { id: string; status: string; labelJson: { scenario: string } }[] }>(
      base,
      token,
      'GET',
      `/api/runs/${runId}`,
    );
    const failed = run.items.find((i) => i.labelJson.scenario === 'Doctors match the documented schema')!.id;

    await shot('home', '/', (p) => p.getByTestId('home-gates').waitFor());
    await shot('applications', '/applications');
    await shot('application', `/applications/${appId}`);
    await shot('scenario-editor', `/explorer?scenario=${hybrid}`, (p) =>
      p.getByRole('list').first().waitFor(),
    );
    await shot('recorder', '/recorder');
    await shot('api-client', '/api-client');
    await shot('sql-workbench', '/sql');
    await shot('performance', '/performance');
    await shot('run-results', `/runs/${runId}?item=${failed}`, (p) =>
      p
        .getByText('How to fix')
        .first()
        .waitFor({ timeout: 15_000 })
        .catch(() => undefined),
    );
    await shot('bugs', '/bugs');
    await shot('analytics', `/applications/${appId}/analytics`);
    await shot('schedules', '/schedules');
    await shot('exports', '/exports', async (p) => {
      await p.getByRole('button', { name: 'Preview' }).click();
      await p.getByTestId('export-files').waitFor();
    });
    await shot('settings', '/settings');

    await theme('light');
    await shot('home-light', '/', (p) => p.getByTestId('home-gates').waitFor());
    await shot('scenario-editor-light', `/explorer?scenario=${hybrid}`);
    await shot('run-results-light', `/runs/${runId}?item=${failed}`, (p) =>
      p
        .getByText('How to fix')
        .first()
        .waitFor({ timeout: 15_000 })
        .catch(() => undefined),
    );
    await theme('dark');
    console.log(`Screenshots in ${OUT}`);
  } finally {
    await browser.close();
    server.kill('SIGINT');
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
