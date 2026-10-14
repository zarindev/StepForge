import { execFileSync } from 'node:child_process';

const run = (cmd: string, args: string[]): string | undefined => {
  if (process.platform !== 'darwin') return undefined;
  try {
    return execFileSync(cmd, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120_000,
      // The simulator list is large when many iOS versions are installed (CI machines).
      maxBuffer: 256 * 1024 * 1024,
    }).trim();
  } catch {
    return undefined;
  }
};

/** "Xcode 27.0" when Xcode is installed and selected, else undefined. */
export function xcodeVersion(): string | undefined {
  return run('xcodebuild', ['-version'])?.split('\n')[0];
}

/** Where the command-line developer tools point (Xcode's folder, or the stand-alone command-line tools). */
export function xcodeSelected(): string | undefined {
  return run('xcode-select', ['-p']);
}

/** Whether macOS lets automation (XCTest) drive apps without asking for a password each time. */
export function automationMode(): 'enabled' | 'needs-password' | 'disabled' | undefined {
  if (process.platform !== 'darwin') return undefined;
  try {
    const out = execFileSync('automationmodetool', [], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 15_000,
    });
    // "Enabled", or "disabled, does not require user authentication" (XCTest turns it on when a test starts): both
    // let tests run without a password prompt.
    if (/does not require user authentication/i.test(out)) return 'enabled';
    if (/requires user authentication/i.test(out)) return 'needs-password';
    return /Automation Mode is enabled/i.test(out) ? 'enabled' : 'disabled';
  } catch {
    return undefined;
  }
}

export type Simulator = { udid: string; name: string; runtime: string; state: string };

let lastSimulators: Simulator[] = [];

/** iOS simulators available on this Mac, booted ones first, newest iOS first. */
export function listSimulators(): Simulator[] {
  // simctl can be slow while a simulator is busy: try twice, and keep the last good list.
  const json =
    run('xcrun', ['simctl', 'list', 'devices', 'available', '-j']) ??
    run('xcrun', ['simctl', 'list', 'devices', 'available', '-j']);
  if (!json) return lastSimulators;
  try {
    const { devices } = JSON.parse(json) as {
      devices: Record<string, { udid: string; name: string; state: string }[]>;
    };
    return (lastSimulators = Object.entries(devices)
      .filter(([runtime]) => runtime.includes('.iOS-'))
      .flatMap(([runtime, list]) =>
        list.map((d) => ({
          udid: d.udid,
          name: d.name,
          state: d.state,
          runtime: runtime.split('.').pop()!.replace(/^iOS-/, 'iOS ').replace(/-/g, '.'),
        })),
      )
      .sort(
        (a, b) =>
          Number(b.state === 'Booted') - Number(a.state === 'Booted') ||
          b.runtime.localeCompare(a.runtime, undefined, { numeric: true }),
      ));
  } catch {
    return [];
  }
}
