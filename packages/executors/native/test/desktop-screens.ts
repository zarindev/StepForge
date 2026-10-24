import { DEFAULT_RUN_OPTIONS, newId, runTestCase, type RunOptions, type StepInput } from '@stepforge/core';
import { utilExecutor } from '@stepforge/executor-util';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import type { Locator } from '@stepforge/core';
import {
  createNativeExecutor,
  NativeManualSession,
  NativeRecordingSession,
  parseElements,
  type NativePlatform,
} from '../src/index.ts';

/**
 * The dashboard's features for a desktop demo app (CareClinic) on a real desktop: recording from its picture, a
 * manual session, visual checkpoints. Run by the desktop CI jobs (macOS, Windows, Linux) with the app's own tests.
 */
export function desktopScreenTests(o: {
  name: string;
  platform: () => NativePlatform;
  url: () => Promise<string>;
  /** The run options that start the app (macos / windows / linux launch settings). */
  launch: Partial<RunOptions>;
  /** Whether this computer can record the screen (the session's recording is then checked). */
  video: boolean;
}) {
  const steps = (...s: StepInput[]) =>
    s.map((x) => ({
      enabled: true,
      continueOnFail: false,
      retries: 0,
      params: {},
      locators: [],
      assertions: [],
      id: newId(),
      ...x,
    }));
  const run = (s: ReturnType<typeof steps>, extra: Partial<RunOptions> = {}, baselineDir?: string) =>
    runTestCase({
      runId: 'R',
      steps: s,
      env: {},
      executors: [createNativeExecutor({ appiumUrl: o.url, baselineDir }), utilExecutor],
      options: {
        ...DEFAULT_RUN_OPTIONS,
        defaultTimeoutMs: 20_000,
        video: 'off',
        trace: 'off',
        screenshots: 'onFailure',
        ...o.launch,
        ...extra,
      },
      artifactsDir: mkdtempSync(join(tmpdir(), 'sf-desktop-screens-')),
    });
  const id = (value: string): Locator[] => [{ strategy: 'testId', value }];
  const signIn: StepInput[] = [
    { type: 'ui.fill', params: { value: 'nurse@careclinic.test' }, locators: id('email') },
    { type: 'ui.fill', params: { value: 'CareClinic1' }, locators: id('password') },
    { type: 'ui.click', locators: [{ strategy: 'role', value: 'button', name: 'Sign in' }] },
  ];

  it(`${o.name}: records from the app's picture (typing, a click, a check) and the recording replays`, async () => {
    const rec = await NativeRecordingSession.start({
      appiumUrl: await o.url(),
      platform: o.platform(),
      startUrl: '',
    });
    try {
      const { width, height } = await rec.screen();
      expect(width).toBeGreaterThan(100);
      expect(height).toBeGreaterThan(100);
      // As a person would: wait for the element to show, then click its place in the picture.
      const at = async (l: Locator) => {
        for (let i = 0; i < 60; i++) {
          await rec.screen();
          const p = await rec.pointOf([l]);
          if (p && p.x > 0 && p.x < 1 && p.y > 0 && p.y < 1) return p;
          await new Promise((r) => setTimeout(r, 500));
        }
        throw new Error(`Not in the app's picture: ${l.strategy}=${l.value}`);
      };
      const email = await at(id('email')[0]!);
      expect(await rec.click(email.x, email.y)).toMatchObject({ field: true });
      await rec.type('nurse@careclinic.test');
      const password = await at(id('password')[0]!);
      await rec.click(password.x, password.y);
      await rec.type('CareClinic1');
      const button = await at({ strategy: 'role', value: 'button', name: 'Sign in' });
      await rec.click(button.x, button.y);
      const count = await at(id('patient_count')[0]!);
      await rec.check(count.x, count.y, 'text');
    } finally {
      await rec.stop();
    }
    const snap = rec.snapshot();
    expect(snap.steps.map((s) => s.type)).toEqual(['ui.fill', 'ui.fill', 'ui.click', 'ui.assert']);
    expect(snap.steps[0]!.locators![0]).toMatchObject({ strategy: 'testId', value: 'email' });
    expect(snap.steps[1]!.params).toEqual({ value: '{{secret.password}}' });
    expect(snap.steps[3]!.params).toEqual({ check: 'text', expected: 'No patients yet' });
    const replay = await runTestCase({
      runId: 'R',
      steps: steps(...snap.steps.map(({ id: _id, describe: _d, ...s }) => s as StepInput)),
      env: {},
      secrets: rec.secrets,
      executors: [createNativeExecutor({ appiumUrl: o.url }), utilExecutor],
      options: { ...DEFAULT_RUN_OPTIONS, defaultTimeoutMs: 20_000, video: 'off', trace: 'off', ...o.launch },
      artifactsDir: mkdtempSync(join(tmpdir(), 'sf-desktop-replay-')),
    });
    expect(replay.error ?? null).toBeNull();
    expect(replay.status).toBe('passed');
  }, 600_000);

  it(`${o.name}: a manual session clicks and types at points of the picture; a screenshot; closing ends the recording`, async () => {
    const platform = o.platform();
    const m = await NativeManualSession.start({ url: await o.url(), platform });
    let video: Buffer | null = null;
    try {
      const shot = await m.screenshot();
      expect(shot.subarray(1, 4).toString()).toBe('PNG');
      // Where the email field is in the picture, from the element tree (as a tester sees it there).
      let field: { x: number; y: number } | undefined;
      for (let i = 0; i < 60 && !field; i++) {
        const { area } = await platform.view(m.driver);
        const el = parseElements(await m.driver.source()).find(
          (e) => (e.attrs.identifier ?? e.attrs.AutomationId ?? e.attrs.id) === 'email',
        );
        if (el)
          field = {
            x: (el.rect.x + el.rect.width / 2 - area.x) / area.width,
            y: (el.rect.y + el.rect.height / 2 - area.y) / area.height,
          };
        else await new Promise((r) => setTimeout(r, 500));
      }
      expect(field).toBeDefined();
      await m.act({ action: 'tap', ...field! });
      await m.act({ action: 'type', text: 'typed by hand' });
      const [el] = await m.driver.findAll('accessibility id', 'email');
      await expect.poll(async () => m.driver.text(el!), { timeout: 15_000 }).toContain('typed by hand');
    } finally {
      video = await m.stop();
    }
    if (o.video) expect(video?.length ?? 0).toBeGreaterThan(0);
    else
      console.log(
        `${o.name}: the manual session's recording: ${video ? `${video.length} bytes` : m.noRecording}`,
      );
  }, 600_000);

  it(`${o.name}: a visual checkpoint of the app's window: a new baseline, a match, then a change`, async () => {
    const baselines = mkdtempSync(join(tmpdir(), 'sf-desktop-baselines-'));
    const checkpoint: StepInput = {
      type: 'ui.visualCheckpoint',
      params: { name: 'sign-in window', maxDiffPercent: 0.5 },
    };
    const wait: StepInput = { type: 'ui.waitFor', params: { state: 'visible' }, locators: id('email') };
    const first = await run(steps(wait, checkpoint), {}, baselines);
    expect(first.error ?? null).toBeNull();
    expect(first.steps.at(-1)!.visual?.status).toBe('new');
    const second = await run(steps(wait, checkpoint), {}, baselines);
    expect(second.steps.at(-1)!.visual?.status, second.steps.at(-1)!.message).toBe('match');
    expect(second.status).toBe('passed');
    const signedIn: StepInput = {
      type: 'ui.waitFor',
      params: { state: 'visible' },
      locators: id('patient_count'),
    };
    const changed = await run(steps(...signIn, signedIn, checkpoint), {}, baselines);
    expect(changed.status).toBe('failed');
    expect(['changed', 'sizeChanged']).toContain(changed.steps.at(-1)!.visual?.status);
  }, 600_000);

  return { run, steps, signIn };
}
