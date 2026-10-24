import { DEFAULT_RUN_OPTIONS, newId, runTestCase, type StepInput } from '@stepforge/core';
import { utilExecutor } from '@stepforge/executor-util';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { desktopScreenTests } from './desktop-screens.ts';
import {
  createNativeExecutor,
  hasFfmpeg,
  linuxCapabilities,
  linuxPlatform,
  linuxQueries,
  LinuxHelper,
  LINUX_HELPER,
} from '../src/index.ts';
import { existsSync } from 'node:fs';

describe('Linux locators and launch settings', () => {
  it('maps locators to the AT-SPI helper and builds its capabilities', () => {
    expect(linuxQueries({ strategy: 'testId', value: 'sign_in' })).toEqual([
      { using: 'accessibility id', value: 'sign_in' },
    ]);
    expect(linuxQueries({ strategy: 'role', value: 'button', name: 'Sign in' })).toEqual([
      { using: 'xpath', value: "//push_button[@name='Sign in']" },
      { using: 'xpath', value: "//toggle_button[@name='Sign in']" },
    ]);
    expect(linuxQueries({ strategy: 'text', value: 'Save' })[1]).toEqual({
      using: 'partial name',
      value: 'Save',
    });
    expect(() => linuxQueries({ strategy: 'css', value: '#x' })).toThrow(/CSS locators work on web pages/);
    expect(linuxCapabilities({ app: 'gnome-calculator', arguments: ['--mode=basic'] })).toEqual({
      platformName: 'linux',
      'stepforge:app': 'gnome-calculator',
      'stepforge:arguments': ['--mode=basic'],
      'stepforge:environment': {},
    });
    expect(() => linuxCapabilities({})).toThrow(/command or path/);
    expect(existsSync(LINUX_HELPER)).toBe(true);
  });
});

/** On Linux with a display and the accessibility bus: STEPFORGE_TEST_LINUX=1 (CI: dbus-run-session + xvfb-run). */
const DEMO = fileURLToPath(new URL('../../../../demo/linux-app/careclinic.py', import.meta.url));
describe.skipIf(!process.env.STEPFORGE_TEST_LINUX)('Linux desktop app (CareClinic, GTK)', () => {
  const helper = new LinuxHelper();
  afterAll(() => helper.stop());
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
  const run = (s: ReturnType<typeof steps>) =>
    runTestCase({
      runId: 'R',
      steps: s,
      env: {},
      executors: [createNativeExecutor({ appiumUrl: () => helper.url() }), utilExecutor],
      options: {
        ...DEFAULT_RUN_OPTIONS,
        defaultTimeoutMs: 20_000,
        video: 'off',
        trace: 'off',
        screenshots: 'onFailure',
        linux: { app: 'python3', arguments: [DEMO] },
      },
      artifactsDir: mkdtempSync(join(tmpdir(), 'sf-linux-')),
    });
  const id = (value: string) => [{ strategy: 'testId' as const, value }];
  const count = (expected: string) => ({
    type: 'ui.assert',
    params: { check: 'text', expected },
    locators: id('patient_count'),
  });
  const signIn: StepInput[] = [
    { type: 'ui.fill', params: { value: 'nurse@careclinic.test' }, locators: id('email') },
    { type: 'ui.fill', params: { value: 'CareClinic1' }, locators: id('password') },
    { type: 'ui.click', locators: [{ strategy: 'role', value: 'button', name: 'Sign in' }] },
  ];

  // Recording, a manual session and visual checkpoints, as the dashboard uses them (CI installs ffmpeg).
  desktopScreenTests({
    name: 'Linux',
    platform: () => linuxPlatform({ app: 'python3', arguments: [DEMO] }),
    url: () => helper.url(),
    launch: { linux: { app: 'python3', arguments: [DEMO] } },
    video: hasFfmpeg(),
  });

  it("keeps the app's output as its log and records the screen with ffmpeg", async () => {
    const r = await runTestCase({
      runId: 'R',
      steps: steps(...signIn, count('No patients yet')),
      env: {},
      executors: [createNativeExecutor({ appiumUrl: () => helper.url() }), utilExecutor],
      options: {
        ...DEFAULT_RUN_OPTIONS,
        defaultTimeoutMs: 20_000,
        video: 'always',
        captureLogs: true,
        trace: 'off',
        linux: { app: 'python3', arguments: [DEMO] },
      },
      artifactsDir: mkdtempSync(join(tmpdir(), 'sf-linux-log-')),
    });
    expect(r.status).toBe('passed');
    const consoleLog = r.artifacts.find((a) => a.kind === 'console');
    expect(consoleLog).toBeDefined();
    const lines = JSON.parse(readFileSync(consoleLog!.path, 'utf8')) as { text: string }[];
    expect(lines.map((l) => l.text)).toContain('Signed in as nurse@careclinic.test');
    if (hasFfmpeg()) expect(r.artifacts.some((a) => a.kind === 'video')).toBe(true);
  }, 300_000);

  it('signs in, adds a patient, uses a menu and its dialog', async () => {
    const r = await run(
      steps(
        ...signIn,
        count('No patients yet'),
        { type: 'ui.fill', params: { value: 'Ana Silva' }, locators: id('patient_name') },
        { type: 'ui.click', locators: id('add_patient') },
        count('1 patient'),
        { type: 'ui.menu', params: { path: 'Patients > Clear List' } },
        { type: 'ui.handleDialog', params: { action: 'accept', buttonLabel: 'Clear' } },
        count('No patients yet'),
      ),
    );
    expect(
      r.error ?? null,
      r.steps.map((s) => `${s.type} ${s.status} ${s.message ?? ''}`).join(' / '),
    ).toBeNull();
    expect(r.status).toBe('passed');
  }, 300_000);

  it('the planted bug fails the test with the text the app showed', async () => {
    const r = await run(
      steps(
        ...signIn,
        { type: 'ui.fill', params: { value: 'Alexandra Johnson' }, locators: id('patient_name') },
        { type: 'ui.click', locators: id('add_patient') },
        {
          type: 'ui.assert',
          params: { check: 'text', expected: 'Alexandra Johnson' },
          locators: id('patient_row'),
          timeoutMs: 5000,
        },
      ),
    );
    expect(r.status).toBe('failed');
    expect(r.error).toContain('"Alexandra Jo"');
  }, 300_000);
});
