import { StepError, type ElectronLaunch } from '@stepforge/core';
import { existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { _electron, type ElectronApplication } from 'playwright';

/**
 * The Electron binary for an app folder or main script: the `electron` package installed in that project (or a parent
 * folder), as `npm start` would use it. A packaged app is started by its own executable instead.
 */
export function electronFor(appPath: string): string | undefined {
  const start = existsSync(appPath) && statSync(appPath).isFile() ? dirname(appPath) : appPath;
  try {
    const req = createRequire(join(resolve(start), 'package.json'));
    const bin = req('electron') as unknown;
    return typeof bin === 'string' && existsSync(bin) ? bin : undefined;
  } catch {
    return undefined;
  }
}

/** The environment for the app: StepForge's own, without settings that would stop Electron from starting as an app. */
function appEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  // Set in terminals of VS Code-based editors: it makes Electron behave like plain Node.js.
  delete env.ELECTRON_RUN_AS_NODE;
  return { ...env, ...extra };
}

/** Starts an Electron desktop app for a test (its first window is the test's page). */
export async function launchElectron(
  launch: ElectronLaunch,
  opts: { recordVideoDir?: string; timeoutMs: number },
): Promise<ElectronApplication> {
  const cwd = launch.cwd ? resolve(launch.cwd) : undefined;
  const abs = (p: string) => (isAbsolute(p) ? p : resolve(cwd ?? process.cwd(), p));
  let executablePath: string | undefined;
  const args = [...(launch.args ?? [])];
  if (launch.executablePath) {
    executablePath = abs(launch.executablePath);
    if (!existsSync(executablePath))
      throw new StepError('invalid_params', `The app executable was not found: ${executablePath}`);
  } else if (launch.appPath) {
    const app = abs(launch.appPath);
    if (!existsSync(app)) throw new StepError('invalid_params', `The app folder was not found: ${app}`);
    executablePath = electronFor(app);
    if (!executablePath)
      throw new StepError(
        'invalid_params',
        `No Electron found for ${app}: install it in the app's project (npm install electron), or set the app executable`,
      );
    args.unshift(app);
  } else throw new StepError('invalid_params', 'Set the app executable or the app folder in the environment');
  try {
    return await _electron.launch({
      executablePath,
      args,
      ...(cwd && { cwd }),
      env: appEnv(launch.env),
      timeout: Math.max(opts.timeoutMs, 30_000),
      ...(opts.recordVideoDir && { recordVideo: { dir: opts.recordVideoDir } }),
    });
  } catch (err) {
    throw new StepError(
      'navigation',
      `The desktop app did not start: ${(err as Error).message.split('\n')[0]}`,
    );
  }
}
