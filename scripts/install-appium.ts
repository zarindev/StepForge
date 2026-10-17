/**
 * Installs Appium and its Android driver (UiAutomator2) into <data>/tools/appium — for testing Android apps.
 * Pinned versions, nothing installed globally. Usage: npm run appium:install
 */
import { appiumInstalled, appiumPaths, installAppium } from '@stepforge/executor-native';
import { loadConfig } from '../apps/server/src/config.js';

// Same folders as the server: .env, STEPFORGE_DATA_DIR and STEPFORGE_TOOLS_DIR all count.
const { toolsDir } = loadConfig();

if (appiumInstalled(toolsDir)) {
  console.log(`Appium is already installed at ${appiumPaths(toolsDir).root}.`);
} else {
  try {
    await installAppium(toolsDir, (m) => console.log(`    ${m}`));
    console.log(`Appium is installed at ${appiumPaths(toolsDir).root}.`);
  } catch (err) {
    console.error(`Could not install Appium: ${(err as Error).message}`);
    // In GitHub Actions, also as an annotation (readable without the full log).
    if (process.env.GITHUB_ACTIONS)
      console.log(`::error title=Appium install::${(err as Error).message.replace(/\r?\n/g, ' ')}`);
    process.exitCode = 1;
  }
}
