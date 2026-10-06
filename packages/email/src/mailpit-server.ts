import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Pinned so the REST API StepForge relies on cannot change underneath it. Override with STEPFORGE_MAILPIT_VERSION. */
export const MAILPIT_VERSION = process.env.STEPFORGE_MAILPIT_VERSION ?? 'v1.31.4';

const exe = process.platform === 'win32' ? 'mailpit.exe' : 'mailpit';
export const mailpitBinary = (binDir: string) => join(binDir, exe);

/** Release asset for this OS/CPU, e.g. mailpit-windows-amd64.zip. */
export function mailpitAsset(platform = process.platform, arch = process.arch): string {
  const os = platform === 'win32' ? 'windows' : platform === 'darwin' ? 'darwin' : 'linux';
  const cpu =
    arch === 'x64'
      ? 'amd64'
      : arch === 'arm64'
        ? 'arm64'
        : arch === 'ia32'
          ? '386'
          : arch === 'arm'
            ? 'arm'
            : '';
  if (!cpu || (os !== 'linux' && !['amd64', 'arm64'].includes(cpu)))
    throw new Error(`Mailpit has no build for ${platform}/${arch}`);
  return `mailpit-${os}-${cpu}.${os === 'windows' ? 'zip' : 'tar.gz'}`;
}

/**
 * Downloads Mailpit from its GitHub releases into `binDir` (free, MIT-licensed, ~10 MB) and extracts it with
 * the system `tar` (bsdtar on Windows 10+ also reads .zip). Returns the binary path.
 */
export async function installMailpit(binDir: string, log: (m: string) => void = () => {}): Promise<string> {
  const asset = mailpitAsset();
  const url = `https://github.com/axllent/mailpit/releases/download/${MAILPIT_VERSION}/${asset}`;
  mkdirSync(binDir, { recursive: true });
  log(`Downloading ${url}`);
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`Download failed (${res.status}) from ${url}`);
  const archive = join(binDir, asset);
  writeFileSync(archive, Buffer.from(await res.arrayBuffer()));
  const r = spawnSync('tar', ['-xf', archive, '-C', binDir, exe], { encoding: 'utf8' });
  rmSync(archive, { force: true });
  if (r.status !== 0) throw new Error(`Could not extract ${asset}: ${r.stderr || r.error?.message}`);
  const bin = mailpitBinary(binDir);
  if (process.platform !== 'win32') chmodSync(bin, 0o755);
  log(`Installed Mailpit ${MAILPIT_VERSION} at ${bin}`);
  return bin;
}

export type MailpitStatus = {
  installed: boolean;
  running: boolean;
  version: string;
  /** Web UI and REST API, e.g. http://127.0.0.1:8025 */
  url: string;
  smtpHost: string;
  smtpPort: number;
  /** Set when Mailpit was started outside StepForge and is just being used. */
  external?: boolean;
  error?: string;
};

/**
 * Runs the local Mailpit (SMTP catcher) on 127.0.0.1 only. If something already answers on the HTTP port
 * (e.g. Mailpit started by start-demos), it is used instead of starting a second copy.
 */
export class MailpitServer {
  private child: ChildProcess | null = null;
  private lastError: string | undefined;

  constructor(
    private readonly opts: { binDir: string; dataDir: string; httpPort?: number; smtpPort?: number },
  ) {}

  get httpPort() {
    return this.opts.httpPort ?? 8025;
  }
  get smtpPort() {
    return this.opts.smtpPort ?? 1025;
  }
  get url() {
    return `http://127.0.0.1:${this.httpPort}`;
  }

  private async responding(): Promise<string | null> {
    try {
      const res = await fetch(`${this.url}/api/v1/info`, { signal: AbortSignal.timeout(1500) });
      if (!res.ok) return null;
      return ((await res.json()) as { Version?: string }).Version ?? 'unknown';
    } catch {
      return null;
    }
  }

  async status(): Promise<MailpitStatus> {
    const version = await this.responding();
    return {
      installed: existsSync(mailpitBinary(this.opts.binDir)),
      running: !!version,
      version: version ?? MAILPIT_VERSION,
      url: this.url,
      smtpHost: '127.0.0.1',
      smtpPort: this.smtpPort,
      ...(version && !this.child && { external: true }),
      ...(this.lastError && !version && { error: this.lastError }),
    };
  }

  async start(): Promise<MailpitStatus> {
    if (await this.responding()) return this.status();
    const bin = mailpitBinary(this.opts.binDir);
    if (!existsSync(bin))
      throw new Error('Mailpit is not installed yet. Install it first (Settings → Email).');
    mkdirSync(this.opts.dataDir, { recursive: true });
    this.lastError = undefined;
    const child = spawn(
      bin,
      [
        '--listen',
        `127.0.0.1:${this.httpPort}`,
        '--smtp',
        `127.0.0.1:${this.smtpPort}`,
        '--database',
        join(this.opts.dataDir, 'mailpit.db'),
        '--max',
        '2000',
        '--quiet',
      ],
      { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true },
    );
    let stderr = '';
    child.stderr?.on('data', (d) => (stderr = (stderr + String(d)).slice(-2000)));
    child.on('exit', (code) => {
      if (this.child === child) this.child = null;
      if (code) this.lastError = stderr.trim() || `Mailpit exited with code ${code}`;
    });
    this.child = child;
    for (let i = 0; i < 50; i++) {
      if (await this.responding()) return this.status();
      if (!this.child) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    const msg = this.lastError ?? stderr.trim() ?? 'Mailpit did not start';
    await this.stop();
    throw new Error(msg || 'Mailpit did not start');
  }

  async stop(): Promise<MailpitStatus> {
    const child = this.child;
    this.child = null;
    if (child && child.exitCode === null) {
      child.kill();
      await new Promise((r) => {
        const t = setTimeout(r, 3000);
        child.once('exit', () => {
          clearTimeout(t);
          r(undefined);
        });
      });
    }
    return this.status();
  }
}
