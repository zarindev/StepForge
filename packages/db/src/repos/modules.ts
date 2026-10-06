import { ModuleInput, ModuleUpdate, newId } from '@stepforge/core';
import { and, eq, inArray, isNull, max } from 'drizzle-orm';
import type { z } from 'zod';
import type { StepForgeDb } from '../index.ts';
import { applications, modules } from '../schema.ts';
import { invalid, notFound, now } from './errors.ts';

export type Module = typeof modules.$inferSelect;

export function getModule(db: StepForgeDb, id: string): Module {
  const m = db.select().from(modules).where(eq(modules.id, id)).get();
  if (!m) throw notFound('Module', id);
  return m;
}

export function listModules(db: StepForgeDb, applicationId: string): Module[] {
  return db
    .select()
    .from(modules)
    .where(eq(modules.applicationId, applicationId))
    .orderBy(modules.sortOrder, modules.name)
    .all();
}

/** All descendant module ids of `id` (not including `id`). */
export function descendantIds(db: StepForgeDb, id: string): string[] {
  const all = db
    .select({ id: modules.id, parentId: modules.parentId })
    .from(modules)
    .where(eq(modules.applicationId, getModule(db, id).applicationId))
    .all();
  const out: string[] = [];
  const queue = [id];
  while (queue.length) {
    const current = queue.shift()!;
    for (const m of all) {
      if (m.parentId === current) {
        out.push(m.id);
        queue.push(m.id);
      }
    }
  }
  return out;
}

function assertValidParent(
  db: StepForgeDb,
  applicationId: string,
  parentId: string | null,
  selfId?: string,
): void {
  if (parentId === null) return;
  const parent = getModule(db, parentId);
  if (parent.applicationId !== applicationId)
    throw invalid('Parent module belongs to a different application');
  if (selfId && (parentId === selfId || descendantIds(db, selfId).includes(parentId))) {
    throw invalid('A module cannot be moved inside itself or one of its sub-modules');
  }
}

function nextSortOrder(db: StepForgeDb, applicationId: string, parentId: string | null): number {
  const row = db
    .select({ m: max(modules.sortOrder) })
    .from(modules)
    .where(
      and(
        eq(modules.applicationId, applicationId),
        parentId ? eq(modules.parentId, parentId) : isNull(modules.parentId),
      ),
    )
    .get();
  return (row?.m ?? -1) + 1;
}

export function createModule(
  db: StepForgeDb,
  applicationId: string,
  input: z.input<typeof ModuleInput>,
): Module {
  if (
    !db.select({ id: applications.id }).from(applications).where(eq(applications.id, applicationId)).get()
  ) {
    throw notFound('Application', applicationId);
  }
  const d = ModuleInput.parse(input);
  assertValidParent(db, applicationId, d.parentId);
  const id = newId();
  db.insert(modules)
    .values({
      id,
      applicationId,
      parentId: d.parentId,
      name: d.name,
      description: d.description,
      sortOrder: input.sortOrder ?? nextSortOrder(db, applicationId, d.parentId),
    })
    .run();
  return getModule(db, id);
}

export function updateModule(db: StepForgeDb, id: string, input: z.input<typeof ModuleUpdate>): Module {
  const current = getModule(db, id);
  const d = ModuleUpdate.parse(input);
  if (d.parentId !== undefined) assertValidParent(db, current.applicationId, d.parentId, id);
  const parentChanged = d.parentId !== undefined && d.parentId !== current.parentId;
  db.update(modules)
    .set({
      ...(d.name !== undefined && { name: d.name }),
      ...(d.description !== undefined && { description: d.description }),
      ...(d.parentId !== undefined && { parentId: d.parentId }),
      ...(d.sortOrder !== undefined
        ? { sortOrder: d.sortOrder }
        : parentChanged
          ? { sortOrder: nextSortOrder(db, current.applicationId, d.parentId ?? null) }
          : {}),
      updatedAt: now(),
    })
    .where(eq(modules.id, id))
    .run();
  return getModule(db, id);
}

/** Deletes a module, its sub-modules and (via FK cascade) their scenarios. */
export function deleteModule(db: StepForgeDb, id: string): void {
  const ids = [id, ...descendantIds(db, id)];
  db.delete(modules).where(inArray(modules.id, ids)).run();
}
