import { STEP_CATALOGUE, STEPFORGE_VERSION } from '@stepforge/core';
import { getSetting, schema, setSetting } from '@stepforge/db';
import { count } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.ts';

/** Settings the dashboard may read/write. Unknown keys are rejected. */
export const SETTINGS_SCHEMAS = {
  theme: z.enum(['dark', 'light', 'system']),
  onboardingComplete: z.boolean(),
  defaultBrowser: z.enum(['chromium', 'firefox', 'webkit']),
  defaultViewport: z.enum(['desktop', 'tablet', 'mobile']),
  defaultTimeoutMs: z.number().int().min(1000).max(600_000),
  workers: z.number().int().min(1).max(16),
  retention: z.object({ keepFailures: z.boolean(), prunePassesAfterDays: z.number().int().min(1).max(3650) }),
  ollama: z.object({ url: z.url(), model: z.string() }),
  k6Path: z.string(),
  /** Shown on every generated report and bug export. */
  reportBranding: z.object({
    author: z.string().trim().min(1).max(120),
    company: z.string().max(120),
    accent: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  }),
} as const;
type SettingKey = keyof typeof SETTINGS_SCHEMAS;

export const SETTINGS_DEFAULTS: { [K in SettingKey]: z.infer<(typeof SETTINGS_SCHEMAS)[K]> } = {
  theme: 'dark',
  onboardingComplete: false,
  defaultBrowser: 'chromium',
  defaultViewport: 'desktop',
  defaultTimeoutMs: 15_000,
  workers: 2,
  retention: { keepFailures: true, prunePassesAfterDays: 14 },
  ollama: { url: 'http://localhost:11434', model: 'llama3.1' },
  k6Path: '',
  reportBranding: { author: 'Md Zarin Tasnim', company: '', accent: '#F97316' },
};

export function registerSystemRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/health', async () => ({ ok: true, name: 'StepForge', version: STEPFORGE_VERSION }));

  app.get('/api/system', async () => {
    const counts = Object.fromEntries(
      (
        [
          ['applications', schema.applications],
          ['scenarios', schema.scenarios],
          ['testCases', schema.testCases],
          ['runs', schema.runs],
          ['openBugs', schema.bugs],
        ] as const
      ).map(([k, table]) => [k, ctx.db.select({ n: count() }).from(table).get()?.n ?? 0]),
    );
    return {
      version: STEPFORGE_VERSION,
      node: process.version,
      platform: process.platform,
      dataDir: ctx.config.dataDir,
      startedAt: ctx.startedAt.toISOString(),
      counts,
      stepCatalogue: STEP_CATALOGUE,
    };
  });

  app.get('/api/settings', async () => {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(SETTINGS_SCHEMAS) as SettingKey[]) {
      out[key] = getSetting(ctx.db, key, SETTINGS_DEFAULTS[key]);
    }
    return out;
  });

  app.put<{ Params: { key: string }; Body: { value: unknown } }>('/api/settings/:key', async (req, reply) => {
    const key = req.params.key as SettingKey;
    const schemaForKey = SETTINGS_SCHEMAS[key];
    if (!schemaForKey)
      return reply.code(404).send({ error: 'unknown_setting', message: `Unknown setting "${key}"` });
    const value = schemaForKey.parse(req.body?.value);
    setSetting(ctx.db, key, value);
    ctx.bus.publish({ type: 'settings.changed', key });
    return { key, value };
  });
}

/** Settings → Runner defaults, for runs that do not choose their own options (schedules, CLI). */
export function runDefaults(db: AppContext['db']): {
  browser: 'chromium' | 'firefox' | 'webkit';
  viewport: 'desktop' | 'tablet' | 'mobile';
  workers: number;
} {
  return {
    browser: getSetting(db, 'defaultBrowser', SETTINGS_DEFAULTS.defaultBrowser),
    viewport: getSetting(db, 'defaultViewport', SETTINGS_DEFAULTS.defaultViewport),
    workers: Math.min(8, getSetting(db, 'workers', SETTINGS_DEFAULTS.workers)),
  };
}
