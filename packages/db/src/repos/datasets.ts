import { newId } from '@stepforge/core';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { StepForgeDb } from '../index.ts';
import {
  applications,
  blocks,
  blockSteps,
  datasets,
  modules,
  scenarios,
  steps as scenarioSteps,
} from '../schema.ts';
import { invalid, notFound, now } from './errors.ts';

/**
 * The test data library: named data sources that tests read rows from with
 * `util.useData`. Sources are referenced by name, like database connections.
 */
export type DataSource = typeof datasets.$inferSelect;

const Name = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[A-Za-z][A-Za-z0-9 _-]*$/, 'Names start with a letter and use letters, digits, spaces, - and _');
const Column = z.string().trim().min(1).max(80);
const Common = { name: Name, description: z.string().max(2000).default('') };

export const DataSourceInput = z.discriminatedUnion('kind', [
  z.object({
    ...Common,
    kind: z.literal('table'),
    columns: z.array(Column).min(1, 'A table needs at least one column').max(50),
    rows: z.array(z.record(z.string(), z.unknown())).max(5000).default([]),
  }),
  z.object({
    ...Common,
    kind: z.literal('csv'),
    /** An absolute path, or relative to StepForge's data folder. */
    config: z.object({ path: z.string().trim().min(1).max(1000) }),
  }),
  z.object({
    ...Common,
    kind: z.literal('sql'),
    /** A connection name of the run's environment; the query runs read-only. */
    config: z.object({ connection: z.string().trim().min(1), query: z.string().trim().min(1).max(20_000) }),
  }),
  z.object({
    ...Common,
    kind: z.literal('api'),
    config: z.object({
      method: z.enum(['GET', 'POST']).default('GET'),
      /** Absolute, or relative to the environment's base URL; placeholders allowed. */
      url: z.string().trim().min(1).max(2000),
      headers: z.record(z.string(), z.string()).default({}),
      body: z.string().max(100_000).optional(),
      /** JSONPath to the list of rows in the response, e.g. `$.items` (default: the response itself). */
      rowsPath: z.string().trim().max(500).default('$'),
    }),
  }),
]);

function row(db: StepForgeDb, id: string): DataSource {
  const d = db.select().from(datasets).where(eq(datasets.id, id)).get();
  if (!d) throw notFound('Data source', id);
  return d;
}
export const getDataSource = row;

export function findDataSource(db: StepForgeDb, applicationId: string, name: string): DataSource | undefined {
  return db
    .select()
    .from(datasets)
    .where(and(eq(datasets.applicationId, applicationId), eq(datasets.name, name)))
    .get();
}

/** Usage of each data source name in an application's scenarios and blocks (steps reference sources by name). */
function usage(db: StepForgeDb, applicationId: string): Map<string, number> {
  const counts = new Map<string, number>();
  const walk = (list: { type?: string; params?: Record<string, unknown> }[]) => {
    for (const s of list) {
      if (s.type === 'util.useData' && typeof s.params?.source === 'string')
        counts.set(s.params.source, (counts.get(s.params.source) ?? 0) + 1);
      for (const key of ['steps', 'else']) {
        const nested = s.params?.[key];
        if (Array.isArray(nested)) walk(nested as never);
      }
    }
  };
  const scen = db
    .select({ id: scenarios.id })
    .from(scenarios)
    .innerJoin(modules, eq(scenarios.moduleId, modules.id))
    .where(eq(modules.applicationId, applicationId))
    .all();
  for (const sc of scen)
    walk(
      db
        .select()
        .from(scenarioSteps)
        .where(eq(scenarioSteps.scenarioId, sc.id))
        .all()
        .map((r) => ({ type: r.type, params: r.paramsJson })),
    );
  for (const b of db
    .select({ id: blocks.id })
    .from(blocks)
    .where(eq(blocks.applicationId, applicationId))
    .all())
    walk(
      db
        .select()
        .from(blockSteps)
        .where(eq(blockSteps.blockId, b.id))
        .all()
        .map((r) => ({ type: r.type, params: r.paramsJson })),
    );
  return counts;
}

export function listDataSources(
  db: StepForgeDb,
  applicationId: string,
): (DataSource & { usedBySteps: number })[] {
  const used = usage(db, applicationId);
  return db
    .select()
    .from(datasets)
    .where(eq(datasets.applicationId, applicationId))
    .orderBy(datasets.name)
    .all()
    .map((d) => ({ ...d, usedBySteps: used.get(d.name) ?? 0 }));
}

function values(input: z.infer<typeof DataSourceInput>) {
  if (input.kind === 'table') {
    const columns = [...new Set(input.columns)];
    return {
      kind: input.kind,
      name: input.name,
      description: input.description,
      configJson: {},
      columnsJson: columns,
      // Keep only the declared columns, as text (what a CSV or a form would give).
      rowsJson: input.rows.map((r) =>
        Object.fromEntries(columns.map((c) => [c, r[c] === undefined || r[c] === null ? '' : String(r[c])])),
      ),
    };
  }
  return {
    kind: input.kind,
    name: input.name,
    description: input.description,
    configJson: input.config as Record<string, unknown>,
    columnsJson: [],
    rowsJson: [],
  };
}

function assertUnique(db: StepForgeDb, applicationId: string, name: string, except?: string) {
  const clash = findDataSource(db, applicationId, name);
  if (clash && clash.id !== except) throw invalid(`A data source named "${name}" already exists`);
}

export function createDataSource(db: StepForgeDb, applicationId: string, input: unknown): DataSource {
  if (!db.select({ id: applications.id }).from(applications).where(eq(applications.id, applicationId)).get())
    throw notFound('Application', applicationId);
  const d = DataSourceInput.parse(input);
  assertUnique(db, applicationId, d.name);
  const id = newId();
  db.insert(datasets)
    .values({ id, applicationId, ...values(d) })
    .run();
  return row(db, id);
}

export function updateDataSource(db: StepForgeDb, id: string, input: unknown): DataSource {
  const current = row(db, id);
  const d = DataSourceInput.parse(input);
  assertUnique(db, current.applicationId, d.name, id);
  db.transaction(() => {
    db.update(datasets)
      .set({ ...values(d), updatedAt: now() })
      .where(eq(datasets.id, id))
      .run();
    // Steps reference sources by name, so a rename carries over to them.
    if (d.name !== current.name) renameInSteps(db, current.applicationId, current.name, d.name);
  });
  return row(db, id);
}

/** Rewrites `params.source` of the application's `util.useData` steps (nested ones too) from one name to another. */
function renameInSteps(db: StepForgeDb, applicationId: string, from: string, to: string) {
  const rewrite = (type: string, params: Record<string, unknown>): Record<string, unknown> | undefined => {
    let changed = false;
    const next: Record<string, unknown> = { ...params };
    if (type === 'util.useData' && params.source === from) {
      next.source = to;
      changed = true;
    }
    for (const key of ['steps', 'else']) {
      const nested = params[key];
      if (!Array.isArray(nested)) continue;
      next[key] = nested.map((s: { type?: string; params?: Record<string, unknown> }) => {
        const p = s && typeof s === 'object' && s.params ? rewrite(String(s.type), s.params) : undefined;
        if (!p) return s;
        changed = true;
        return { ...s, params: p };
      });
    }
    return changed ? next : undefined;
  };
  const scen = db
    .select({ id: scenarios.id })
    .from(scenarios)
    .innerJoin(modules, eq(scenarios.moduleId, modules.id))
    .where(eq(modules.applicationId, applicationId))
    .all();
  for (const sc of scen)
    for (const r of db.select().from(scenarioSteps).where(eq(scenarioSteps.scenarioId, sc.id)).all()) {
      const p = rewrite(r.type, r.paramsJson);
      if (p) db.update(scenarioSteps).set({ paramsJson: p }).where(eq(scenarioSteps.id, r.id)).run();
    }
  for (const b of db
    .select({ id: blocks.id })
    .from(blocks)
    .where(eq(blocks.applicationId, applicationId))
    .all())
    for (const r of db.select().from(blockSteps).where(eq(blockSteps.blockId, b.id)).all()) {
      const p = rewrite(r.type, r.paramsJson);
      if (p) db.update(blockSteps).set({ paramsJson: p }).where(eq(blockSteps.id, r.id)).run();
    }
}

export function deleteDataSource(db: StepForgeDb, id: string): void {
  row(db, id);
  db.delete(datasets).where(eq(datasets.id, id)).run();
}
