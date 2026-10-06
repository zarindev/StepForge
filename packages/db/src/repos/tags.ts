import { newId, TagInput, TagUpdate } from '@stepforge/core';
import { and, eq, inArray } from 'drizzle-orm';
import type { z } from 'zod';
import type { StepForgeDb } from '../index.ts';
import { scenarioTags, tags } from '../schema.ts';
import { invalid, mapUnique, notFound, now } from './errors.ts';

export type Tag = typeof tags.$inferSelect;

export function listTags(db: StepForgeDb, applicationId: string): Tag[] {
  return db.select().from(tags).where(eq(tags.applicationId, applicationId)).orderBy(tags.name).all();
}

export function getTag(db: StepForgeDb, id: string): Tag {
  const t = db.select().from(tags).where(eq(tags.id, id)).get();
  if (!t) throw notFound('Tag', id);
  return t;
}

export function createTag(db: StepForgeDb, applicationId: string, input: z.input<typeof TagInput>): Tag {
  const d = TagInput.parse(input);
  const id = newId();
  mapUnique(
    () =>
      db
        .insert(tags)
        .values({ id, applicationId, ...d })
        .run(),
    `Tag "${d.name}" already exists in this application`,
  );
  return getTag(db, id);
}

export function updateTag(db: StepForgeDb, id: string, input: z.input<typeof TagUpdate>): Tag {
  getTag(db, id);
  const d = TagUpdate.parse(input);
  mapUnique(
    () =>
      db
        .update(tags)
        .set({ ...d, updatedAt: now() })
        .where(eq(tags.id, id))
        .run(),
    `Tag "${d.name}" already exists in this application`,
  );
  return getTag(db, id);
}

export function deleteTag(db: StepForgeDb, id: string): void {
  getTag(db, id);
  db.delete(tags).where(eq(tags.id, id)).run();
}

/** Replaces the tags of a scenario. All tags must belong to `applicationId`. */
export function setScenarioTags(
  db: StepForgeDb,
  applicationId: string,
  scenarioId: string,
  tagIds: string[],
): void {
  const unique = [...new Set(tagIds)];
  if (unique.length) {
    const found = db
      .select({ id: tags.id })
      .from(tags)
      .where(and(eq(tags.applicationId, applicationId), inArray(tags.id, unique)))
      .all();
    if (found.length !== unique.length) throw invalid('One or more tags do not belong to this application');
  }
  db.transaction(() => {
    db.delete(scenarioTags).where(eq(scenarioTags.scenarioId, scenarioId)).run();
    if (unique.length)
      db.insert(scenarioTags)
        .values(unique.map((tagId) => ({ scenarioId, tagId })))
        .run();
  });
}

export function tagIdsForScenarios(db: StepForgeDb, scenarioIds: string[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  if (!scenarioIds.length) return map;
  for (const row of db
    .select()
    .from(scenarioTags)
    .where(inArray(scenarioTags.scenarioId, scenarioIds))
    .all()) {
    map.set(row.scenarioId, [...(map.get(row.scenarioId) ?? []), row.tagId]);
  }
  return map;
}
