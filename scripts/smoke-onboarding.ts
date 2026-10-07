/**
 * Fresh-install smoke test (Phase 13; StepForge by Md Zarin Tasnim). Against a StepForge that was just set up and
 * started with nothing but Node and Git: the welcome screen appears, "Load demo workspace" starts the demo app, and a
 * full run passes and fails as expected.
 *
 *   npx tsx scripts/smoke-onboarding.ts http://127.0.0.1:4400
 */
import { chromium } from 'playwright';

const base = (process.argv[2] ?? 'http://127.0.0.1:4400').replace(/\/$/, '');

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const step = (s: string) => console.log(`• ${s}`);
  try {
    await page.goto(base);
    await page.getByTestId('welcome').waitFor({ timeout: 30_000 });
    step('welcome screen shown');
    await page.getByRole('button', { name: 'Load demo workspace' }).click();
    await page.getByTestId('demo-loaded').waitFor({ timeout: 120_000 });
    step(
      `demo workspace loaded (${(await page.getByTestId('demo-loaded').locator('a').first().textContent())?.trim()})`,
    );
    await page.getByRole('button', { name: 'Run all tests' }).click();
    await page.waitForURL(/\/runs\/[0-9A-Z]{26}$/);
    const runId = page.url().split('/').pop()!;
    const token = await page.evaluate(
      () => (globalThis as unknown as { __STEPFORGE__: { token: string } }).__STEPFORGE__.token,
    );
    const deadline = Date.now() + 300_000;
    let run: {
      status: string;
      totalsJson: { total: number; passed: number; failed: number; broken: number };
      qualityGateJson: { status: string } | null;
    };
    for (;;) {
      run = (await (
        await fetch(`${base}/api/runs/${runId}`, { headers: { 'x-stepforge-token': token } })
      ).json()) as typeof run;
      if (!['queued', 'running'].includes(run.status)) break;
      if (Date.now() > deadline) throw new Error('The run did not finish within 5 minutes');
      await new Promise((r) => setTimeout(r, 2000));
    }
    const t = run.totalsJson;
    step(
      `run ${runId}: ${run.status} — ${t.passed} passed, ${t.failed} failed, ${t.broken} broken of ${t.total}`,
    );
    const ok =
      run.status === 'failed' &&
      t.total === 28 &&
      t.passed === 16 &&
      t.failed === 12 &&
      t.broken === 0 &&
      run.qualityGateJson?.status === 'red';
    if (!ok)
      throw new Error(
        'Expected CareClinic to have 16 passed and 12 failed (the demo app’s planted defects) with a red quality gate',
      );
    step('passes and failures as expected; quality gate red');
    console.log('Fresh-install smoke test passed');
  } catch (err) {
    await page.screenshot({ path: 'smoke-onboarding-failure.png', fullPage: true }).catch(() => undefined);
    throw err;
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
