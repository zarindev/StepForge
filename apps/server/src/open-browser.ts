import { spawn } from 'node:child_process';

/** Opens a URL in the default browser without extra dependencies. Failures are non-fatal. */
export function openBrowser(url: string): void {
  const [cmd, args] =
    process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '""', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true, windowsHide: true })
      .on('error', () => {})
      .unref();
  } catch {
    // headless machine; the URL is printed in the console anyway
  }
}
