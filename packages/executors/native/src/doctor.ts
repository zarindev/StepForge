import { existsSync } from 'node:fs';
import {
  adbPath,
  androidSdk,
  emulatorPath,
  javaInfo,
  JAVA_MIN,
  listAvds,
  listDevices,
  type Device,
} from './android.ts';
import {
  APPIUM_NODE_VERSION,
  APPIUM_VERSION,
  appiumInstalled,
  appiumPaths,
  installedAppiumVersion,
  installedDrivers,
  nodeOkForAppium,
  wantedDrivers,
} from './appium.ts';
import { linuxChecks } from './linux.ts';
import { automationMode, listSimulators, xcodeSelected, xcodeVersion, type Simulator } from './ios.ts';
import { execFileSync } from 'node:child_process';

export type DoctorCheck = { name: string; ok: boolean; detail: string; fix?: string };
export type PlatformStatus = { ready: boolean; checks: DoctorCheck[] };
export type NativeStatus = {
  android: PlatformStatus;
  /** `supported` is false away from macOS: Apple's tools only run there. */
  ios: PlatformStatus & { supported: boolean };
  /** Native desktop apps: macOS (on a Mac) and Windows (on Windows). */
  macos: PlatformStatus & { supported: boolean };
  windows: PlatformStatus & { supported: boolean };
  linux: PlatformStatus & { supported: boolean };
  avds: string[];
  devices: Device[];
  simulators: Simulator[];
};

/** The emulator system image for this computer's processor (an arm64 image does not run on an x64 machine). */
export const emulatorImage = (arch: string = process.arch) =>
  `system-images;android-35;google_apis;${arch === 'arm64' ? 'arm64-v8a' : 'x86_64'}`;

const sdkCmd = (pkgs: string) => `sdkmanager ${pkgs} (in the Android SDK's cmdline-tools/latest/bin)`;
const APPIUM_FIX = 'npm run appium:install, or Install Appium on the application’s Environments tab';

function appiumCheck(
  toolsDir: string,
  driver: 'uiautomator2' | 'xcuitest' | 'mac2' | 'novawindows',
  label: string,
): DoctorCheck {
  const ok = appiumInstalled(toolsDir, driver);
  // The versions installed, and those StepForge pins (an older install still runs; the install updates it).
  const appium = installedAppiumVersion(toolsDir) ?? 'unknown';
  const installed = installedDrivers(toolsDir)[driver];
  const pinned = wantedDrivers().find((d) => d.name === driver)?.version;
  const outdated = [
    appium !== APPIUM_VERSION && `Appium ${APPIUM_VERSION}`,
    pinned && installed !== pinned && `the driver ${pinned}`,
  ].filter(Boolean);
  return {
    name: `Appium and the ${label} driver`,
    ok,
    detail: ok
      ? `Appium ${appium}, ${{ xcuitest: 'XCUITest', uiautomator2: 'UiAutomator2', mac2: 'Mac2', novawindows: 'NovaWindows' }[driver]} ${installed} in ${appiumPaths(toolsDir).root}` +
        (nodeOkForAppium() ? '' : ` (runs on its own Node.js ${APPIUM_NODE_VERSION})`) +
        (outdated.length
          ? ` (StepForge expects ${outdated.join(' and ')}: run npm run appium:install to update)`
          : '')
      : 'not installed',
    fix: APPIUM_FIX,
  };
}

/** What testing Android and iOS apps needs on this computer, each with how to fix it. */
export async function nativeDoctor(toolsDir: string): Promise<NativeStatus> {
  const sdk = androidSdk();
  const java = javaInfo();
  const [avds, devices] = await Promise.all([listAvds(), listDevices()]);
  const android: DoctorCheck[] = [
    {
      name: `Java ${JAVA_MIN} or newer`,
      ok: !!java.home,
      detail: java.home
        ? `Java ${java.version} at ${java.home}`
        : java.tooOld
          ? `Java ${java.tooOld.version ?? '(version unknown)'} at ${java.tooOld.home} is too old (needs ${JAVA_MIN}+)`
          : 'not found',
      fix: `Install a JDK ${JAVA_MIN}+ (for example Eclipse Temurin 21) or Android Studio, and set JAVA_HOME to it`,
    },
    {
      name: 'Android SDK',
      ok: !!sdk,
      detail: sdk ?? 'not found (ANDROID_HOME is not set and no SDK in the usual place)',
      fix: 'Install Android Studio, or the command-line tools from developer.android.com/studio, and set ANDROID_HOME',
    },
    {
      name: 'adb (platform-tools)',
      ok: !!sdk && existsSync(adbPath(sdk)),
      detail: sdk && existsSync(adbPath(sdk)) ? adbPath(sdk) : 'not installed',
      fix: sdkCmd('"platform-tools"'),
    },
    {
      name: 'Android emulator',
      ok: !!sdk && existsSync(emulatorPath(sdk)),
      detail:
        sdk && existsSync(emulatorPath(sdk))
          ? emulatorPath(sdk)
          : 'not installed (only needed without a phone)',
      fix:
        sdkCmd(`"emulator" "${emulatorImage()}"`) +
        ', then create a device with avdmanager or Android Studio',
    },
    {
      name: 'Emulators or phones',
      ok: avds.length > 0 || devices.some((d) => d.state === 'device'),
      detail:
        [
          avds.length ? `emulators: ${avds.join(', ')}` : '',
          devices.length ? `connected: ${devices.map((d) => `${d.serial} (${d.state})`).join(', ')}` : '',
        ]
          .filter(Boolean)
          .join(' · ') || 'none',
      fix: 'Create an emulator (Android Studio → Device Manager) or connect a phone with USB debugging on',
    },
    appiumCheck(toolsDir, 'uiautomator2', 'Android'),
  ];

  const mac = process.platform === 'darwin';
  const xcode = mac ? xcodeVersion() : undefined;
  const selected = mac ? xcodeSelected() : undefined;
  const simulators = mac ? listSimulators() : [];
  const ios: DoctorCheck[] = mac
    ? [
        {
          name: 'Xcode',
          ok: !!xcode,
          detail: xcode ?? 'not found',
          fix: 'Install Xcode from the App Store (free), open it once and add the iOS platform',
        },
        {
          name: 'Command-line tools use Xcode',
          ok: !!selected?.includes('.app/Contents/Developer'),
          detail: selected ?? 'not set',
          fix: 'sudo xcode-select -s /Applications/Xcode.app/Contents/Developer && sudo xcodebuild -runFirstLaunch',
        },
        {
          name: 'iOS simulators',
          ok: simulators.length > 0,
          detail: simulators.length
            ? `${simulators.length}: ${[...new Set(simulators.map((s) => s.name))].slice(0, 4).join(', ')}${simulators.length > 4 ? '…' : ''}`
            : 'none',
          fix: 'Xcode → Settings → Components → iOS (the simulator runtime)',
        },
        appiumCheck(toolsDir, 'xcuitest', 'iOS'),
      ]
    : [
        {
          name: 'macOS',
          ok: false,
          detail: `this computer runs ${process.platform}`,
          fix: 'iOS apps can only be tested from a Mac: Apple’s tools (Xcode, simulators) run only on macOS',
        },
      ];
  const automation = mac ? automationMode() : undefined;
  const macos: DoctorCheck[] = mac
    ? [
        {
          name: 'Xcode',
          ok: !!xcode,
          detail: xcode ?? 'not found',
          fix: 'Install Xcode from the App Store (free) and open it once',
        },
        {
          name: 'Automation Mode',
          ok: automation === 'enabled',
          detail:
            automation === 'enabled'
              ? 'ready: tests can drive apps without a password'
              : automation === 'needs-password'
                ? 'asks for your password each time'
                : 'off',
          fix: 'sudo automationmodetool enable-automationmode-without-authentication (once; lets tests drive apps on this Mac)',
        },
        appiumCheck(toolsDir, 'mac2', 'macOS'),
      ]
    : [
        {
          name: 'macOS',
          ok: false,
          detail: `this computer runs ${process.platform}`,
          fix: 'macOS apps can only be tested on a Mac',
        },
      ];
  const win = process.platform === 'win32';
  const powershell = win
    ? (() => {
        try {
          return execFileSync(
            'powershell.exe',
            ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()'],
            {
              encoding: 'utf8',
              timeout: 30_000,
            },
          ).trim();
        } catch {
          return undefined;
        }
      })()
    : undefined;
  const windows: DoctorCheck[] = win
    ? [
        {
          name: 'Windows PowerShell',
          ok: !!powershell,
          detail: powershell ? `PowerShell ${powershell}` : 'not found',
          fix: 'Windows PowerShell 5.1 comes with Windows 10 and 11; repair Windows if it is missing',
        },
        appiumCheck(toolsDir, 'novawindows', 'Windows'),
      ]
    : [
        {
          name: 'Windows',
          ok: false,
          detail: `this computer runs ${process.platform}`,
          fix: 'Windows apps can only be tested on Windows (10 or 11)',
        },
      ];
  const onLinux = process.platform === 'linux';
  const lx = linuxChecks();
  const linux: DoctorCheck[] = onLinux
    ? [
        {
          name: 'Python 3',
          ok: !!lx.python,
          detail: lx.python ?? 'not found',
          fix: 'sudo apt install python3 (or your distribution\u2019s package)',
        },
        {
          name: 'Accessibility for Python (PyGObject, AT-SPI)',
          ok: lx.atspi,
          detail: lx.atspi ? 'available' : 'missing',
          fix: 'sudo apt install python3-gi gir1.2-atspi-2.0 gir1.2-gtk-3.0 at-spi2-core',
        },
        {
          name: 'A display',
          ok: !!lx.display,
          detail: lx.display ?? 'none (no DISPLAY or WAYLAND_DISPLAY)',
          fix: 'Run StepForge in your desktop session, or on a server under a virtual display: xvfb-run -a',
        },
      ]
    : [
        {
          name: 'Linux',
          ok: false,
          detail: `this computer runs ${process.platform}`,
          fix: 'Linux desktop apps can only be tested on Linux',
        },
      ];
  // The emulator is optional when a phone is connected.
  const androidReady = android.filter((c) => c.name !== 'Android emulator').every((c) => c.ok);
  return {
    android: { ready: androidReady, checks: android },
    ios: { ready: ios.every((c) => c.ok), checks: ios, supported: mac },
    macos: { ready: macos.every((c) => c.ok), checks: macos, supported: mac },
    windows: { ready: windows.every((c) => c.ok), checks: windows, supported: win },
    linux: { ready: linux.every((c) => c.ok), checks: linux, supported: onLinux },
    avds,
    devices,
    simulators,
  };
}
