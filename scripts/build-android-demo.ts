/**
 * Builds the demo Android app (demo/android-app → demo/android-app/careclinic.apk) with the Android SDK's own tools —
 * no Gradle. Needs the SDK (platform + build-tools) and a Java 17+. The built APK is committed, so running the demo
 * does not need this. Usage: npx tsx scripts/build-android-demo.ts
 */
import { androidSdk, javaHome } from '@stepforge/executor-native';
import JSZip from 'jszip';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const app = resolve(fileURLToPath(new URL('../demo/android-app', import.meta.url)));
const out = join(app, 'build');
const sdk = androidSdk();
const java = javaHome();
if (!sdk || !java) {
  console.error(`Needs the Android SDK (found: ${sdk ?? 'no'}) and Java 17+ (found: ${java ?? 'no'}).`);
  process.exit(1);
}
const win = process.platform === 'win32';
const latest = (dir: string, ok: (d: string) => boolean) =>
  readdirSync(dir)
    .filter((d) => ok(join(dir, d)))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .pop();
const btDir = join(sdk, 'build-tools');
const platDir = join(sdk, 'platforms');
const bt = existsSync(btDir) && latest(btDir, (d) => existsSync(join(d, win ? 'aapt2.exe' : 'aapt2')));
const plat = existsSync(platDir) && latest(platDir, (d) => existsSync(join(d, 'android.jar')));
if (!bt || !plat) {
  console.error(
    'Install an SDK platform and build-tools: sdkmanager "platforms;android-35" "build-tools;35.0.0"',
  );
  process.exit(1);
}
const tool = (name: string, ext = win ? '.exe' : '') => join(btDir, bt, name + ext);
const androidJar = join(platDir, plat, 'android.jar');
const env = {
  ...process.env,
  JAVA_HOME: java,
  PATH: `${join(java, 'bin')}${win ? ';' : ':'}${process.env.PATH}`,
};
const sh = (cmd: string, args: string[]) => execFileSync(cmd, args, { stdio: 'inherit', env, shell: win });
const files = (dir: string, ext: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p, ext) : p.endsWith(ext) ? [p] : [];
  });

rmSync(out, { recursive: true, force: true });
for (const d of ['gen', 'classes', 'dex']) mkdirSync(join(out, d), { recursive: true });
console.log(`Building with build-tools ${bt} and ${plat}`);
sh(tool('aapt2'), ['compile', '--dir', join(app, 'res'), '-o', join(out, 'res.zip')]);
sh(tool('aapt2'), [
  'link',
  '-o',
  join(out, 'base.apk'),
  '-I',
  androidJar,
  '--manifest',
  join(app, 'AndroidManifest.xml'),
  '--java',
  join(out, 'gen'),
  '--min-sdk-version',
  '24',
  '--target-sdk-version',
  '35',
  join(out, 'res.zip'),
]);
sh(join(java, 'bin', win ? 'javac.exe' : 'javac'), [
  '--release',
  '11',
  '-classpath',
  androidJar,
  '-d',
  join(out, 'classes'),
  ...files(join(app, 'src'), '.java'),
  ...files(join(out, 'gen'), '.java'),
]);
sh(tool('d8', win ? '.bat' : ''), [
  '--release',
  '--lib',
  androidJar,
  '--min-api',
  '24',
  '--output',
  join(out, 'dex'),
  ...files(join(out, 'classes'), '.class'),
]);
const zip = await JSZip.loadAsync(readFileSync(join(out, 'base.apk')));
zip.file('classes.dex', readFileSync(join(out, 'dex', 'classes.dex')), { compression: 'DEFLATE' });
// Android 11+ needs resources.arsc stored uncompressed (zipalign then aligns it).
writeFileSync(
  join(out, 'unsigned.apk'),
  await zip.generateAsync({ type: 'nodebuffer', compression: 'STORE' }),
);
sh(tool('zipalign'), ['-f', '-p', '4', join(out, 'unsigned.apk'), join(out, 'aligned.apk')]);
const ks = join(out, 'debug.keystore');
sh(join(java, 'bin', win ? 'keytool.exe' : 'keytool'), [
  '-genkeypair',
  '-keystore',
  ks,
  '-storepass',
  'android',
  '-keypass',
  'android',
  '-alias',
  'demo',
  '-keyalg',
  'RSA',
  '-keysize',
  '2048',
  '-validity',
  '10000',
  '-dname',
  'CN=StepForge demo',
  '-noprompt',
]);
sh(tool('apksigner', win ? '.bat' : ''), [
  'sign',
  '--ks',
  ks,
  '--ks-pass',
  'pass:android',
  '--out',
  join(app, 'careclinic.apk'),
  join(out, 'aligned.apk'),
]);
rmSync(join(app, 'careclinic.apk.idsig'), { force: true });
console.log(`Built ${join(app, 'careclinic.apk')} (${statSync(join(app, 'careclinic.apk')).size} bytes)`);
