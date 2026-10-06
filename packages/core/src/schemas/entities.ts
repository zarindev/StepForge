import { z } from 'zod';
import { HexColor, Priority, Slug } from './common.ts';

/** Input schemas for creating/updating entities through the API. Shared by server, UI and CLI. */

export const ApplicationInput = z.object({
  name: z.string().min(1).max(120),
  slug: Slug,
  description: z.string().max(2000).default(''),
  icon: z.string().max(40).default('app-window'),
  color: HexColor.default('#F97316'),
  category: z.string().max(60).default('web'),
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

export const ApplicationUpdate = ApplicationInput.partial().extend({ archived: z.boolean().optional() });
export const EnvironmentUpdate = EnvironmentInput.partial();
export const ModuleUpdate = z.object({
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(2000).optional(),
  parentId: z.string().nullable().optional(),
  sortOrder: z.number().int().optional(),
});
export const ScenarioUpdate = ScenarioInput.partial().extend({ moduleId: z.string().optional() });
export const TestCaseUpdate = TestCaseInput.partial();
export const TagInput = z.object({
  name: z.string().min(1).max(40),
  color: HexColor.default('#6366F1'),
});
export const TagUpdate = TagInput.partial();

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
});
export type RunOptionsInput = z.infer<typeof RunOptionsInput>;

export const CreateRunInput = z.object({
  applicationId: z.string(),
  environmentId: z.string(),
  scope: RunScope,
  options: RunOptionsInput.default(RunOptionsInput.parse({})),
  trigger: RunTrigger.default('manual'),
});
export type CreateRunInput = z.infer<typeof CreateRunInput>;
