import { ApplicationInput, ApplicationUpdate, newId } from '@stepforge/core';
import { and, count, eq, inArray } from 'drizzle-orm';
import type { z } from 'zod';
import type { StepForgeDb } from '../index.ts';
import { applications, bugs, environments, modules, runs, scenarios, testCases } from '../schema.ts';
import { listEnvironments, purgeConnectionSecrets } from './environments.ts';
import { mapUnique, notFound, now } from './errors.ts';
import { purgeInboxSecrets } from './inboxes.ts';

export type Application = typeof applications.$inferSelect;
export type ApplicationSummary = Application & {
  counts: {
    environments: number;
    modules: number;
    scenarios: number;
    testCases: number;
    runs: number;
    openBugs: number;
  };
  hasProduction: boolean;
};

export function listApplications(
  db: StepForgeDb,
  opts: { includeArchived?: boolean } = {},
): ApplicationSummary[] {
  const apps = db
    .select()
    .from(applications)
    .where(opts.includeArchived ? undefined : eq(applications.archived, false))
    .orderBy(applications.name)
    .all();
  return apps.map((a) => summarize(db, a));
}

function summarize(db: StepForgeDb, app: Application): ApplicationSummary {
  const n = (q: { n: number } | undefined) => q?.n ?? 0;
  const moduleIds = db
    .select({ id: modules.id })
    .from(modules)
    .where(eq(modules.applicationId, app.id))
    .all()
    .map((m) => m.id);
  const scenarioIds = moduleIds.length
    ? db
        .select({ id: scenarios.id })
        .from(scenarios)
        .where(inArray(scenarios.moduleId, moduleIds))
        .all()
        .map((s) => s.id)
    : [];
  const envs = db.select().from(environments).where(eq(environments.applicationId, app.id)).all();
  return {
    ...app,
    hasProduction: envs.some((e) => e.isProduction),
    counts: {
      environments: envs.length,
      modules: moduleIds.length,
      scenarios: scenarioIds.length,
      testCases: scenarioIds.length
        ? n(db.select({ n: count() }).from(testCases).where(inArray(testCases.scenarioId, scenarioIds)).get())
        : 0,
      runs: n(db.select({ n: count() }).from(runs).where(eq(runs.applicationId, app.id)).get()),
      openBugs: n(
        db
          .select({ n: count() })
          .from(bugs)
          .where(and(eq(bugs.applicationId, app.id), inArray(bugs.status, ['open', 'in_progress'])))
          .get(),
      ),
    },
  };
}

export function getApplication(db: StepForgeDb, id: string): ApplicationSummary {
  const app = db.select().from(applications).where(eq(applications.id, id)).get();
  if (!app) throw notFound('Application', id);
  return summarize(db, app);
}

export function getApplicationBySlug(db: StepForgeDb, slug: string): Application | undefined {
  return db.select().from(applications).where(eq(applications.slug, slug)).get();
}

export function createApplication(
  db: StepForgeDb,
  input: z.input<typeof ApplicationInput>,
): ApplicationSummary {
  const data = ApplicationInput.parse(input);
  const id = newId();
  mapUnique(
    () =>
      db
        .insert(applications)
        .values({ id, ...data, tagsJson: data.tags })
        .run(),
    `An application with slug "${data.slug}" already exists`,
  );
  return getApplication(db, id);
}

export function updateApplication(
  db: StepForgeDb,
  id: string,
  input: z.input<typeof ApplicationUpdate>,
): ApplicationSummary {
  const { tags, ...rest } = ApplicationUpdate.parse(input);
  getApplication(db, id);
  mapUnique(
    () =>
      db
        .update(applications)
        .set({ ...rest, ...(tags ? { tagsJson: tags } : {}), updatedAt: now() })
        .where(eq(applications.id, id))
        .run(),
    `An application with slug "${rest.slug}" already exists`,
  );
  return getApplication(db, id);
}

/** Deletes an application and (via cascades) everything it owns. Modules are removed explicitly. */
export function deleteApplication(db: StepForgeDb, id: string): void {
  getApplication(db, id);
  db.transaction(() => {
    purgeConnectionSecrets(
      db,
      listEnvironments(db, id).map((e) => e.id),
    );
    purgeInboxSecrets(db, id);
    db.delete(modules).where(eq(modules.applicationId, id)).run();
    db.delete(applications).where(eq(applications.id, id)).run();
  });
}

export function applicationIdForModule(db: StepForgeDb, moduleId: string): string {
  const m = db.select({ a: modules.applicationId }).from(modules).where(eq(modules.id, moduleId)).get();
  if (!m) throw notFound('Module', moduleId);
  return m.a;
}
