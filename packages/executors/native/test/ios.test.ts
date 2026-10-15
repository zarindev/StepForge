import { DEFAULT_RUN_OPTIONS, newId, runTestCase, type StepInput } from '@stepforge/core';
import { utilExecutor } from '@stepforge/executor-util';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gestureSteps } from './gestures.ts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildIosDemo, IOS_DEMO_APP } from '../../../../scripts/build-ios-demo.ts';
import {
  AppiumServer,
  createNativeExecutor,
  iosCapabilities,
  iosQueries,
  predicateLiteral,
} from '../src/index.ts';

describe('iOS locators and launch settings', () => {
  it('maps StepForge locators to Appium queries, best first', () => {
    expect(iosQueries({ strategy: 'testId', value: 'sign_in' })).toEqual([
      { using: 'accessibility id', value: 'sign_in' },
    ]);
    expect(iosQueries({ strategy: 'placeholder', value: 'Email' })).toEqual([
      { using: '-ios predicate string', value: 'placeholderValue == "Email"' },
    ]);
    expect(iosQueries({ strategy: 'text', value: 'Sign in' })[0]).toEqual({
      using: '-ios predicate string',
      value: 'label == "Sign in" OR value == "Sign in"',
    });
    expect(iosQueries({ strategy: 'role', value: 'button', name: 'Sign in' })[0]!.value).toBe(
      'type IN {"XCUIElementTypeButton"} AND (label == "Sign in" OR name == "Sign in" OR placeholderValue == "Sign in")',
    );
    expect(() => iosQueries({ strategy: 'css', value: '#x' })).toThrow(/CSS locators work on web pages/);
    expect(() => iosQueries({ strategy: 'role', value: 'banner' })).toThrow(/no iOS equivalent/);
    expect(predicateLiteral('say "hi" \\ bye')).toBe('"say \\"hi\\" \\\\ bye"');
  });

  it('builds Appium capabilities from the environment', () => {
    const caps = iosCapabilities({
      bundleId: 'com.x',
      simulator: 'iPhone 17',
      platformVersion: '27.0',
      resetApp: false,
    });
    expect(caps).toMatchObject({
      platformName: 'iOS',
      'appium:automationName': 'XCUITest',
      'appium:bundleId': 'com.x',
      'appium:deviceName': 'iPhone 17',
      'appium:platformVersion': '27.0',
      'appium:noReset': true,
      'appium:isHeadless': true,
    });
    expect(iosCapabilities({ bundleId: 'com.x', udid: 'ABC', showSimulator: true })).toMatchObject({
      'appium:udid': 'ABC',
      'appium:isHeadless': false,
    });
    expect(() => iosCapabilities({ simulator: 'iPhone 17' })).toThrow(/Set the app/);
    expect(() => iosCapabilities({ app: '/nope/App.app', simulator: 'x' })).toThrow(/was not found/);
  });
});

/**
 * On a real simulator (macOS with Xcode): STEPFORGE_TEST_IOS=<simulator name>, or 1 for the first iPhone simulator.
 * Needs `npm run appium:install`. The first test builds Appium's helper app with Xcode, which takes a few minutes.
 */
const SIM = process.env.STEPFORGE_TEST_IOS;
describe.skipIf(!SIM)('iOS app on a simulator (CareClinic mobile)', () => {
  const appium = new AppiumServer(resolve(fileURLToPath(new URL('../../../../data/tools', import.meta.url))));
  beforeAll(() => {
    if (!existsSync(IOS_DEMO_APP)) buildIosDemo(() => {});
  });
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
    const artifactsDir = mkdtempSync(join(tmpdir(), 'sf-ios-'));
    return runTestCase({
      runId: 'R',
      steps: s,
      env: {},
      executors: [createNativeExecutor({ appiumUrl: () => appium.url() }), utilExecutor],
      options: {
        ...DEFAULT_RUN_OPTIONS,
        // As in real runs of phone apps (see the runner).
        defaultTimeoutMs: 30_000,
        video: 'off',
        trace: 'off',
        screenshots: 'off',
        ios: { app: IOS_DEMO_APP, ...(SIM !== '1' && { simulator: SIM }), resetApp: true },
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
      // Signed in: the patients screen is there before the next step.
      ...(password === 'CareClinic1'
        ? [
            {
              type: 'ui.assert',
              params: { check: 'visible' },
              locators: [{ strategy: 'testId', value: 'patient_count' }],
            } satisfies StepInput,
          ]
        : []),
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
  }, 1_200_000);

  it('a wrong password shows an error', async () => {
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
  }, 600_000);

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
            locators: [{ strategy: 'text', value: 'Alexandra' }],
            timeoutMs: 5000,
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
    expect(readFileSync(tree!.path, 'utf8')).toContain('patient_count');
  }, 600_000);

  it('gestures and device steps: scroll to, swipe, long press, rotate, location, permission, background, back, deep link, close and launch', async () => {
    const r = await run(steps(...gestureSteps('ios')), { screenshots: 'onFailure' });
    if (r.status !== 'passed')
      console.log(
        JSON.stringify(
          r.steps
            .filter((x) => x.status !== 'passed')
            .map((x) => [x.type, x.label, x.message])
            .slice(0, 2),
        ),
      );
    expect(r.error ?? null).toBeNull();
    expect(r.status).toBe('passed');
  }, 900_000);

  it('image locators: a picture of the Sign in button taps it; a picture that is not on screen says how close it came', async () => {
    // The picture: a screenshot of the button itself (same scale as the screen).
    const shot = await run(
      steps({ type: 'ui.screenshot', locators: [{ strategy: 'testId', value: 'sign_in' }] }),
    );
    const picture = shot.steps[0]!.screenshotPath!;
    expect(existsSync(picture)).toBe(true);
    const r = await run(
      steps(
        {
          type: 'ui.fill',
          params: { value: 'nurse@careclinic.test' },
          locators: [{ strategy: 'testId', value: 'email' }],
        },
        {
          type: 'ui.fill',
          params: { value: 'CareClinic1' },
          locators: [{ strategy: 'testId', value: 'password' }],
        },
        { type: 'ui.click', locators: [{ strategy: 'image', value: picture }] },
        {
          type: 'ui.assert',
          params: { check: 'visible' },
          locators: [{ strategy: 'testId', value: 'patient_count' }],
        },
      ),
    );
    expect(r.error ?? null).toBeNull();
    expect(r.status).toBe('passed');
    // On the patients screen there is no Sign in button.
    const missing = await run(
      steps(
        {
          type: 'ui.fill',
          params: { value: 'nurse@careclinic.test' },
          locators: [{ strategy: 'testId', value: 'email' }],
        },
        {
          type: 'ui.fill',
          params: { value: 'CareClinic1' },
          locators: [{ strategy: 'testId', value: 'password' }],
        },
        { type: 'ui.click', locators: [{ strategy: 'testId', value: 'sign_in' }] },
        // Wait for the patients screen: until then the Sign in button is still on screen.
        {
          type: 'ui.assert',
          params: { check: 'visible' },
          locators: [{ strategy: 'testId', value: 'patient_count' }],
        },
        { type: 'ui.click', locators: [{ strategy: 'image', value: picture }], timeoutMs: 3000 },
      ),
    );
    expect(missing.status).toBe('failed');
    expect(missing.error).toMatch(/Tried: image \(needs 90%\) \(the picture's best match on screen: \d+%\)/);
  }, 600_000);
});
