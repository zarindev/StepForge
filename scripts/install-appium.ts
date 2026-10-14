/**
 * Installs Appium and its Android driver (UiAutomator2) into <data>/tools/appium — for testing Android apps.
 * Pinned versions, nothing installed globally. Usage: npm run appium:install
 */
import { appiumInstalled, appiumPaths, installAppium } from '@stepforge/executor-native';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const raw = process.env.STEPFORGE_DATA_DIR ?? './data';
const toolsDir = process.env.STEPFORGE_TOOLS_DIR
  ? resolve(root, process.env.STEPFORGE_TOOLS_DIR)
  : join(isAbsolute(raw) ? raw : resolve(root, raw), 'tools');

if (appiumInstalled(toolsDir)) {
  console.log(`Appium is already installed at ${appiumPaths(toolsDir).root}.`);
} else {
  try {
    await installAppium(toolsDir, (m) => console.log(`    ${m}`));
    console.log(`Appium is installed at ${appiumPaths(toolsDir).root}.`);
  } catch (err) {
    console.error(`Could not install Appium: ${(err as Error).message}`);
    process.exitCode = 1;
  }
}
