import { z } from 'zod';

/**
 * Like `.partial()`, but without the input schema's defaults: zod applies `.default()` even inside a
 * partial, so a PATCH that omits a field would silently reset it to its default.
 */
export function patchOf<T extends z.ZodRawShape>(schema: z.ZodObject<T>) {
  const shape = Object.fromEntries(
    Object.entries(schema.shape).map(([k, v]) => [
      k,
      (v instanceof z.ZodDefault ? (v.unwrap() as z.ZodType) : (v as z.ZodType)).optional(),
    ]),
  );
  return z.object(shape) as unknown as z.ZodObject<{
    [K in keyof T]: z.ZodOptional<T[K] extends z.ZodDefault<infer I extends z.ZodType> ? I : T[K]>;
  }>;
}
import { HexColor, Priority, Slug } from './common.ts';

/** Input schemas for creating/updating entities through the API. Shared by server, UI and CLI. */

export const ApplicationInput = z.object({
  name: z.string().min(1).max(120),
  slug: Slug,
  description: z.string().max(2000).default(''),
  icon: z.string().max(40).default('app-window'),
  color: HexColor.default('#F97316'),
  category: z.string().max(60).default('web'),
  /**
   * web: tested in a browser; electron: an Electron desktop app; android / ios: a phone app; macos / windows: a
   * native desktop app (phone and native desktop apps run through Appium). Apps are started as configured in each
   * environment.
   */
  platform: z.enum(['web', 'electron', 'android', 'ios', 'macos', 'windows', 'linux']).default('web'),
  tags: z.array(z.string().max(40)).default([]),
});
export type ApplicationInput = z.infer<typeof ApplicationInput>;

export const BrowserName = z.enum(['chromium', 'firefox', 'webkit']);
export const Viewport = z.object({ width: z.number().int().min(200), height: z.number().int().min(200) });
export const VIEWPORT_PRESETS = {
  desktop: { width: 1440, height: 900 },
  tablet: { width: 768, height: 1024 },
  mobile: { width: 390, height: 844 },
} as const;

/**
 * How an environment starts an Electron desktop app: its executable (a packaged app), or an app folder / main script
 * started with the Electron found in that project. Text values may use {{env.x}} / {{secret.x}}.
 */
export const ElectronLaunchInput = z
  .object({
    executablePath: z.string().max(1000).optional(),
    appPath: z.string().max(1000).optional(),
    args: z.array(z.string().max(1000)).max(50).default([]),
    cwd: z.string().max(1000).optional(),
    env: z.record(z.string(), z.string()).default({}),
  })
  .refine((e) => e.executablePath || e.appPath, 'Set the app executable or the app folder');

/**
 * How an environment starts an Android app: the app file (.apk) or an installed app's package (and activity), on an
 * emulator (AVD name, started when needed) or a device (adb serial; empty = the only one connected). By default the
 * app's data is cleared before each test. `capabilities` are extra Appium capabilities. Text values may use
 * {{env.x}} / {{secret.x}}.
 */
export const AndroidLaunchInput = z
  .object({
    app: z.string().max(1000).optional(),
    appPackage: z.string().max(300).optional(),
    appActivity: z.string().max(300).optional(),
    avd: z.string().max(200).optional(),
    udid: z.string().max(200).optional(),
    resetApp: z.boolean().default(true),
    showEmulator: z.boolean().default(false),
    capabilities: z.record(z.string(), z.unknown()).default({}),
  })
  .refine((a) => a.app || a.appPackage, "Set the app file (.apk) or the installed app's package");

/**
 * How an environment starts an iOS app (macOS with Xcode only): the app (.app for simulators, .ipa for iPhones) or an
 * installed app's bundle id, on a simulator (by name, e.g. "iPhone 17"; empty = the first iPhone simulator) or an
 * iPhone (udid). By default the app's data is reset before each test. Text values may use {{env.x}} / {{secret.x}}.
 */
export const IosLaunchInput = z
  .object({
    app: z.string().max(1000).optional(),
    bundleId: z.string().max(300).optional(),
    simulator: z.string().max(200).optional(),
    platformVersion: z.string().max(20).optional(),
    udid: z.string().max(200).optional(),
    resetApp: z.boolean().default(true),
    showSimulator: z.boolean().default(false),
    capabilities: z.record(z.string(), z.unknown()).default({}),
  })
  .refine((a) => a.app || a.bundleId, "Set the app (.app or .ipa) or the installed app's bundle id");

/**
 * How an environment starts a native macOS app (on a Mac with Xcode): an installed app's bundle id (e.g.
 * com.apple.TextEdit) or the .app's path, with launch arguments and environment variables. Text values may use
 * {{env.x}} / {{secret.x}}.
 */
export const MacLaunchInput = z
  .object({
    bundleId: z.string().max(300).optional(),
    appPath: z.string().max(1000).optional(),
    arguments: z.array(z.string().max(1000)).max(50).default([]),
    environment: z.record(z.string(), z.string()).default({}),
    capabilities: z.record(z.string(), z.unknown()).default({}),
  })
  .refine((a) => a.bundleId || a.appPath, "Set the app's bundle id or its .app path");

/**
 * How an environment starts a native Windows app (Win32, WPF, WinForms, UWP): the .exe path or a Store app's id
 * (AUMID), its arguments and working folder. Text values may use {{env.x}} / {{secret.x}}.
 */
export const WindowsLaunchInput = z.object({
  app: z.string().min(1, "Set the app's .exe path or its app id").max(1000),
  arguments: z.string().max(2000).optional(),
  workingDir: z.string().max(1000).optional(),
  capabilities: z.record(z.string(), z.unknown()).default({}),
});

/**
 * How an environment starts a Linux desktop app (GTK, Qt): its command (a path or a name on the PATH), arguments,
 * environment variables and working folder. Text values may use {{env.x}} / {{secret.x}}.
 */
export const LinuxLaunchInput = z.object({
  app: z.string().min(1, "Set the app's command or path").max(1000),
  arguments: z.array(z.string().max(1000)).max(50).default([]),
  environment: z.record(z.string(), z.string()).default({}),
  workingDir: z.string().max(1000).optional(),
});

/** An environment's browser settings (see BrowserSettings); text values may use {{secret.x}} / {{env.x}}. */
export const BrowserSettingsInput = z.object({
  channel: z.enum(['chrome', 'msedge']).optional(),
  locale: z.string().max(20).optional(),
  timezoneId: z.string().max(60).optional(),
  colorScheme: z.enum(['light', 'dark', 'no-preference']).optional(),
  reducedMotion: z.enum(['reduce', 'no-preference']).optional(),
  geolocation: z
    .object({
      latitude: z.number().min(-90).max(90),
      longitude: z.number().min(-180).max(180),
      accuracy: z.number().min(0).optional(),
    })
    .optional(),
  permissions: z.array(z.string().max(60)).max(30).optional(),
  userAgent: z.string().max(500).optional(),
  extraHTTPHeaders: z.record(z.string(), z.string()).optional(),
  httpCredentials: z.object({ username: z.string(), password: z.string() }).optional(),
  proxy: z
    .object({
      server: z.string().min(1),
      bypass: z.string().optional(),
      username: z.string().optional(),
      password: z.string().optional(),
    })
    .optional(),
  clientCertificates: z
    .array(
      z.object({
        origin: z.string().min(1),
        certPath: z.string().optional(),
        keyPath: z.string().optional(),
        pfxPath: z.string().optional(),
        passphrase: z.string().optional(),
      }),
    )
    .max(10)
    .optional(),
  serviceWorkers: z.enum(['allow', 'block']).optional(),
  javaScriptEnabled: z.boolean().optional(),
});

export const EnvironmentInput = z.object({
  name: z.string().min(1).max(60),
  baseUrl: z.url(),
  isProduction: z.boolean().default(false),
  variables: z.record(z.string(), z.string()).default({}),
  browserDefaults: z
    .object({
      browser: BrowserName.default('chromium'),
      viewport: Viewport.optional(),
      headless: z.boolean().default(true),
      settings: BrowserSettingsInput.optional(),
      electron: ElectronLaunchInput.optional(),
      android: AndroidLaunchInput.optional(),
      ios: IosLaunchInput.optional(),
      macos: MacLaunchInput.optional(),
      windows: WindowsLaunchInput.optional(),
      linux: LinuxLaunchInput.optional(),
    })
    .default({ browser: 'chromium', headless: true }),
});
export type EnvironmentInput = z.infer<typeof EnvironmentInput>;

export const SecretInput = z.object({
  key: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
  value: z.string().min(1),
});

export const DbEngine = z.enum(['pg', 'mysql', 'mssql', 'sqlite', 'mongo']);
export const DbConnectionInput = z.object({
  name: z.string().min(1).max(80),
  engine: DbEngine,
  host: z.string().default(''),
  port: z.number().int().min(0).max(65535).optional(),
  database: z.string().default(''),
  username: z.string().default(''),
  password: z.string().optional(),
  options: z.record(z.string(), z.unknown()).default({}),
  readOnly: z.boolean().default(true),
  rollbackMode: z.boolean().default(true),
});
export type DbConnectionInput = z.infer<typeof DbConnectionInput>;
/** `password: null` clears the stored password; omitting it keeps the current one. */
export const DbConnectionUpdate = patchOf(DbConnectionInput).extend({
  password: z.string().nullable().optional(),
});

/** An inbox email steps read from: a Mailpit instance, or any IMAP mailbox (password stored encrypted). */
export const InboxInput = z.object({
  name: z.string().trim().min(1).max(60),
  kind: z.enum(['mailpit', 'imap']),
  config: z
    .object({
      /** Mailpit: web/API URL. Empty = StepForge's own local Mailpit. */
      url: z.string().max(500).optional(),
      host: z.string().max(255).optional(),
      port: z.number().int().min(1).max(65535).optional(),
      secure: z.boolean().optional(),
      user: z.string().max(255).optional(),
      mailbox: z.string().max(255).optional(),
      allowSelfSigned: z.boolean().optional(),
    })
    .default({}),
  password: z.string().max(1000).optional(),
});
export const InboxUpdate = patchOf(InboxInput).extend({
  password: z.string().max(1000).nullable().optional(),
});

export const ModuleInput = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(2000).default(''),
  parentId: z.string().nullable().default(null),
  sortOrder: z.number().int().default(0),
});

export const ScenarioStatus = z.enum(['draft', 'ready', 'deprecated']);
export const ScenarioInput = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(5000).default(''),
  priority: Priority.default('P2'),
  status: ScenarioStatus.default('draft'),
  owner: z.string().max(80).default(''),
  preconditions: z.string().max(5000).default(''),
  /** Hooks: a block run before / after this test (inside the module's hooks). */
  setupBlockId: z.string().nullable().default(null),
  teardownBlockId: z.string().nullable().default(null),
  /** automated: run by StepForge (and schedules); manual: run by a person, pending until then. */
  execution: z.enum(['automated', 'manual']).default('automated'),
});

export const TestTechnique = z.enum([
  'positive',
  'negative',
  'boundary',
  'equivalence',
  'error-guessing',
  'security',
  'other',
]);
export const TestCaseInput = z.object({
  /** Optional: generated as TC-<MODULE>-NNN when omitted. */
  code: z.string().min(1).max(40).optional(),
  title: z.string().min(1).max(200),
  data: z.record(z.string(), z.unknown()).default({}),
  expectedResult: z.string().max(5000).default(''),
  priority: Priority.default('P2'),
  technique: TestTechnique.default('positive'),
  status: z.enum(['active', 'skipped']).default('active'),
});

export const RunStatus = z.enum(['queued', 'running', 'passed', 'failed', 'interrupted', 'cancelled']);
export const RunItemStatus = z.enum(['passed', 'failed', 'broken', 'skipped', 'flaky']);
export const RunTrigger = z.enum(['manual', 'schedule', 'cli', 'retry']);

// ─── Update / action schemas (Phase 2) ─────────────────────────────────────

export const ApplicationUpdate = patchOf(ApplicationInput).extend({ archived: z.boolean().optional() });
export const EnvironmentUpdate = patchOf(EnvironmentInput);
export const ModuleUpdate = z.object({
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(2000).optional(),
  parentId: z.string().nullable().optional(),
  sortOrder: z.number().int().optional(),
  /** Hooks: a block run before / after every test in this module and its sub-modules. */
  setupBlockId: z.string().nullable().optional(),
  teardownBlockId: z.string().nullable().optional(),
});
export const ScenarioUpdate = patchOf(ScenarioInput).extend({ moduleId: z.string().optional() });
export const TestCaseUpdate = patchOf(TestCaseInput);
export const TagInput = z.object({
  name: z.string().min(1).max(40),
  color: HexColor.default('#6366F1'),
});
export const TagUpdate = patchOf(TagInput);

export const BulkScenarioAction = z.discriminatedUnion('action', [
  z.object({ action: z.literal('delete'), ids: z.array(z.string()).min(1) }),
  z.object({ action: z.literal('duplicate'), ids: z.array(z.string()).min(1) }),
  z.object({ action: z.literal('move'), ids: z.array(z.string()).min(1), moduleId: z.string() }),
  z.object({ action: z.literal('addTag'), ids: z.array(z.string()).min(1), tagId: z.string() }),
  z.object({ action: z.literal('removeTag'), ids: z.array(z.string()).min(1), tagId: z.string() }),
  z.object({
    action: z.literal('setStatus'),
    ids: z.array(z.string()).min(1),
    status: ScenarioStatus,
  }),
]);
export type BulkScenarioAction = z.infer<typeof BulkScenarioAction>;

/** Turns a display name into a URL-safe slug. */
export function slugify(name: string): string {
  return (
    name
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 64) || 'app'
  );
}

// ─── Runs (Phase 3) ────────────────────────────────────────────────────────

export const RunScope = z.discriminatedUnion('type', [
  z.object({ type: z.literal('application') }),
  z.object({ type: z.literal('module'), id: z.string() }),
  z.object({ type: z.literal('scenarios'), ids: z.array(z.string()).min(1) }),
  z.object({ type: z.literal('testCases'), ids: z.array(z.string()).min(1) }),
  z.object({ type: z.literal('tag'), id: z.string() }),
]);
export type RunScope = z.infer<typeof RunScope>;

export const EvidenceModeSchema = z.enum(['off', 'onFailure', 'always']);
export const RunOptionsInput = z.object({
  browser: BrowserName.default('chromium'),
  viewport: z.enum(['desktop', 'tablet', 'mobile']).default('desktop'),
  headed: z.boolean().default(false),
  workers: z.number().int().min(1).max(8).default(1),
  retries: z.number().int().min(0).max(3).default(0),
  stopOnFirstFailure: z.boolean().default(false),
  video: EvidenceModeSchema.default('onFailure'),
  trace: EvidenceModeSchema.default('onFailure'),
  screenshots: z.enum(['off', 'onFailure', 'everyStep']).default('everyStep'),
  timeoutMs: z.number().int().min(1000).max(600_000).optional(),
  /** Record Web Vitals (LCP, CLS, TTFB, load time…) after every ui.navigate. */
  pageMetrics: z.boolean().default(false),
  /** Place in the run queue: high runs before normal, normal before low. */
  priority: z.enum(['high', 'normal', 'low']).default('normal'),
});
export type RunOptionsInput = z.infer<typeof RunOptionsInput>;

export const CreateRunInput = z.object({
  applicationId: z.string(),
  environmentId: z.string(),
  scope: RunScope,
  options: RunOptionsInput.default(RunOptionsInput.parse({})),
  trigger: RunTrigger.default('manual'),
  /** manual: nothing is executed; a person follows the steps and records each one's result. */
  mode: z.enum(['auto', 'manual']).default('auto'),
});
export type CreateRunInput = z.infer<typeof CreateRunInput>;
