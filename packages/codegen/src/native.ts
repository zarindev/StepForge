import { readFileSync } from 'node:fs';
import { CREDIT, envEntries, ghVar, yamlStr } from './common.ts';
import type { Plan } from './ir.ts';
import type { AppPlatform, CiProvider } from './types.ts';
import { envName, val, type Val } from './values.ts';

/**
 * What the Appium and Maestro exports share: the Appium capabilities made from the environment's launch settings
 * (as StepForge starts the app), how to set up the drivers, and CI workflows per platform.
 */
export const PLATFORM_NAMES: Record<AppPlatform, string> = {
  android: 'Android',
  ios: 'iOS',
  macos: 'macOS',
  windows: 'Windows',
  linux: 'Linux',
};

/** The capability that names the app file, overridden by the APP environment variable. */
export const APP_KEY: Record<AppPlatform, string> = {
  android: 'appium:app',
  ios: 'appium:app',
  macos: 'appium:appPath',
  windows: 'appium:app',
  linux: 'stepforge:app',
};

type Launch = Record<string, unknown>;
const isObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v : undefined);

/** The capabilities StepForge's runner uses for this platform, minus what only its own tooling needs. */
export function capabilities(platform: AppPlatform, launch: Launch = {}): Val {
  const extra = (launch.capabilities as Record<string, unknown> | undefined) ?? {};
  const reset = launch.resetApp !== false;
  let caps: Record<string, unknown>;
  switch (platform) {
    case 'android':
      caps = {
        platformName: 'Android',
        'appium:automationName': 'UiAutomator2',
        ...(text(launch.app) && { 'appium:app': launch.app }),
        ...(text(launch.app) && reset && { 'appium:enforceAppInstall': true }),
        ...(text(launch.appPackage) && { 'appium:appPackage': launch.appPackage }),
        ...(text(launch.appActivity) && { 'appium:appActivity': launch.appActivity }),
        ...(text(launch.avd) && {
          'appium:avd': launch.avd,
          'appium:avdLaunchTimeout': 300_000,
          'appium:avdReadyTimeout': 300_000,
        }),
        ...(text(launch.udid) && { 'appium:udid': launch.udid }),
        'appium:noReset': !reset,
        'appium:autoGrantPermissions': true,
        'appium:disableWindowAnimation': true,
        'appium:newCommandTimeout': 300,
        'appium:uiautomator2ServerInstallTimeout': 120_000,
        'appium:adbExecTimeout': 60_000,
      };
      break;
    case 'ios':
      caps = {
        platformName: 'iOS',
        'appium:automationName': 'XCUITest',
        ...(text(launch.app) && { 'appium:app': launch.app }),
        ...(text(launch.app) && reset && { 'appium:enforceAppInstall': true }),
        ...(text(launch.bundleId) && { 'appium:bundleId': launch.bundleId }),
        // A simulator by name; StepForge picks the first iPhone simulator when none is set.
        'appium:deviceName': text(launch.simulator) ?? 'iPhone 16',
        ...(text(launch.platformVersion) && { 'appium:platformVersion': launch.platformVersion }),
        ...(text(launch.udid) && { 'appium:udid': launch.udid }),
        'appium:noReset': !reset,
        'appium:isHeadless': launch.showSimulator !== true,
        'appium:newCommandTimeout': 300,
        // The first test builds Appium's helper app (WebDriverAgent) with Xcode: allow minutes.
        'appium:wdaLaunchTimeout': 600_000,
        'appium:wdaConnectionTimeout': 600_000,
        'appium:simulatorStartupTimeout': 300_000,
        'appium:waitForIdleTimeout': 1,
        'appium:animationCoolOffTimeout': 0,
        'appium:reduceMotion': true,
      };
      break;
    case 'macos':
      caps = {
        platformName: 'mac',
        'appium:automationName': 'Mac2',
        ...(text(launch.bundleId) && { 'appium:bundleId': launch.bundleId }),
        ...(text(launch.appPath) && { 'appium:appPath': launch.appPath }),
        ...(Array.isArray(launch.arguments) &&
          launch.arguments.length > 0 && { 'appium:arguments': launch.arguments }),
        ...(isObject(launch.environment) &&
          Object.keys(launch.environment).length > 0 && { 'appium:environment': launch.environment }),
        'appium:newCommandTimeout': 300,
        'appium:serverStartupTimeout': 600_000,
      };
      break;
    case 'windows':
      caps = {
        platformName: 'Windows',
        'appium:automationName': 'NovaWindows',
        'appium:app': launch.app ?? '',
        ...(text(launch.arguments) && { 'appium:appArguments': launch.arguments }),
        ...(text(launch.workingDir) && { 'appium:appWorkingDir': launch.workingDir }),
        'appium:newCommandTimeout': 300,
        'ms:waitForAppLaunch': 15,
        'appium:shouldCloseApp': true,
      };
      break;
    case 'linux':
      caps = {
        platformName: 'linux',
        'stepforge:app': launch.app ?? '',
        'stepforge:arguments': Array.isArray(launch.arguments) ? launch.arguments : [],
        'stepforge:environment': launch.environment ?? {},
        ...(text(launch.workingDir) && { 'stepforge:workingDir': launch.workingDir }),
      };
      break;
  }
  return val({ ...caps, ...(platform === 'linux' ? {} : extra) });
}

/** Commands that install what the tests need on the computer that runs them. */
export function driverSetup(platform: AppPlatform): string[] {
  switch (platform) {
    case 'android':
      return [
        'npm install -g appium && appium driver install uiautomator2   # Appium and its Android driver',
        'appium &                                                      # start Appium (or run it in another terminal)',
      ];
    case 'ios':
      return [
        'npm install -g appium && appium driver install xcuitest       # on a Mac with Xcode',
        'appium &',
      ];
    case 'macos':
      return [
        'npm install -g appium && appium driver install mac2           # on a Mac with Xcode',
        'sudo automationmodetool enable-automationmode-without-authentication',
        'appium &',
      ];
    case 'windows':
      return [
        'npm install -g appium',
        'appium driver install --source=npm appium-novawindows-driver',
        'start appium                                                  # Windows 10 or 11',
      ];
    case 'linux':
      return [
        'sudo apt install python3-gi gir1.2-atspi-2.0 gir1.2-gtk-3.0 at-spi2-core   # Ubuntu / Debian',
        "python3 tools/stepforge_atspi.py --port 4723 &               # StepForge's helper, in the desktop session",
      ];
  }
}

export function nativeNotes(platform: AppPlatform): string[] {
  return [
    `Elements are found as StepForge finds them in ${PLATFORM_NAMES[platform]} apps: each step lists its Appium selectors, best first, and every lookup and check waits up to 30 s.`,
    ...(platform === 'linux'
      ? [
          "Appium has no Linux driver: `tools/stepforge_atspi.py` is StepForge's own helper (open source, part of StepForge), which speaks the same WebDriver protocol through the AT-SPI accessibility layer. On a server, run it in a D-Bus session on a virtual display: `dbus-run-session -- xvfb-run -a sh -c 'python3 tools/stepforge_atspi.py --port 4723 & sleep 2; <test command>'`.",
        ]
      : []),
    ...(platform === 'macos' || platform === 'windows' || platform === 'linux'
      ? ["Desktop tests use the computer's mouse and keyboard while they run."]
      : []),
    'Set `APP` to test another build than the one named in the capabilities (an absolute path is safest).',
  ];
}

/** StepForge's Linux helper, shipped inside Linux exports (Appium has no Linux driver). */
export const linuxHelper = () =>
  readFileSync(new URL('../../executors/native/linux/stepforge_atspi.py', import.meta.url), 'utf8');

export type NativeLang = { setup: string[]; test: string };

export const GITLAB_NATIVE = {
  message:
    'GitLab CI is not generated for phone and desktop apps (its shared runners have no emulator, simulator or desktop session); the GitHub Actions workflow is',
};

/** A GitHub Actions workflow that starts an emulator, simulator or desktop session, the driver, then the tests. */
export function nativeCi(
  plan: Plan,
  platform: AppPlatform,
  lang: NativeLang,
  providers: CiProvider[] = [],
  appium = true,
): Record<string, string> {
  if (!providers.includes('github')) return {};
  const env = envEntries(plan);
  const isSecret = (k: string) => plan.secrets.some((s) => envName(s) === k) || k.startsWith('DB_');
  const runner = {
    android: 'ubuntu-latest',
    ios: 'macos-latest',
    macos: 'macos-latest',
    windows: 'windows-latest',
    linux: 'ubuntu-latest',
  }[platform];
  const driver = {
    android: 'uiautomator2',
    ios: 'xcuitest',
    macos: 'mac2',
    windows: '--source=npm appium-novawindows-driver',
    linux: '',
  }[platform];
  const startAppium =
    platform === 'windows'
      ? [
          '      - name: Start Appium',
          '        shell: pwsh',
          '        run: |',
          '          Start-Process -FilePath appium.cmd -RedirectStandardOutput appium.log -WindowStyle Hidden',
          '          for ($i = 0; $i -lt 60; $i++) { try { Invoke-WebRequest http://127.0.0.1:4723/status -UseBasicParsing | Out-Null; break } catch { Start-Sleep 1 } }',
        ]
      : [
          '      - name: Start Appium',
          '        run: |',
          '          nohup appium > appium.log 2>&1 &',
          '          for i in $(seq 1 60); do curl -sf http://127.0.0.1:4723/status > /dev/null && break; sleep 1; done',
        ];
  const appiumSteps = appium
    ? [
        '      - uses: actions/setup-node@v4',
        '        with:',
        '          node-version: 22',
        `      - run: npm install -g appium && appium driver install ${driver}`,
        ...startAppium,
      ]
    : [];
  const test =
    platform === 'android'
      ? [
          '      - name: Enable KVM',
          '        run: |',
          `          echo 'KERNEL=="kvm", GROUP="kvm", MODE="0666", OPTIONS+="static_node=kvm"' | sudo tee /etc/udev/rules.d/99-kvm4all.rules`,
          '          sudo udevadm control --reload-rules',
          '          sudo udevadm trigger --name-match=kvm',
          '      - uses: reactivecircus/android-emulator-runner@v2',
          '        with:',
          '          api-level: 35',
          '          arch: x86_64',
          '          target: google_apis',
          '          emulator-options: -no-window -gpu swiftshader_indirect -noaudio -no-boot-anim -camera-back none',
          '          disable-animations: true',
          `          script: ${lang.test}`,
        ]
      : platform === 'linux'
        ? [
            '      - run: sudo apt-get update && sudo apt-get install -y python3-gi gir1.2-gtk-3.0 gir1.2-atspi-2.0 at-spi2-core xvfb dbus-x11',
            `      - run: dbus-run-session -- xvfb-run -a sh -c 'python3 tools/stepforge_atspi.py --port 4723 & sleep 3; ${lang.test}'`,
          ]
        : [
            ...(platform === 'macos'
              ? ['      - run: sudo automationmodetool enable-automationmode-without-authentication']
              : []),
            `      - run: ${lang.test}`,
          ];
  return {
    '.github/workflows/stepforge-tests.yml': [
      `# ${CREDIT}`,
      `name: ${yamlStr(`${plan.input.application.name} tests (${PLATFORM_NAMES[platform]})`)}`,
      'on:',
      '  push:',
      '  workflow_dispatch:',
      'jobs:',
      '  tests:',
      `    runs-on: ${runner}`,
      '    env:',
      ...env.map((e) =>
        isSecret(e.key)
          ? `      ${e.key}: \${{ secrets.${e.key} }}`
          : `      ${e.key}: ${ghVar(e.key, e.value)}`,
      ),
      '    steps:',
      '      - uses: actions/checkout@v4',
      '      # Build or download the app here, and set APP (a repository variable) to its path.',
      ...lang.setup,
      ...appiumSteps,
      ...test,
      '',
    ].join('\n'),
  };
}
