import { existsSync } from 'node:fs';
import {
  adbPath,
  androidSdk,
  emulatorPath,
  javaHome,
  listAvds,
  listDevices,
  type Device,
} from './android.ts';
import {
  APPIUM_NODE_VERSION,
  APPIUM_VERSION,
  appiumInstalled,
  appiumPaths,
  installedDrivers,
  nodeOkForAppium,
} from './appium.ts';

export type DoctorCheck = { name: string; ok: boolean; detail: string; fix?: string };
export type NativeStatus = { ready: boolean; checks: DoctorCheck[]; avds: string[]; devices: Device[] };

const sdkCmd = (pkgs: string) => `sdkmanager ${pkgs} (in the Android SDK's cmdline-tools/latest/bin)`;

/** What testing Android apps needs on this computer, each with how to fix it. */
export async function nativeDoctor(toolsDir: string): Promise<NativeStatus> {
  const sdk = androidSdk();
  const java = javaHome();
  const [avds, devices] = await Promise.all([listAvds(), listDevices()]);
  const drivers = installedDrivers(toolsDir);
  const checks: DoctorCheck[] = [
    {
      name: 'Java 17 or newer',
      ok: !!java,
      detail: java ?? 'not found',
      fix: 'Install a JDK (for example Eclipse Temurin 21) or Android Studio, or set JAVA_HOME',
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
        sdkCmd('"emulator" "system-images;android-35;google_apis;arm64-v8a"') +
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
    {
      name: 'Appium and the Android driver',
      ok: appiumInstalled(toolsDir),
      detail: appiumInstalled(toolsDir)
        ? `Appium ${APPIUM_VERSION}, UiAutomator2 ${drivers.uiautomator2} in ${appiumPaths(toolsDir).root}` +
          (nodeOkForAppium() ? '' : ` (runs on its own Node.js ${APPIUM_NODE_VERSION})`)
        : 'not installed',
      fix: 'npm run appium:install, or Install Appium on an Android app’s Environments tab',
    },
  ];
  // The emulator check is optional when a phone is connected.
  const required = checks.filter((c) => c.name !== 'Android emulator');
  return { ready: required.every((c) => c.ok), checks, avds, devices };
}
