// electron-builder settings for the StepForge installers (used by scripts/package.mjs on the staged app).
const { cpSync, readdirSync, rmSync } = require('node:fs');
const { join } = require('node:path');
const { platform } = require('node:process');

const assets = join(__dirname, 'assets');

/** Every node_modules folder of the staged app (the top one and the workspaces' own), relative to it. */
function nodeModulesDirs(dir, rel = '') {
  const found = [];
  for (const entry of readdirSync(join(dir, rel), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = rel ? join(rel, entry.name) : entry.name;
    if (entry.name === 'node_modules') found.push(path);
    else if (!entry.name.startsWith('.')) found.push(...nodeModulesDirs(dir, path));
  }
  return found;
}

module.exports = {
  appId: 'dev.stepforge.desktop',
  productName: 'StepForge',
  copyright: 'Copyright © Md Zarin Tasnim',
  directories: { output: join(__dirname, 'release'), buildResources: assets },
  // Plain files, not an asar archive: the server runs TypeScript through tsx and starts helper processes from them.
  asar: false,
  // Dependencies are installed and better-sqlite3 rebuilt by scripts/package.mjs.
  npmRebuild: false,
  nodeGypRebuild: false,
  files: ['**/*'],
  // No version in the file names: "releases/latest/download/StepForge-mac-arm64.dmg" links keep working.
  artifactName: 'StepForge-${os}-${arch}.${ext}',
  mac: {
    target: ['dmg'],
    category: 'public.app-category.developer-tools',
    icon: join(assets, 'icon.png'),
    // Not signed yet (an Apple Developer account costs money): macOS asks to confirm the first start.
    identity: null,
  },
  dmg: { title: 'StepForge ${version}' },
  win: { target: ['nsis'], icon: join(assets, 'icon.png') },
  nsis: { oneClick: false, perMachine: false, allowToChangeInstallationDirectory: true },
  linux: {
    target: ['AppImage', 'deb'],
    category: 'Development',
    icon: join(assets, 'icon.png'),
    maintainer: 'Md Zarin Tasnim',
    synopsis: 'Free, open-source, local-first QA studio',
  },
  publish: null,
  // electron-builder follows the app's own dependencies only and skips every node_modules folder; StepForge's
  // dependencies live in its workspaces (some workspaces have their own versions, in their own node_modules). Every
  // staged node_modules goes in as installed (workspace links kept, as relative links; Windows gets copies).
  afterPack: async (ctx) => {
    const app =
      ctx.electronPlatformName === 'darwin'
        ? join(ctx.appOutDir, `${ctx.packager.appInfo.productFilename}.app`, 'Contents', 'Resources', 'app')
        : join(ctx.appOutDir, 'resources', 'app');
    const stage = ctx.packager.info.projectDir;
    for (const rel of nodeModulesDirs(stage)) {
      rmSync(join(app, rel), { recursive: true, force: true });
      cpSync(join(stage, rel), join(app, rel), {
        recursive: true,
        verbatimSymlinks: platform !== 'win32',
        dereference: platform === 'win32',
      });
    }
  },
};
