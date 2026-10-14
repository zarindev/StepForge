import { DEFAULT_RUN_OPTIONS, newId, runTestCase, type StepInput } from '@stepforge/core';
import { utilExecutor } from '@stepforge/executor-util';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildMacDemo, MAC_DEMO_APP } from '../../../../scripts/build-macos-demo.ts';
import {
  AppiumServer,
  createNativeExecutor,
  macCapabilities,
  macQueries,
  pressShortcut,
  windowsCapabilities,
  windowsQueries,
  type WebDriverSession,
} from '../src/index.ts';

describe('macOS and Windows locators and launch settings', () => {
  it('maps locators to Mac2 and NovaWindows queries', () => {
    expect(macQueries({ strategy: 'testId', value: 'sign_in' })).toEqual([
      { using: 'accessibility id', value: 'sign_in' },
    ]);
    expect(macQueries({ strategy: 'role', value: 'button', name: 'Sign in' })).toEqual([
      {
        using: '-ios class chain',
        value:
          '**/XCUIElementTypeButton[`title == "Sign in" OR label == "Sign in" OR placeholderValue == "Sign in"`]',
      },
    ]);
    expect(macQueries({ strategy: 'placeholder', value: 'Email' })[0]!.value).toBe(
      'placeholderValue == "Email"',
    );
    expect(windowsQueries({ strategy: 'testId', value: 'sign_in' })).toEqual([
      { using: 'accessibility id', value: 'sign_in' },
    ]);
    expect(windowsQueries({ strategy: 'role', value: 'button', name: 'Sign in' })).toEqual([
      { using: 'xpath', value: "//Button[@Name='Sign in'] | //SplitButton[@Name='Sign in']" },
    ]);
    expect(windowsQueries({ strategy: 'text', value: 'Save' })[1]).toEqual({
      using: 'xpath',
      value: "//*[contains(@Name, 'Save')]",
    });
    expect(() => macQueries({ strategy: 'css', value: '#x' })).toThrow(/CSS locators work on web pages/);
    expect(() => windowsQueries({ strategy: 'role', value: 'banner' })).toThrow(/no Windows equivalent/);
  });

  it('builds capabilities: a bundle id or .app for macOS, an .exe or app id for Windows', () => {
    expect(macCapabilities({ bundleId: 'com.apple.TextEdit', arguments: ['-x'] })).toMatchObject({
      platformName: 'mac',
      'appium:automationName': 'Mac2',
      'appium:bundleId': 'com.apple.TextEdit',
      'appium:arguments': ['-x'],
    });
    expect(() => macCapabilities({})).toThrow(/bundle id or its .app path/);
    expect(
      windowsCapabilities({ app: 'Microsoft.WindowsCalculator_8wekyb3d8bbwe!App', arguments: '/x' }),
    ).toMatchObject({
      platformName: 'Windows',
      'appium:automationName': 'NovaWindows',
      'appium:app': 'Microsoft.WindowsCalculator_8wekyb3d8bbwe!App',
      'appium:appArguments': '/x',
    });
    expect(() => windowsCapabilities({ app: 'C:\\\\nope\\\\App.exe' })).toThrow(/was not found/);
  });

  it('presses shortcuts as W3C key actions: modifiers down, the key, modifiers up', async () => {
    const sent: unknown[] = [];
    const d = { actions: async (a: unknown[]) => void sent.push(...a) } as unknown as WebDriverSession;
    await pressShortcut(d, 'Control+Shift+S');
    expect(sent).toEqual([
      {
        type: 'key',
        id: 'keyboard',
        actions: [
          { type: 'keyDown', value: '\uE009' },
          { type: 'keyDown', value: '\uE008' },
          { type: 'keyDown', value: 'S' },
          { type: 'keyUp', value: 'S' },
          { type: 'keyUp', value: '\uE008' },
          { type: 'keyUp', value: '\uE009' },
        ],
      },
    ]);
    await expect(pressShortcut(d, 'Hyper+X')).rejects.toThrow(/Unknown key "Hyper"/);
  });
});

/** The same scenario for both desktop demo apps (CareClinic): sign in, add patients, menus, a shortcut, a dialog. */
function desktopSteps(platform: 'macos' | 'windows'): StepInput[] {
  const id = (value: string) => [{ strategy: 'testId' as const, value }];
  const count = (expected: string) => ({
    type: 'ui.assert',
    params: { check: 'text', expected },
    locators: id('patient_count'),
  });
  return [
    { type: 'ui.fill', params: { value: 'nurse@careclinic.test' }, locators: id('email') },
    { type: 'ui.fill', params: { value: 'CareClinic1' }, locators: id('password') },
    { type: 'ui.click', locators: [{ strategy: 'role', value: 'button', name: 'Sign in' }] },
    count('No patients yet'),
    // The menu's keyboard shortcut puts the cursor in the name field.
    { type: 'ui.press', params: { key: platform === 'macos' ? 'Meta+N' : 'Control+N' } },
    { type: 'ui.fill', params: { value: 'Ana Silva' }, locators: id('patient_name') },
    { type: 'ui.click', locators: id('add_patient') },
    count('1 patient'),
    { type: 'ui.menu', params: { path: 'Patients > Clear List' } },
    {
      type: 'ui.handleDialog',
      params: { action: 'accept', buttonLabel: platform === 'macos' ? 'Clear' : 'Yes' },
    },
    count('No patients yet'),
  ];
}

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
const TOOLS = resolve(fileURLToPath(new URL('../../../../data/tools', import.meta.url)));
const WIN_APP = fileURLToPath(new URL('../../../../demo/windows-app/build/CareClinic.exe', import.meta.url));

for (const platform of ['macos', 'windows'] as const) {
  const enabled =
    platform === 'macos' ? process.env.STEPFORGE_TEST_MACOS : process.env.STEPFORGE_TEST_WINDOWS;
  describe.skipIf(!enabled)(`${platform === 'macos' ? 'macOS' : 'Windows'} desktop app (CareClinic)`, () => {
    const appium = new AppiumServer(TOOLS);
    beforeAll(() => {
      if (platform === 'macos' && !existsSync(MAC_DEMO_APP)) buildMacDemo(() => {});
    });
    afterAll(() => appium.stop());
    const run = (s: ReturnType<typeof steps>) =>
      runTestCase({
        runId: 'R',
        steps: s,
        env: {},
        executors: [createNativeExecutor({ appiumUrl: () => appium.url() }), utilExecutor],
        options: {
          ...DEFAULT_RUN_OPTIONS,
          defaultTimeoutMs: 10_000,
          video: 'off',
          trace: 'off',
          screenshots: 'onFailure',
          ...(platform === 'macos' ? { macos: { appPath: MAC_DEMO_APP } } : { windows: { app: WIN_APP } }),
        },
        artifactsDir: mkdtempSync(join(tmpdir(), `sf-${platform}-`)),
      });

    it('signs in, adds a patient, uses a shortcut, a menu and a dialog', async () => {
      const r = await run(steps(...desktopSteps(platform)));
      expect(r.error ?? null).toBeNull();
      expect(r.status).toBe('passed');
    }, 900_000);

    it('the planted bug fails the test with the text the app showed', async () => {
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
          { type: 'ui.click', locators: [{ strategy: 'testId', value: 'sign_in' }] },
          {
            type: 'ui.fill',
            params: { value: 'Alexandra Johnson' },
            locators: [{ strategy: 'testId', value: 'patient_name' }],
          },
          { type: 'ui.click', locators: [{ strategy: 'testId', value: 'add_patient' }] },
          {
            type: 'ui.assert',
            params: { check: 'text', expected: 'Alexandra Johnson' },
            // Each row has the id patient_row.
            locators: [{ strategy: 'testId', value: 'patient_row' }],
            timeoutMs: 3000,
          },
        ),
      );
      expect(r.status).toBe('failed');
      expect(r.error).toContain('"Alexandra Jo"');
    }, 600_000);
  });
}
