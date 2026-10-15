/**
 * Proves that the Appium and Maestro exports run (N7; StepForge by Md Zarin Tasnim). It exports a CareClinic suite for
 * a demo app — phone: sign in, add patients, gestures and device steps; desktop: sign in, add patients, a shortcut, a
 * menu and its dialog — installs each exported project's own dependencies and runs its tests against the app.
 *
 *   npx tsx scripts/verify-native-export.ts --platform android                 # Appium + pytest
 *   npx tsx scripts/verify-native-export.ts --platform ios --targets all       # every target whose tools exist
 *   npx tsx scripts/verify-native-export.ts --platform android --avd StepForge_Pixel --targets appium-ts,maestro
 *   npx tsx scripts/verify-native-export.ts --platform linux --targets appium-py,appium-ts,appium-java
 *
 * Android: an emulator must be running (or pass --avd to let Appium start one). iOS: a Mac with Xcode; --simulator
 * names the simulator (default: iPhone 17). macOS / Windows: the desktop demo app (built first), and the tests use
 * the mouse and keyboard. Linux: a display and the accessibility bus (CI: dbus-run-session + xvfb-run), through
 * StepForge's own helper. Appium is the one StepForge installs (`npm run appium:install`). Exits 1 if any exported
 * project fails; a target whose tool is missing (Python, Maven, Maestro) is reported as skipped, never as passed.
 */
import { generate, type CodegenInput, type CodegenStep, type TargetId } from '@stepforge/codegen';
import type { StepInput } from '@stepforge/core';
import { AppiumServer, androidEnv, LinuxHelper } from '@stepforge/executor-native';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { desktopSteps } from '../packages/executors/native/test/desktop-steps.ts';
import { gestureSteps } from '../packages/executors/native/test/gestures.ts';
import { buildMacDemo, MAC_DEMO_APP } from './build-macos-demo.ts';

const ROOT = resolve(import.meta.dirname, '..');
const { values } = parseArgs({
  options: {
    platform: { type: 'string', default: 'android' },
    targets: { type: 'string', default: 'appium-py' },
    avd: { type: 'string' },
    simulator: { type: 'string', default: 'iPhone 17' },
    // CI: a slow emulator or simulator now and then stalls a step; a failed project gets more attempts.
    attempts: { type: 'string', default: '1' },
    // The tests that sign in must fail (so passing results are not vacuous).
    'wrong-password': { type: 'boolean', default: false },
  },
});
// "auto": the first iPhone simulator Xcode has (CI runners come with several).
if (values.simulator === 'auto') {
  const { devices } = JSON.parse(
    spawnSync('xcrun', ['simctl', 'list', 'devices', 'available', '-j'], { encoding: 'utf8' }).stdout,
  ) as { devices: Record<string, { name: string }[]> };
  values.simulator =
    Object.values(devices)
      .flat()
      .find((d) => d.name.startsWith('iPhone'))?.name ?? 'iPhone';
  console.log(`Simulator: ${values.simulator}`);
}
const platform = values.platform as 'android' | 'ios' | 'macos' | 'windows' | 'linux' | 'electron';
if (!['android', 'ios', 'macos', 'windows', 'linux', 'electron'].includes(platform))
  throw new Error('--platform android, ios, macos, windows, linux or electron');
const phone = platform === 'android' || platform === 'ios';
const WIN_APP = join(ROOT, 'demo/windows-app/build/CareClinic.exe');
if (platform === 'macos' && !existsSync(MAC_DEMO_APP)) buildMacDemo(() => {});

const step = (s: StepInput): CodegenStep => ({
  ...s,
  params: s.params ?? {},
  locators: (s.locators ?? []) as CodegenStep['locators'],
  assertions: (s.assertions ?? []) as CodegenStep['assertions'],
});
const id = (value: string) => [{ strategy: 'testId' as const, value }];
const signIn: StepInput[] = [
  {
    type: 'ui.fill',
    params: { value: 'nurse@careclinic.test' },
    locators: phone ? [{ strategy: 'placeholder', value: 'Email' }] : id('email'),
  },
  { type: 'ui.fill', params: { value: '{{secret.nursePassword}}' }, locators: id('password') },
  { type: 'ui.click', locators: [{ strategy: 'role', value: 'button', name: 'Sign in' }] },
  {
    type: 'ui.assert',
    params: { check: 'text', expected: 'No patients yet' },
    locators: id('patient_count'),
  },
];

const LAUNCH: Record<typeof platform, Record<string, unknown>> = {
  android: { app: join(ROOT, 'demo/android-app/careclinic.apk'), ...(values.avd && { avd: values.avd }) },
  ios: { app: join(ROOT, 'demo/ios-app/build/CareClinic.app'), simulator: values.simulator },
  macos: { appPath: MAC_DEMO_APP },
  windows: { app: WIN_APP },
  linux: { app: 'python3', arguments: [join(ROOT, 'demo/linux-app/careclinic.py')] },
  electron: { appPath: join(ROOT, 'demo/desktop-app') },
};

/** The Electron demo (notes): the same steps as StepForge's own Electron test, plus test data. */
const css = (value: string) => [{ strategy: 'css' as const, value }];
const electronScenarios: CodegenInput['scenarios'] = [
  {
    id: 'e1',
    name: 'Add a note and open About',
    modulePath: ['Notes'],
    priority: 'P1',
    tags: ['smoke'],
    steps: (
      [
        {
          type: 'ui.fill',
          params: { value: 'Buy milk' },
          locators: [{ strategy: 'placeholder', value: 'Write a note' }],
        },
        { type: 'ui.click', locators: [{ strategy: 'testId', value: 'add-note' }] },
        {
          type: 'ui.assert',
          params: { check: 'text', expected: '1 note' },
          locators: [{ strategy: 'role', value: 'status' }],
        },
        { type: 'ui.assert', params: { check: 'title', expected: 'Notes' } },
        { type: 'ui.click', locators: css('#about') },
        { type: 'ui.switchTab', params: { urlContains: 'about.html' } },
        {
          type: 'ui.assert',
          params: { check: 'textContains', expected: 'demo desktop app' },
          locators: css('p'),
        },
      ] satisfies StepInput[]
    ).map(step),
    testCases: [],
  },
  {
    id: 'e2',
    name: 'Add notes from data',
    modulePath: ['Notes'],
    priority: 'P2',
    tags: [],
    steps: (
      [
        {
          type: 'ui.fill',
          params: { value: '{{data.note}}' },
          locators: [{ strategy: 'placeholder', value: 'Write a note' }],
        },
        { type: 'ui.click', locators: [{ strategy: 'testId', value: 'add-note' }] },
        {
          type: 'ui.assert',
          params: { check: 'text', expected: '1 note' },
          locators: [{ strategy: 'role', value: 'status' }],
        },
        {
          type: 'ui.assert',
          params: { check: 'visible' },
          locators: [{ strategy: 'text', value: '{{data.note}}' }],
        },
      ] satisfies StepInput[]
    ).map(step),
    testCases: [
      { code: 'TC-1', title: 'Milk', data: { note: 'Buy milk' } },
      { code: 'TC-2', title: 'Call', data: { note: 'Call the clinic' } },
    ],
  },
];

const input: CodegenInput = {
  application: { name: `CareClinic ${platform}`, slug: `careclinic-${platform}`, platform },
  environment: {
    name: 'Local',
    baseUrl: 'app://careclinic',
    variables: {},
    secretKeys: ['nursePassword'],
    launch: LAUNCH[platform],
  },
  connections: [],
  inboxes: [],
  scenarios:
    platform === 'electron'
      ? electronScenarios
      : [
          {
            id: 's1',
            name: 'Sign in and add a patient',
            modulePath: ['Patients'],
            priority: 'P1',
            tags: ['smoke'],
            steps: (
              [
                ...signIn,
                {
                  type: 'ui.fill',
                  params: { value: '{{data.name}}' },
                  locators: phone ? [{ strategy: 'placeholder', value: 'Patient name' }] : id('patient_name'),
                },
                {
                  type: 'ui.click',
                  locators: phone ? [{ strategy: 'text', value: 'Add patient' }] : id('add_patient'),
                },
                {
                  type: 'ui.assert',
                  params: { check: 'text', expected: '1 patient' },
                  locators: id('patient_count'),
                },
                {
                  type: 'ui.extract',
                  params: { from: 'text' },
                  locators: phone ? [{ strategy: 'text', value: '{{data.name}}' }] : id('patient_row'),
                  captureAs: 'added',
                },
                {
                  type: 'util.if',
                  params: {
                    condition: { value: '{{vars.added}}', operator: 'equals', expected: '{{data.name}}' },
                    steps: [{ type: 'util.log', params: { message: 'Added {{vars.added}}' } }],
                  },
                },
              ] satisfies StepInput[]
            ).map(step),
            testCases: [
              { code: 'TC-1', title: 'Short name', data: { name: 'Ana Silva' } },
              { code: 'TC-2', title: 'Another name', data: { name: 'Ben Okafor' } },
            ],
          },
          phone
            ? {
                id: 's2',
                name: 'Gestures and device steps',
                modulePath: ['Patients'],
                priority: 'P2',
                tags: [],
                steps: gestureSteps(platform).map(step),
                testCases: [],
              }
            : {
                id: 's2',
                name: 'Menus, shortcuts and dialogs',
                modulePath: ['Patients'],
                priority: 'P2',
                tags: [],
                steps: desktopSteps(platform)
                  .map((x) =>
                    // The password as a secret, as in the phone suite.
                    x.locators?.[0]?.value === 'password'
                      ? { ...x, params: { value: '{{secret.nursePassword}}' } }
                      : x,
                  )
                  .map(step),
                testCases: [],
              },
        ],
  blocks: {},
  library: {},
  author: 'Md Zarin Tasnim',
  generatedAt: new Date().toISOString(),
};

/** The booted simulator with that name (Maestro takes a device id). */
function simulatorUdid(): string {
  const { devices } = JSON.parse(
    spawnSync('xcrun', ['simctl', 'list', 'devices', 'booted', '-j'], { encoding: 'utf8' }).stdout,
  ) as { devices: Record<string, { name: string; udid: string }[]> };
  const sim = Object.values(devices)
    .flat()
    .find((d) => d.name === values.simulator);
  if (!sim) throw new Error(`Boot the "${values.simulator}" simulator first`);
  return sim.udid;
}

const PYTHON = process.platform === 'win32' ? 'python' : 'python3';
const venv = (dir: string) => join(dir, '.venv', process.platform === 'win32' ? 'Scripts' : 'bin');
type Runner = { tool: string[]; steps: (dir: string) => [string, string[]][] };
const RUNNERS: Partial<Record<TargetId, Runner>> = {
  // Electron: the Playwright export starts the app itself (no Appium).
  'playwright-ts': {
    tool: ['npm'],
    steps: () => [
      ['npm', ['install', '--no-audit', '--no-fund']],
      ['npx', ['playwright', 'test']],
    ],
  },
  // MAESTRO: a Maestro outside the PATH. Maestro installs nothing: the app goes on the device first.
  maestro: {
    tool: [process.env.MAESTRO ?? 'maestro'],
    steps: () => [
      platform === 'android'
        ? [
            join(androidEnv().ANDROID_HOME ?? '', 'platform-tools', 'adb'),
            ['install', '-r', join(ROOT, 'demo/android-app/careclinic.apk')],
          ]
        : ['xcrun', ['simctl', 'install', simulatorUdid(), join(ROOT, 'demo/ios-app/build/CareClinic.app')]],
      // On the device under test (an emulator and several simulators may be running).
      [
        process.env.MAESTRO ?? 'maestro',
        [
          'test',
          ...(platform === 'ios' ? ['--device', simulatorUdid()] : ['--platform', 'android']),
          '-e',
          'APP_ID=com.stepforge.careclinic',
          'flows',
        ],
      ],
    ],
  },
  // MVN: a Maven outside the PATH.
  'appium-java': {
    tool: [process.env.MVN ?? 'mvn'],
    steps: () => [[process.env.MVN ?? 'mvn', ['-B', '-q', 'test']]],
  },
  'appium-ts': {
    tool: ['npm'],
    steps: () => [
      ['npm', ['install', '--no-audit', '--no-fund']],
      ['npx', ['tsc', '--noEmit', '-p', '.']],
      ['npm', ['test']],
    ],
  },
  'appium-py': {
    tool: [PYTHON],
    steps: (d) => [
      [PYTHON, ['-m', 'venv', '.venv']],
      [join(venv(d), 'pip'), ['install', '-q', '-r', 'requirements.txt']],
      [join(venv(d), 'python'), ['-m', 'pytest', '-q']],
    ],
  },
};

const has = (tool: string) =>
  spawnSync(tool, ['--version'], { stdio: 'ignore', shell: process.platform === 'win32' }).status === 0;

function run(cmd: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((done) => {
    console.log(`  $ ${cmd} ${args.join(' ')}`);
    const p = spawn(cmd, args, { cwd, env, stdio: 'inherit', shell: process.platform === 'win32' });
    p.on('exit', (code) => done(code ?? 1));
  });
}

const wanted = (
  platform === 'electron'
    ? ['playwright-ts']
    : values.targets === 'all'
      ? Object.keys(RUNNERS).filter((t) => t !== 'playwright-ts')
      : values.targets!.split(',')
) as TargetId[];
// Linux apps go through StepForge's own helper (Appium has no Linux driver); Electron apps need no server.
const server =
  platform === 'electron'
    ? { url: async () => '', stop: async () => {} }
    : platform === 'linux'
      ? new LinuxHelper()
      : new AppiumServer(join(ROOT, 'data/tools'));
const url = await server.url();
if (url) console.log(`${platform === 'linux' ? 'Linux helper' : 'Appium'} at ${url}`);
const results: [string, string][] = [];
try {
  for (const target of wanted) {
    const runner = RUNNERS[target];
    if (!runner) throw new Error(`No runner for ${target}`);
    if (target === 'maestro' && !phone) {
      results.push([target, 'skipped (Maestro is for Android and iOS apps)']);
      continue;
    }
    const missing = runner.tool.filter((t) => !has(t));
    if (missing.length) {
      results.push([target, `skipped (${missing.join(', ')} not installed)`]);
      continue;
    }
    const project = await generate(input, { target, ci: ['github'] });
    const dir = mkdtempSync(join(tmpdir(), `sf-native-${target}-`));
    for (const [path, content] of Object.entries(project.files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), content);
    }
    console.log(`\n${target} → ${dir} (${project.warnings.length} warnings)`);
    for (const w of project.warnings) console.log(`  ! ${w.scenario ?? ''} ${w.step ?? ''}: ${w.message}`);
    const env = {
      ...process.env,
      ...androidEnv(),
      APPIUM_URL: url,
      NURSE_PASSWORD: values['wrong-password'] ? 'Wrong1' : 'CareClinic1',
      MAESTRO_NURSE_PASSWORD: values['wrong-password'] ? 'Wrong1' : 'CareClinic1',
      MAESTRO_CLI_NO_ANALYTICS: '1',
    };
    // A fresh install: iOS keeps an app's notification permission when Appium installs over it, and the
    // gestures test answers the permission dialog.
    if (platform === 'ios')
      spawnSync('xcrun', ['simctl', 'uninstall', values.simulator!, 'com.stepforge.careclinic'], {
        stdio: 'ignore',
      });
    let code = 0;
    for (let attempt = 1; attempt <= Number(values.attempts); attempt++) {
      if (attempt > 1) console.log(`  (attempt ${attempt})`);
      for (const [cmd, args] of runner.steps(dir)) {
        code = await run(cmd, args, dir, env);
        if (code) break;
      }
      if (!code) break;
    }
    results.push([
      target,
      values['wrong-password']
        ? code
          ? 'failed as expected with a wrong password'
          : `FAILED: passed with a wrong password — ${dir}`
        : code
          ? `FAILED (exit ${code}) — ${dir}`
          : 'passed',
    ]);
  }
} finally {
  await server.stop();
}
console.log('\nResults:');
for (const [t, r] of results) console.log(`  ${t}: ${r}`);
process.exit(results.some(([, r]) => r.startsWith('FAILED')) ? 1 : 0);
