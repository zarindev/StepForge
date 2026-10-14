import { execFile, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const exe = (name: string) => (process.platform === 'win32' ? `${name}.exe` : name);

/** The Android SDK: ANDROID_HOME, ANDROID_SDK_ROOT, or where Android Studio installs it. */
export function androidSdk(): string | undefined {
  const candidates = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    process.platform === 'darwin' && join(homedir(), 'Library', 'Android', 'sdk'),
    process.platform === 'win32' &&
      process.env.LOCALAPPDATA &&
      join(process.env.LOCALAPPDATA, 'Android', 'Sdk'),
    process.platform === 'linux' && join(homedir(), 'Android', 'Sdk'),
  ].filter((p): p is string => !!p);
  return candidates.find((p) => existsSync(join(p, 'platform-tools')) || existsSync(join(p, 'emulator')));
}

/** A Java (17 or newer) for the Android tools: JAVA_HOME, Android Studio's own, or the system one. */
export function javaHome(): string | undefined {
  const ok = (home: string | undefined) => !!home && existsSync(join(home, 'bin', exe('java')));
  if (ok(process.env.JAVA_HOME)) return process.env.JAVA_HOME;
  const studio = [
    '/Applications/Android Studio.app/Contents/jbr/Contents/Home',
    process.env.ProgramFiles && join(process.env.ProgramFiles, 'Android', 'Android Studio', 'jbr'),
    '/opt/android-studio/jbr',
    join(homedir(), 'android-studio', 'jbr'),
  ].find((p) => ok(p || undefined));
  if (studio) return studio;
  if (process.platform === 'darwin') {
    try {
      const home = execFileSync('/usr/libexec/java_home', ['-v', '17+'], {
        encoding: 'utf8',
        stdio: 'pipe',
      }).trim();
      if (ok(home)) return home;
    } catch {
      // no Java installed
    }
  }
  return undefined;
}

export const adbPath = (sdk: string) => join(sdk, 'platform-tools', exe('adb'));
export const emulatorPath = (sdk: string) => join(sdk, 'emulator', exe('emulator'));

/** The environment the Android tools (and Appium) need. */
export function androidEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  const sdk = androidSdk();
  const java = javaHome();
  if (sdk) env.ANDROID_HOME = env.ANDROID_SDK_ROOT = sdk;
  if (java) env.JAVA_HOME = java;
  return env;
}

/** Emulators (Android Virtual Devices) set up on this computer. */
export async function listAvds(): Promise<string[]> {
  const sdk = androidSdk();
  if (!sdk || !existsSync(emulatorPath(sdk))) return [];
  try {
    const { stdout } = await run(emulatorPath(sdk), ['-list-avds'], {
      env: { ...process.env, ...androidEnv() },
      timeout: 15_000,
    });
    return stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('INFO') && !l.includes(' '));
  } catch {
    return [];
  }
}

export type Device = { serial: string; state: string; model?: string; emulator: boolean };

/** Phones and running emulators that adb sees. */
export async function listDevices(): Promise<Device[]> {
  const sdk = androidSdk();
  if (!sdk || !existsSync(adbPath(sdk))) return [];
  try {
    const { stdout } = await run(adbPath(sdk), ['devices', '-l'], { timeout: 15_000 });
    return stdout
      .split(/\r?\n/)
      .slice(1)
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        const [serial, state, ...rest] = l.split(/\s+/);
        const model = rest.find((r) => r.startsWith('model:'))?.slice(6);
        return {
          serial: serial!,
          state: state!,
          ...(model && { model }),
          emulator: serial!.startsWith('emulator-'),
        };
      });
  } catch {
    return [];
  }
}

/** Runs adb against one device (or the only one). */
export async function adb(args: string[], serial?: string, timeoutMs = 30_000): Promise<string> {
  const sdk = androidSdk();
  if (!sdk) throw new Error('The Android SDK was not found');
  const { stdout } = await run(adbPath(sdk), [...(serial ? ['-s', serial] : []), ...args], {
    timeout: timeoutMs,
    maxBuffer: 32 * 1024 * 1024,
  });
  return stdout;
}
