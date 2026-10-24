import type {
  AndroidLaunch,
  IosLaunch,
  LinuxLaunch,
  MacLaunch,
  VariableResolver,
  WindowsLaunch,
} from '@stepforge/core';
import {
  androidPlatform,
  iosPlatform,
  linuxPlatform,
  macPlatform,
  windowsPlatform,
  type AppiumServer,
  type LinuxHelper,
  type NativePlatform,
} from '@stepforge/executor-native';
import * as repo from '@stepforge/db/repos';

export const NATIVE_PLATFORMS = ['android', 'ios', 'macos', 'windows', 'linux'] as const;
export const isNative = (platform: string) => (NATIVE_PLATFORMS as readonly string[]).includes(platform);

/**
 * A phone or desktop app as an environment starts it (its launch settings, placeholders resolved), for the recorder
 * and manual tests: the same settings automated tests use.
 */
export function nativePlatformFor(
  platform: string,
  env: { browserDefaultsJson: unknown },
  resolver: VariableResolver,
): NativePlatform | undefined {
  const defaults = (env.browserDefaultsJson ?? {}) as Record<string, unknown>;
  const launch = <T>(key: string) => resolver.resolve(defaults[key] ?? {}) as T;
  switch (platform) {
    case 'android':
      return androidPlatform(launch<AndroidLaunch>('android'));
    case 'ios':
      return iosPlatform(launch<IosLaunch>('ios'));
    case 'macos':
      return macPlatform(launch<MacLaunch>('macos'));
    case 'windows':
      return windowsPlatform(launch<WindowsLaunch>('windows'));
    case 'linux':
      return linuxPlatform(launch<LinuxLaunch>('linux'));
    default:
      return undefined;
  }
}

/** Where to start a session: StepForge's Linux helper, or the local Appium server with the platform's driver. */
export async function nativeServerUrl(
  native: NativePlatform,
  servers: { appium?: AppiumServer; linux?: LinuxHelper },
): Promise<string> {
  if (native.driver === 'atspi') {
    if (!servers.linux) throw new repo.RepoError(400, 'invalid', 'Linux apps are not available here');
    return servers.linux.url().catch((err: Error) => {
      throw new repo.RepoError(400, 'invalid', err.message);
    });
  }
  if (!servers.appium)
    throw new repo.RepoError(400, 'invalid', 'Phone and desktop apps are not available here');
  if (!servers.appium.hasDriver(native.driver))
    throw new repo.RepoError(
      400,
      'invalid',
      `Appium's ${native.name} driver is not installed: run "npm run appium:install" (or Install Appium on the Environments tab)`,
    );
  return servers.appium.url().catch((err: Error) => {
    throw new repo.RepoError(400, 'invalid', err.message);
  });
}
