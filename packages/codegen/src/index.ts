import JSZip from 'jszip';
import { featuresOf } from './features.ts';
import { buildPlan } from './ir.ts';
import { generateCurl, generateK6, generatePostman } from './targets/api-formats.ts';
import { generateAppiumTs } from './targets/appium-ts.ts';
import { generateCypress } from './targets/cypress.ts';
import { generateMaestro } from './targets/maestro.ts';
import { generateGherkin, generateMarkdown, generateXlsx } from './targets/docs.ts';
import { generateJava } from './targets/java.ts';
import { generatePython } from './targets/python.ts';
import { generatePlaywrightTs } from './targets/playwright-ts.ts';
import {
  APP_PLATFORMS,
  type AppPlatform,
  type CodegenInput,
  type CodegenOptions,
  type GeneratedProject,
  type TargetId,
} from './types.ts';

export * from './types.ts';
export { buildPlan } from './ir.ts';

export type TargetInfo = {
  id: TargetId;
  label: string;
  group: 'UI and hybrid' | 'Phone and desktop apps' | 'API' | 'Documentation';
  language: string;
  /** Page Object Model option available. */
  pom: boolean;
  /** CI files available. */
  ci: boolean;
  /** Only API steps are exported; other scenarios are skipped with a warning. */
  apiOnly: boolean;
  /** For these app platforms only (phone and desktop apps); absent = any application. */
  platforms?: AppPlatform[];
};

const ui = (id: TargetId, label: string, language: string): TargetInfo => ({
  id,
  label,
  group: 'UI and hybrid',
  language,
  pom: true,
  ci: true,
  apiOnly: false,
});
const apiTarget = (id: TargetId, label: string, language: string, ci = true): TargetInfo => ({
  id,
  label,
  group: 'API',
  language,
  pom: false,
  ci,
  apiOnly: true,
});
const app = (id: TargetId, label: string, language: string, platforms = APP_PLATFORMS): TargetInfo => ({
  id,
  label,
  group: 'Phone and desktop apps',
  language,
  pom: false,
  ci: true,
  apiOnly: false,
  platforms,
});
const doc = (id: TargetId, label: string, language: string): TargetInfo => ({
  id,
  label,
  group: 'Documentation',
  language,
  pom: false,
  ci: false,
  apiOnly: false,
});

export const TARGETS: TargetInfo[] = [
  ui('playwright-ts', 'Playwright Test', 'TypeScript'),
  ui('playwright-py', 'Playwright + pytest', 'Python'),
  ui('cypress-js', 'Cypress', 'JavaScript'),
  ui('selenium-py', 'Selenium + pytest', 'Python'),
  ui('selenium-java', 'Selenium + JUnit 5', 'Java'),
  app('appium-py', 'Appium + pytest', 'Python'),
  app('appium-ts', 'Appium + WebdriverIO', 'TypeScript'),
  app('appium-java', 'Appium + JUnit 5', 'Java'),
  app('maestro', 'Maestro flows', 'YAML', ['android', 'ios']),
  apiTarget('pytest-requests', 'pytest + requests', 'Python'),
  apiTarget('rest-assured', 'REST Assured + JUnit 5', 'Java'),
  apiTarget('k6', 'k6 script', 'JavaScript'),
  apiTarget('postman', 'Postman collection v2.1', 'JSON', false),
  apiTarget('curl', 'cURL commands', 'Shell', false),
  doc('docs-markdown', 'Test cases (Markdown)', 'Markdown'),
  doc('docs-gherkin', 'Gherkin features', 'Gherkin'),
  doc('docs-xlsx', 'Test cases (Excel)', 'XLSX'),
];

const GENERATORS: Partial<
  Record<
    TargetId,
    (plan: ReturnType<typeof buildPlan>, o: CodegenOptions) => GeneratedProject | Promise<GeneratedProject>
  >
> = {
  'playwright-ts': generatePlaywrightTs,
  'cypress-js': generateCypress,
  'playwright-py': (p, o) => generatePython(p, o, 'playwright', 'playwright-py'),
  'selenium-py': (p, o) => generatePython(p, o, 'selenium', 'selenium-py'),
  'appium-py': (p, o) => generatePython(p, o, 'appium', 'appium-py'),
  'appium-ts': generateAppiumTs,
  'appium-java': (p, o) => generateJava(p, o, 'appium', 'appium-java'),
  maestro: generateMaestro,
  'pytest-requests': (p, o) => generatePython(p, o, 'api', 'pytest-requests'),
  'selenium-java': (p, o) => generateJava(p, o, 'selenium', 'selenium-java'),
  'rest-assured': (p, o) => generateJava(p, o, 'api', 'rest-assured'),
  k6: generateK6,
  postman: generatePostman,
  curl: generateCurl,
  'docs-markdown': generateMarkdown,
  'docs-gherkin': generateGherkin,
  'docs-xlsx': generateXlsx,
};

/** Generates a ready-to-run project (or document) for one target. */
export async function generate(input: CodegenInput, o: CodegenOptions): Promise<GeneratedProject> {
  const gen = GENERATORS[o.target];
  const info = TARGETS.find((t) => t.id === o.target);
  if (!info) throw new Error(`Unknown export target "${o.target}"`);
  if (!gen) throw new Error(`The ${info.label} export is not available yet`);
  const platform = input.application.platform ?? 'web';
  if (info.platforms && !info.platforms.includes(platform as AppPlatform))
    throw new Error(
      `The ${info.label} export is for ${info.platforms.length === APP_PLATFORMS.length ? 'phone and desktop apps' : 'Android and iOS apps'}; this application is a ${platform === 'web' ? 'web' : platform} app`,
    );
  const plan = buildPlan(input, {
    pom: info.pom && !!o.pom,
    native: !!info.platforms,
    features: featuresOf(o.target),
    label: info.label,
  });
  const project = await gen(plan, o);
  return { ...project, files: await formatted(project.files) };
}

const PARSER: Record<string, string> = {
  ts: 'typescript',
  js: 'babel',
  cjs: 'babel',
  mjs: 'babel',
  json: 'json',
};

/** JavaScript, TypeScript and JSON files are formatted with Prettier, like a person would. */
async function formatted(files: GeneratedProject['files']): Promise<GeneratedProject['files']> {
  const prettier = await import('prettier');
  const out: GeneratedProject['files'] = {};
  for (const [path, content] of Object.entries(files)) {
    const parser = PARSER[path.split('.').pop() ?? ''];
    out[path] =
      parser && typeof content === 'string'
        ? await prettier.format(content, { parser, singleQuote: true, printWidth: 110, trailingComma: 'all' })
        : content;
  }
  return out;
}

/** The generated files as a .zip, inside a folder named after the project. */
export async function zipProject(p: GeneratedProject, folder: string): Promise<Buffer> {
  const zip = new JSZip();
  const dir = zip.folder(folder)!;
  for (const [path, content] of Object.entries(p.files))
    dir.file(path, content, { date: new Date('2026-01-01T00:00:00Z') });
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', platform: 'UNIX' });
}
