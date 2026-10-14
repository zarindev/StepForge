import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { androidEnv } from './android.ts';

/** Pinned versions, installed into StepForge's data folder (never globally). Both Apache-2.0. */
export const APPIUM_VERSION = '3.8.0';
export const UIAUTOMATOR2_VERSION = '8.7.0';
/** The iOS driver (Apache-2.0); installed on macOS only, since iOS testing needs Xcode. */
export const XCUITEST_VERSION = '12.18.1';
/** Native desktop drivers (Apache-2.0): macOS through Apple's XCTest; Windows through UI Automation. */
export const MAC2_VERSION = '4.4.0';
export const NOVAWINDOWS_VERSION = '1.4.5';

/** The drivers this computer can use: Android everywhere, iOS on a Mac. */
export function wantedDrivers(): {
  name: 'uiautomator2' | 'xcuitest' | 'mac2' | 'novawindows';
  version: string;
  label: string;
}[] {
  return [
    { name: 'uiautomator2', version: UIAUTOMATOR2_VERSION, label: 'the Android driver (UiAutomator2)' },
    ...(process.platform === 'darwin'
      ? [
          { name: 'xcuitest' as const, version: XCUITEST_VERSION, label: 'the iOS driver (XCUITest)' },
          { name: 'mac2' as const, version: MAC2_VERSION, label: 'the macOS driver (Mac2)' },
        ]
      : []),
    ...(process.platform === 'win32'
      ? [
          {
            name: 'novawindows' as const,
            version: NOVAWINDOWS_VERSION,
            label: 'the Windows driver (NovaWindows)',
          },
        ]
      : []),
  ];
}

/** A Node.js for Appium when StepForge's own is outside Appium's range (an LTS, MIT licence, from nodejs.org). */
export const APPIUM_NODE_VERSION = '22.23.3';

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

/** Appium 3 runs on Node 20.19+, 22.12+ or 24+. */
export function nodeOkForAppium(version = process.versions.node): boolean {
  const [major = 0, minor = 0] = version.split('.').map(Number);
  return (major === 20 && minor >= 19) || (major === 22 && minor >= 12) || major >= 24;
}

const portableNodeDir = (toolsDir: string) => join(toolsDir, 'node');
const portableNode = (toolsDir: string) =>
  join(portableNodeDir(toolsDir), process.platform === 'win32' ? 'node.exe' : join('bin', 'node'));

/** The Node.js that runs Appium: StepForge's own when Appium accepts it, else the portable one (if installed). */
export function appiumNode(toolsDir: string): string | undefined {
  if (nodeOkForAppium()) return process.execPath;
  return existsSync(portableNode(toolsDir)) ? portableNode(toolsDir) : undefined;
}

/** Downloads the pinned Node.js LTS into `<tools>/node` (checked against nodejs.org's SHA-256 list). */
async function installPortableNode(toolsDir: string, log: (m: string) => void): Promise<void> {
  const plat = { darwin: 'darwin', linux: 'linux', win32: 'win' }[process.platform as string];
  const arch = { x64: 'x64', arm64: 'arm64' }[process.arch as string];
  if (!plat || !arch)
    throw new Error(
      `No Node.js download for ${process.platform}/${process.arch}: install Node 22.12+ or 24+`,
    );
  const name = `node-v${APPIUM_NODE_VERSION}-${plat}-${arch}`;
  const file = `${name}.${plat === 'win' ? 'zip' : 'tar.gz'}`;
  const base = `https://nodejs.org/dist/v${APPIUM_NODE_VERSION}`;
  log(
    `Node.js ${process.versions.node} is outside Appium's range: downloading Node.js ${APPIUM_NODE_VERSION} for Appium…`,
  );
  const [archive, sums] = await Promise.all([
    fetch(`${base}/${file}`).then(async (r) => {
      if (!r.ok) throw new Error(`Download failed: ${r.status} ${base}/${file}`);
      return Buffer.from(await r.arrayBuffer());
    }),
    fetch(`${base}/SHASUMS256.txt`).then((r) => r.text()),
  ]);
  const want = sums
    .split('\n')
    .find((l) => l.endsWith(`  ${file}`))
    ?.split(' ')[0];
  const got = createHash('sha256').update(archive).digest('hex');
  if (!want || want !== got) throw new Error(`The Node.js download did not match its checksum (${file})`);
  mkdirSync(toolsDir, { recursive: true });
  const tmp = join(toolsDir, `.${file}`);
  writeFileSync(tmp, archive);
  const out = join(toolsDir, '.node-extract');
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  // bsdtar (macOS, Windows 10+) and GNU tar both read these archives.
  execFileSync('tar', ['-xf', tmp, '-C', out]);
  rmSync(portableNodeDir(toolsDir), { recursive: true, force: true });
  renameSync(
    join(
      out,
      readdirSync(out).find((d) => d.startsWith('node-v'))!,
    ),
    portableNodeDir(toolsDir),
  );
  rmSync(out, { recursive: true, force: true });
  rmSync(tmp, { force: true });
}

/** Where Appium lives: `<data>/tools/appium` (the package) and `<data>/tools/appium/home` (its drivers). */
export function appiumPaths(toolsDir: string) {
  const root = join(toolsDir, 'appium');
  return {
    root,
    home: join(root, 'home'),
    main: join(root, 'node_modules', 'appium', 'index.js'),
  };
}

/** Installed driver names and versions (from Appium's own manifest). */
export function installedDrivers(toolsDir: string): Record<string, string> {
  const { home } = appiumPaths(toolsDir);
  const out: Record<string, string> = {};
  for (const file of [join(home, 'node_modules', '.cache', 'appium', 'extensions.yaml')]) {
    if (!existsSync(file)) continue;
    // A small YAML file: "drivers:\n  uiautomator2:\n    version: 8.7.0 …"
    let current: string | undefined;
    let inDrivers = false;
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (/^drivers:/.test(line)) inDrivers = true;
      else if (/^\S/.test(line)) inDrivers = false;
      else if (inDrivers && /^ {2}\S/.test(line)) current = line.trim().replace(/:$/, '');
      else if (inDrivers && current && /^ {4}version:/.test(line))
        out[current] = line.split(':')[1]!.trim().replace(/['"]/g, '');
    }
  }
  return out;
}

/** Appium, a Node.js to run it, and the driver (default: every driver this computer can use). */
export function appiumInstalled(toolsDir: string, driver?: string): boolean {
  if (!existsSync(appiumPaths(toolsDir).main) || !appiumNode(toolsDir)) return false;
  const drivers = installedDrivers(toolsDir);
  return driver ? !!drivers[driver] : wantedDrivers().every((d) => !!drivers[d.name]);
}

function exec(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv },
  log: (m: string) => void,
) {
  return new Promise<void>((resolve, reject) => {
    const p = spawn(cmd, args, {
      ...opts,
      // Only npm.cmd needs the Windows shell; Node itself is run directly (its path may contain spaces).
      shell: process.platform === 'win32' && cmd.endsWith('.cmd'),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let tail = '';
    const take = (d: Buffer) => {
      tail = (tail + d.toString()).slice(-4000);
      for (const l of d.toString().split('\n')) if (l.trim()) log(l.trim());
    };
    p.stdout.on('data', take);
    p.stderr.on('data', take);
    p.on('error', reject);
    p.on('close', (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`${cmd} ${args.join(' ')} failed (${code}): ${tail.trim().split('\n').pop()}`)),
    );
  });
}

/** Installs Appium and the UiAutomator2 (Android) driver into `<data>/tools/appium`. */
export async function installAppium(toolsDir: string, log: (m: string) => void = () => {}): Promise<void> {
  const { root, home, main } = appiumPaths(toolsDir);
  mkdirSync(home, { recursive: true });
  if (!appiumNode(toolsDir)) await installPortableNode(toolsDir, log);
  const node = appiumNode(toolsDir)!;
  if (!existsSync(join(root, 'package.json')))
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ name: 'stepforge-appium', private: true }, null, 2),
    );
  if (!existsSync(main)) {
    log(`Installing Appium ${APPIUM_VERSION}…`);
    await exec(
      npm,
      ['install', '--no-audit', '--no-fund', '--loglevel=error', `appium@${APPIUM_VERSION}`],
      { cwd: root },
      log,
    );
  }
  for (const d of wantedDrivers()) {
    if (installedDrivers(toolsDir)[d.name]) continue;
    log(`Installing ${d.label} ${d.version}…`);
    await exec(
      node,
      [main, 'driver', 'install', `${d.name}@${d.version}`],
      { cwd: root, env: { ...process.env, APPIUM_HOME: home } },
      log,
    );
  }
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

/** A local Appium server, started on first use and stopped with StepForge. */
export class AppiumServer {
  private proc?: ChildProcess;
  private starting?: Promise<string>;
  private log: string[] = [];

  constructor(private readonly toolsDir: string) {}

  /** Appium itself (and a Node.js for it); each test checks its platform's driver. */
  get installed(): boolean {
    return existsSync(appiumPaths(this.toolsDir).main) && !!appiumNode(this.toolsDir);
  }

  hasDriver(name: string): boolean {
    return appiumInstalled(this.toolsDir, name);
  }

  /** The server's URL, starting it if needed. */
  url(): Promise<string> {
    if (this.starting) return this.starting;
    this.starting = this.start().catch((err) => {
      this.starting = undefined;
      throw err;
    });
    return this.starting;
  }

  private async start(): Promise<string> {
    if (!this.installed)
      throw new Error(
        'Appium is not installed: run "npm run appium:install", or Install Appium on the application’s Environments tab',
      );
    const { home, main } = appiumPaths(this.toolsDir);
    const port = await freePort();
    const url = `http://127.0.0.1:${port}`;
    this.log = [];
    const node = appiumNode(this.toolsDir)!;
    const proc = spawn(
      node,
      [main, '--address', '127.0.0.1', '--port', String(port), '--log-level', 'info', '--log-no-colors'],
      {
        env: { ...process.env, ...androidEnv(), APPIUM_HOME: home },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    this.proc = proc;
    const keep = (d: Buffer) => {
      this.log.push(...d.toString().split('\n').filter(Boolean));
      if (this.log.length > 400) this.log.splice(0, this.log.length - 400);
    };
    proc.stdout!.on('data', keep);
    proc.stderr!.on('data', keep);
    proc.on('exit', () => {
      if (this.proc === proc) {
        this.proc = undefined;
        this.starting = undefined;
      }
    });
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      if (proc.exitCode !== null)
        throw new Error(`Appium stopped while starting: ${this.log.slice(-3).join(' ')}`);
      try {
        const res = await fetch(`${url}/status`, { signal: AbortSignal.timeout(2000) });
        if (res.ok) return url;
      } catch {
        // not listening yet
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    proc.kill();
    throw new Error('Appium did not start within 60 s');
  }

  /** The last lines Appium logged (for error messages). */
  recentLog(lines = 20): string[] {
    return this.log.slice(-lines);
  }

  async stop(): Promise<void> {
    const p = this.proc;
    this.proc = undefined;
    this.starting = undefined;
    if (!p || p.exitCode !== null) return;
    p.kill();
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        p.kill('SIGKILL');
        resolve();
      }, 5000);
      p.on('exit', () => {
        clearTimeout(t);
        resolve();
      });
    });
  }
}
