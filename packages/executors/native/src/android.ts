import { execFile, execFileSync, spawnSync } from 'node:child_process';
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

/** The major version in `java -version`'s output: 'version "17.0.2"' → 17, 'version "1.8.0_392"' → 8. */
export function parseJavaMajor(output: string): number | undefined {
  const m = /version "(\d+)(?:\.(\d+))?/.exec(output);
  if (!m) return undefined;
  const major = Number(m[1]);
  return major === 1 && m[2] ? Number(m[2]) : major;
}

const javaVersions = new Map<string, number | undefined>();

/** The major version of the Java in a JDK folder (asked once per folder), or undefined when it does not run. */
export function javaVersion(home: string): number | undefined {
  if (javaVersions.has(home)) return javaVersions.get(home);
  let v: number | undefined;
  try {
    // java -version prints to stderr.
    const r = spawnSync(join(home, 'bin', exe('java')), ['-version'], { encoding: 'utf8', timeout: 15_000 });
    v = parseJavaMajor(`${r.stderr ?? ''}\n${r.stdout ?? ''}`);
  } catch {
    v = undefined;
  }
  javaVersions.set(home, v);
  return v;
}

/** The Android tools (and Appium's Android driver) need Java 17 or newer. */
export const JAVA_MIN = 17;

/** Where to look for a Java, best first: JAVA_HOME, Android Studio's own, the system one (asked only if needed). */
function* javaCandidates(): Generator<string> {
  const has = (p: string | undefined | false): p is string => !!p && existsSync(join(p, 'bin', exe('java')));
  for (const p of [
    process.env.JAVA_HOME,
    '/Applications/Android Studio.app/Contents/jbr/Contents/Home',
    process.env.ProgramFiles && join(process.env.ProgramFiles, 'Android', 'Android Studio', 'jbr'),
    '/opt/android-studio/jbr',
    join(homedir(), 'android-studio', 'jbr'),
  ])
    if (has(p)) yield p;
  if (process.platform === 'darwin') {
    try {
      const home = execFileSync('/usr/libexec/java_home', ['-v', `${JAVA_MIN}+`], {
        encoding: 'utf8',
        stdio: 'pipe',
      }).trim();
      if (has(home)) yield home;
    } catch {
      // no Java installed
    }
  }
}

/** A Java (17 or newer) for the Android tools: JAVA_HOME, Android Studio's own, or the system one. */
export function javaHome(): string | undefined {
  for (const home of javaCandidates()) if ((javaVersion(home) ?? 0) >= JAVA_MIN) return home;
  return undefined;
}

/** The Java the Android tools use and its version; else the first one found, which is too old. */
export function javaInfo(): { home?: string; version?: number; tooOld?: { home: string; version?: number } } {
  const home = javaHome();
  if (home) return { home, version: javaVersion(home) };
  const old = javaCandidates().next().value as string | undefined;
  return old ? { tooOld: { home: old, version: javaVersion(old) } } : {};
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
