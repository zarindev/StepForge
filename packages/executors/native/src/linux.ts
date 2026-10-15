import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';

/** StepForge's Linux desktop helper: a small WebDriver server on the AT-SPI accessibility layer (Python). */
export const LINUX_HELPER = fileURLToPath(new URL('../linux/stepforge_atspi.py', import.meta.url));

/** What the Linux helper needs on this computer: Python 3 with PyGObject (Atspi, Gdk) and a display. */
export function linuxChecks(): { python?: string; atspi: boolean; display?: string } {
  if (process.platform !== 'linux') return { atspi: false };
  const run = (args: string[]) => {
    try {
      return execFileSync('python3', args, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 20_000,
      }).trim();
    } catch {
      return undefined;
    }
  };
  const python = run(['--version']);
  const atspi =
    run([
      '-c',
      "import gi; gi.require_version('Atspi', '2.0'); gi.require_version('Gdk', '3.0'); from gi.repository import Atspi, Gdk; print('ok')",
    ]) === 'ok';
  return { python, atspi, display: process.env.DISPLAY ?? process.env.WAYLAND_DISPLAY };
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

/** The Linux helper, started on first use and stopped with StepForge (like the Appium server). */
export class LinuxHelper {
  private proc?: ChildProcess;
  private starting?: Promise<string>;
  private log: string[] = [];

  url(): Promise<string> {
    if (this.starting) return this.starting;
    this.starting = this.start().catch((err) => {
      this.starting = undefined;
      throw err;
    });
    return this.starting;
  }

  private async start(): Promise<string> {
    if (process.platform !== 'linux') throw new Error('Linux desktop apps can only be tested on Linux');
    const port = await freePort();
    const proc = spawn('python3', [LINUX_HELPER, '--port', String(port)], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.proc = proc;
    const keep = (d: Buffer) => {
      this.log.push(...d.toString().split('\n').filter(Boolean));
      if (this.log.length > 200) this.log.splice(0, this.log.length - 200);
    };
    proc.stdout!.on('data', keep);
    proc.stderr!.on('data', keep);
    proc.on('exit', () => {
      if (this.proc === proc) {
        this.proc = undefined;
        this.starting = undefined;
      }
    });
    const url = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (proc.exitCode !== null)
        throw new Error(
          `The Linux helper stopped while starting: ${this.log.slice(-3).join(' ')} (run "stepforge doctor native --platform linux")`,
        );
      try {
        if ((await fetch(`${url}/status`, { signal: AbortSignal.timeout(2000) })).ok) return url;
      } catch {
        // not listening yet
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    proc.kill();
    throw new Error('The Linux helper did not start within 30 s');
  }

  async stop(): Promise<void> {
    const p = this.proc;
    this.proc = undefined;
    this.starting = undefined;
    if (p && p.exitCode === null) p.kill();
  }
}
