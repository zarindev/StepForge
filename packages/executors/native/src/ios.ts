import { execFileSync } from 'node:child_process';

const run = (cmd: string, args: string[]): string | undefined => {
  if (process.platform !== 'darwin') return undefined;
  try {
    return execFileSync(cmd, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
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

export type Simulator = { udid: string; name: string; runtime: string; state: string };

/** iOS simulators available on this Mac, booted ones first, newest iOS first. */
export function listSimulators(): Simulator[] {
  const json = run('xcrun', ['simctl', 'list', 'devices', 'available', '-j']);
  if (!json) return [];
  try {
    const { devices } = JSON.parse(json) as {
      devices: Record<string, { udid: string; name: string; state: string }[]>;
    };
    return Object.entries(devices)
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
      );
  } catch {
    return [];
  }
}
