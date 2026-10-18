// Builds the StepForge desktop installers for this computer's system (electron-builder cannot cross-build macOS apps
// or native modules, so CI runs it once per system).
//
//   npm run desktop:package                 # installers for this system and processor
//   npm run desktop:package -- --arch x64   # another processor (macOS: x64 on Apple silicon works)
//   npm run desktop:package -- --dir        # just the app folder, no installer (quicker, for testing)
//
// Steps: build the dashboard → copy what the app needs into apps/desktop/.stage → install the production
// dependencies there → rebuild better-sqlite3 for Electron's Node.js → electron-builder. Output: apps/desktop/release.
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const DESKTOP = join(ROOT, 'apps/desktop');
const STAGE = join(DESKTOP, '.stage');
const { values } = parseArgs({
  options: { arch: { type: 'string', default: process.arch }, dir: { type: 'boolean', default: false } },
});
const arch = values.arch;
const win = process.platform === 'win32';

const run = (cmd, args, cwd = ROOT) => {
  console.log(`\n> ${cmd} ${args.join(' ')}`);
  // npm is npm.cmd on Windows (needs the shell); Node.js is run directly (its path may contain spaces).
  execFileSync(cmd, args, { cwd, stdio: 'inherit', shell: win && cmd === 'npm' });
};
const read = (file) => JSON.parse(readFileSync(join(ROOT, file), 'utf8'));

console.log(`StepForge desktop: packaging for ${process.platform}/${arch}`);
run('npm', ['run', 'build']);

rmSync(STAGE, { recursive: true, force: true });
mkdirSync(STAGE, { recursive: true });
// Files git tracks or would track (no local data, builds or caches), minus tests.
const tracked = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
  cwd: ROOT,
  encoding: 'utf8',
})
  .split('\0')
  .filter(Boolean);
// The code the app runs (the server and everything it loads, the desktop shell, the two demo apps), plus every
// workspace's package.json so `npm ci` installs exactly the repository's lockfile.
const wanted = (f) =>
  [
    'package.json',
    'package-lock.json',
    'tsconfig.base.json',
    'tsconfig.json',
    'LICENSE',
    'LEGAL.md',
    'scripts/install-mailpit.ts',
  ].includes(f) ||
  /^(apps|demo)\/[^/]+\/package\.json$/.test(f) ||
  (/^(apps\/(server|desktop)|packages|demo\/(clinic-app|shop-app))\//.test(f) &&
    !/\/(test|tests|__snapshots__)\//.test(f) &&
    !f.startsWith('apps/desktop/scripts/'));
let copied = 0;
for (const f of tracked.filter(wanted)) {
  mkdirSync(dirname(join(STAGE, f)), { recursive: true });
  cpSync(join(ROOT, f), join(STAGE, f));
  copied++;
}
cpSync(join(ROOT, 'apps/web/dist'), join(STAGE, 'apps/web/dist'), { recursive: true });
console.log(`Copied ${copied} files and the built dashboard`);

// Production dependencies at the lockfile's exact versions (the dashboard's are build-time only, so not installed).
run('npm', ['ci', '--omit=dev', '--no-audit', '--no-fund', '--loglevel=error'], STAGE);

// The app's package.json for electron-builder (it is not installed from again).
const root = read('package.json');
const electronVersion = read('node_modules/electron/package.json').version;
writeFileSync(
  join(STAGE, 'package.json'),
  JSON.stringify(
    {
      name: 'stepforge',
      productName: 'StepForge',
      version: root.version,
      description: 'Free, open-source, local-first QA studio',
      author: 'Md Zarin Tasnim',
      license: root.license ?? 'MIT',
      homepage: 'https://github.com/zarindev/StepForge',
      private: true,
      type: 'module',
      main: 'apps/desktop/src/main.mjs',
      workspaces: root.workspaces,
      dependencies: {},
    },
    null,
    2,
  ),
);

// better-sqlite3 is a native module: built for Electron's Node.js (and the target processor) with node-gyp, inside the
// staged copy only (@electron/rebuild also rebuilt the repository's own copy, which `npm start` needs as it is).
const sqliteDir = join(STAGE, 'node_modules/better-sqlite3');
run(
  process.execPath,
  [
    join(ROOT, 'node_modules/node-gyp/bin/node-gyp.js'),
    'rebuild',
    '--release',
    `--target=${electronVersion}`,
    `--arch=${arch}`,
    '--dist-url=https://electronjs.org/headers',
  ],
  sqliteDir,
);
if (arch === process.arch) {
  const electronBin = join(
    ROOT,
    'node_modules/electron/dist',
    process.platform === 'darwin'
      ? 'Electron.app/Contents/MacOS/Electron'
      : win
        ? 'electron.exe'
        : 'electron',
  );
  execFileSync(
    electronBin,
    ['-e', `new (require(${JSON.stringify(sqliteDir)}))(':memory:').prepare('select 1').get()`],
    { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'inherit' },
  );
  console.log('better-sqlite3 works in Electron');
}

// Not needed at run time: type definitions, source maps, readmes, and better-sqlite3's build leftovers (~60 MB).
const prune = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) prune(path);
    else if (/\.(map|d\.[cm]?ts|md|markdown)$/i.test(entry.name)) rmSync(path);
  }
};
prune(join(STAGE, 'node_modules'));
for (const leftover of [
  'deps',
  'src',
  'build/Release/obj',
  'build/Release/obj.target',
  'build/Release/test_extension.node',
])
  rmSync(join(STAGE, 'node_modules/better-sqlite3', leftover), { recursive: true, force: true });
for (const lib of readdirSync(join(STAGE, 'node_modules/better-sqlite3/build/Release')))
  if (lib.endsWith('.a') || lib.endsWith('.lib'))
    rmSync(join(STAGE, 'node_modules/better-sqlite3/build/Release', lib));

const target = values.dir ? ['--dir'] : [];
const platform = { darwin: '--mac', win32: '--win', linux: '--linux' }[process.platform];
run(process.execPath, [
  join(ROOT, 'node_modules/electron-builder/cli.js'),
  platform,
  `--${arch}`,
  ...target,
  '--projectDir',
  STAGE,
  '--config',
  join(DESKTOP, 'electron-builder.config.cjs'),
  `-c.electronVersion=${electronVersion}`,
]);
console.log(`\nDone: ${join(DESKTOP, 'release')}`);
