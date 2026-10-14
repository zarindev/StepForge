/**
 * Builds the demo macOS app (demo/macos-app → demo/macos-app/build/CareClinic.app) with Xcode's own compiler — no
 * Xcode project. Needs a Mac with Xcode (or the command-line tools). Usage: npx tsx scripts/build-macos-demo.ts
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MAC_DEMO_DIR = resolve(fileURLToPath(new URL('../demo/macos-app', import.meta.url)));
export const MAC_DEMO_APP = join(MAC_DEMO_DIR, 'build', 'CareClinic.app');
export const MAC_DEMO_BUNDLE_ID = 'com.stepforge.careclinic.mac';

export function buildMacDemo(log: (m: string) => void = console.log): string {
  if (process.platform !== 'darwin') throw new Error('macOS apps are built on a Mac');
  const out = join(MAC_DEMO_DIR, 'build');
  const sources = readdirSync(join(MAC_DEMO_DIR, 'src'))
    .filter((f) => f.endsWith('.swift'))
    .map((f) => join(MAC_DEMO_DIR, 'src', f));
  rmSync(out, { recursive: true, force: true });
  const macos = join(MAC_DEMO_APP, 'Contents', 'MacOS');
  mkdirSync(macos, { recursive: true });
  // Both processors: Apple silicon (arm64) and Intel (x86_64).
  const slices = ['arm64', 'x86_64'].map((arch) => {
    const bin = join(out, `CareClinic-${arch}`);
    log(`Compiling for ${arch}…`);
    execFileSync(
      'xcrun',
      ['-sdk', 'macosx', 'swiftc', '-target', `${arch}-apple-macos13.0`, '-O', ...sources, '-o', bin],
      { stdio: 'inherit' },
    );
    return bin;
  });
  execFileSync('lipo', ['-create', ...slices, '-output', join(macos, 'CareClinic')]);
  copyFileSync(join(MAC_DEMO_DIR, 'Info.plist'), join(MAC_DEMO_APP, 'Contents', 'Info.plist'));
  execFileSync('codesign', ['--force', '--sign', '-', '--timestamp=none', MAC_DEMO_APP]);
  log(`Built ${MAC_DEMO_APP}`);
  return MAC_DEMO_APP;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) buildMacDemo();
