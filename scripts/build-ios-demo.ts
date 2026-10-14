/**
 * Builds the demo iOS app (demo/ios-app → demo/ios-app/build/CareClinic.app) for the iOS Simulator with Xcode's own
 * compiler — no Xcode project. Needs a Mac with Xcode. Usage: npx tsx scripts/build-ios-demo.ts
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const IOS_DEMO_DIR = resolve(fileURLToPath(new URL('../demo/ios-app', import.meta.url)));
export const IOS_DEMO_APP = join(IOS_DEMO_DIR, 'build', 'CareClinic.app');

export function buildIosDemo(log: (m: string) => void = console.log): string {
  if (process.platform !== 'darwin') throw new Error('iOS apps are built on a Mac with Xcode');
  const out = join(IOS_DEMO_DIR, 'build');
  const sources = readdirSync(join(IOS_DEMO_DIR, 'src'))
    .filter((f) => f.endsWith('.swift'))
    .map((f) => join(IOS_DEMO_DIR, 'src', f));
  rmSync(out, { recursive: true, force: true });
  mkdirSync(IOS_DEMO_APP, { recursive: true });
  // Both simulator processors: Apple silicon (arm64) and Intel (x86_64).
  const slices = ['arm64', 'x86_64'].map((arch) => {
    const bin = join(out, `CareClinic-${arch}`);
    log(`Compiling for the ${arch} simulator…`);
    execFileSync(
      'xcrun',
      [
        '-sdk',
        'iphonesimulator',
        'swiftc',
        '-target',
        `${arch}-apple-ios17.0-simulator`,
        '-module-name',
        'CareClinic',
        '-O',
        '-parse-as-library',
        ...sources,
        '-o',
        bin,
      ],
      { stdio: 'inherit' },
    );
    return bin;
  });
  execFileSync('lipo', ['-create', ...slices, '-output', join(IOS_DEMO_APP, 'CareClinic')]);
  copyFileSync(join(IOS_DEMO_DIR, 'Info.plist'), join(IOS_DEMO_APP, 'Info.plist'));
  // The simulator runs apps signed "ad hoc" (no Apple ID needed).
  execFileSync('codesign', ['--force', '--sign', '-', '--timestamp=none', IOS_DEMO_APP]);
  log(`Built ${IOS_DEMO_APP}`);
  return IOS_DEMO_APP;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) buildIosDemo();
