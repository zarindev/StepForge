import { DEFAULT_RUN_OPTIONS, newId, runTestCase, type StepInput } from '@stepforge/core';
import { utilExecutor } from '@stepforge/executor-util';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import {
  androidCapabilities,
  androidQueries,
  AppiumServer,
  createNativeExecutor,
  xpathLiteral,
} from '../src/index.ts';

const APK = fileURLToPath(new URL('../../../../demo/android-app/careclinic.apk', import.meta.url));

describe('Android locators and launch settings', () => {
  it('maps StepForge locators to Appium queries, best first', () => {
    expect(androidQueries({ strategy: 'testId', value: 'sign_in' })).toEqual([
      { using: 'id', value: 'sign_in' },
      { using: 'accessibility id', value: 'sign_in' },
    ]);
    expect(androidQueries({ strategy: 'placeholder', value: 'Email' })).toEqual([
      { using: 'xpath', value: "//*[@hint='Email']" },
    ]);
    expect(androidQueries({ strategy: 'text', value: 'Sign in' })[0]).toEqual({
      using: '-android uiautomator',
      value: 'new UiSelector().text("Sign in")',
    });
    expect(androidQueries({ strategy: 'role', value: 'button', name: 'Sign in' })[0]!.value).toBe(
      "//*[@class='android.widget.Button' or @class='android.widget.ImageButton'][@text='Sign in' or @content-desc='Sign in' or @hint='Sign in']",
    );
    expect(() => androidQueries({ strategy: 'css', value: '#x' })).toThrow(/CSS locators work on web pages/);
    expect(() => androidQueries({ strategy: 'role', value: 'banner' })).toThrow(/no Android equivalent/);
    expect(xpathLiteral("it's")).toBe(`"it's"`);
    expect(xpathLiteral(`a'b"c`)).toBe(`concat('a', "'", 'b"c')`);
  });

  it('builds Appium capabilities from the environment', () => {
    const caps = androidCapabilities({
      app: APK,
      avd: 'Pixel',
      resetApp: true,
      capabilities: { 'appium:language': 'fr' },
    });
    expect(caps).toMatchObject({
      platformName: 'Android',
      'appium:automationName': 'UiAutomator2',
      'appium:app': APK,
      'appium:avd': 'Pixel',
      'appium:avdArgs': '-no-window -no-audio -no-boot-anim',
      'appium:noReset': false,
      'appium:language': 'fr',
    });
    expect(androidCapabilities({ appPackage: 'com.x', udid: 'R58N', resetApp: false })).toMatchObject({
      'appium:appPackage': 'com.x',
      'appium:udid': 'R58N',
      'appium:noReset': true,
    });
    expect(() => androidCapabilities({ udid: 'x' })).toThrow(/Set the app file/);
    expect(() => androidCapabilities({ app: '/nope/app.apk' })).toThrow(/was not found/);
  });
});

/**
 * On a real emulator: STEPFORGE_TEST_ANDROID=<AVD name> (Appium installed with `npm run appium:install`).
 * CI runs these in the android job.
 */
const AVD = process.env.STEPFORGE_TEST_ANDROID;
describe.skipIf(!AVD)('Android app on an emulator (CareClinic mobile)', () => {
  const appium = new AppiumServer(resolve(fileURLToPath(new URL('../../../../data/tools', import.meta.url))));
  afterAll(() => appium.stop());
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
  const run = (s: ReturnType<typeof steps>, opts: Partial<typeof DEFAULT_RUN_OPTIONS> = {}) => {
    const artifactsDir = mkdtempSync(join(tmpdir(), 'sf-android-'));
    return runTestCase({
      runId: 'R',
      steps: s,
      env: {},
      executors: [createNativeExecutor({ appiumUrl: () => appium.url() }), utilExecutor],
      options: {
        ...DEFAULT_RUN_OPTIONS,
        defaultTimeoutMs: 10_000,
        video: 'off',
        trace: 'off',
        screenshots: 'off',
        android: { app: APK, avd: AVD === '1' ? undefined : AVD, resetApp: true },
        ...opts,
      },
      artifactsDir,
    }).then((r) => ({ ...r, artifactsDir }));
  };
  const signIn = (password = 'CareClinic1') =>
    steps(
      {
        type: 'ui.fill',
        params: { value: 'nurse@careclinic.test' },
        locators: [{ strategy: 'placeholder', value: 'Email' }],
      },
      { type: 'ui.fill', params: { value: password }, locators: [{ strategy: 'testId', value: 'password' }] },
      { type: 'ui.click', locators: [{ strategy: 'role', value: 'button', name: 'Sign in' }] },
    );

  it('signs in, adds a patient and checks the count; evidence: video, device log, screenshots', async () => {
    const r = await run(
      [
        ...signIn(),
        ...steps(
          {
            type: 'ui.assert',
            params: { check: 'text', expected: 'No patients yet' },
            locators: [{ strategy: 'testId', value: 'patient_count' }],
          },
          {
            type: 'ui.fill',
            params: { value: 'Ana Silva' },
            locators: [{ strategy: 'placeholder', value: 'Patient name' }],
          },
          { type: 'ui.click', locators: [{ strategy: 'text', value: 'Add patient' }] },
          {
            type: 'ui.assert',
            params: { check: 'text', expected: '1 patient' },
            locators: [{ strategy: 'testId', value: 'patient_count' }],
          },
          {
            type: 'ui.extract',
            params: { from: 'text' },
            locators: [{ strategy: 'text', value: 'Ana Silva' }],
            captureAs: 'name',
          },
          {
            type: 'util.if',
            params: { check: 'visible' },
            locators: [{ strategy: 'text', value: 'Sign out' }],
          },
        ),
      ],
      { video: 'always', screenshots: 'everyStep' },
    );
    expect(r.error ?? null).toBeNull();
    expect(r.status).toBe('passed');
    expect(r.vars.name).toBe('Ana Silva');
    expect(
      r.steps
        .filter((s) => s.type.startsWith('ui.'))
        .every((s) => s.screenshotPath && existsSync(s.screenshotPath)),
    ).toBe(true);
    const video = r.artifacts.find((a) => a.kind === 'video');
    expect(video?.path).toMatch(/video\.mp4$/);
    expect(readFileSync(video!.path).length).toBeGreaterThan(1000);
    expect(r.artifacts.some((a) => a.kind === 'console')).toBe(true);
  }, 600_000);

  it('a wrong password shows an error; the app data is reset between tests', async () => {
    const r = await run([
      ...signIn('wrong'),
      ...steps(
        {
          type: 'ui.assert',
          params: { check: 'text', expected: 'Wrong email or password' },
          locators: [{ strategy: 'testId', value: 'error' }],
        },
        {
          type: 'ui.assert',
          params: { check: 'hidden' },
          locators: [{ strategy: 'testId', value: 'patient_count' }],
        },
      ),
    ]);
    expect(r.error ?? null).toBeNull();
    expect(r.status).toBe('passed');
  }, 300_000);

  it('the planted bug fails the test; the failure keeps a screenshot and the screen’s element tree', async () => {
    const r = await run(
      [
        ...signIn(),
        ...steps(
          {
            type: 'ui.fill',
            params: { value: 'Alexandra Johnson' },
            locators: [{ strategy: 'placeholder', value: 'Patient name' }],
          },
          { type: 'ui.click', locators: [{ strategy: 'testId', value: 'add_patient' }] },
          {
            type: 'ui.assert',
            params: { check: 'text', expected: 'Alexandra Johnson' },
            locators: [
              {
                strategy: 'xpath',
                value: "//*[contains(@resource-id,'patient_list')]/android.widget.TextView[1]",
              },
            ],
            timeoutMs: 2000,
          },
        ),
      ],
      { screenshots: 'onFailure' },
    );
    expect(r.status).toBe('failed');
    expect(r.error).toContain('"Alexandra Jo"');
    const failed = r.steps.find((s) => s.status === 'failed')!;
    expect(failed.screenshotPath && existsSync(failed.screenshotPath)).toBe(true);
    const tree = r.artifacts.find((a) => a.kind === 'dom');
    expect(readFileSync(tree!.path, 'utf8')).toContain('com.stepforge.careclinic:id/patient_list');
  }, 300_000);

  it('a missing element is reported with the locators tried', async () => {
    const r = await run(
      steps({ type: 'ui.click', locators: [{ strategy: 'testId', value: 'nope' }], timeoutMs: 1500 }),
    );
    expect(r.status).toBe('failed');
    expect(r.errorKind).toBe('element_not_found');
    expect(r.error).toContain('testId=nope');
  }, 300_000);
});
