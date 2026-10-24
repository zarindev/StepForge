import type { Features } from './ir.ts';
import { CURL_FEATURES, K6_FEATURES, POSTMAN_FEATURES } from './targets/api-formats.ts';
import { CYPRESS_FEATURES } from './targets/cypress.ts';
import { javaFeatures } from './targets/java.ts';
import { PLAYWRIGHT_TS_FEATURES } from './targets/playwright-ts.ts';
import { pythonFeatures } from './targets/python.ts';
import type { TargetId } from './types.ts';

/**
 * What each export prints beyond the basic steps (see `Feature` in ir.ts). Each generator declares its own list; a
 * step needing a feature missing here becomes a TODO with a warning. Phone and desktop-app exports and documents
 * keep the basic set.
 */
export function featuresOf(target: TargetId): Features {
  switch (target) {
    case 'playwright-ts':
      return PLAYWRIGHT_TS_FEATURES;
    case 'playwright-py':
      return pythonFeatures('playwright');
    case 'selenium-py':
      return pythonFeatures('selenium');
    case 'pytest-requests':
      return pythonFeatures('api');
    case 'appium-py':
      return pythonFeatures('appium');
    case 'selenium-java':
      return javaFeatures('selenium');
    case 'rest-assured':
      return javaFeatures('api');
    case 'appium-java':
      return javaFeatures('appium');
    case 'cypress-js':
      return CYPRESS_FEATURES;
    case 'k6':
      return K6_FEATURES;
    case 'postman':
      return POSTMAN_FEATURES;
    case 'curl':
      return CURL_FEATURES;
    default:
      return {};
  }
}
