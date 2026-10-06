import { newId, type StepInput } from '@stepforge/core';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { StepForgeDb } from '../index.ts';
import { applications, blocks, blockSteps } from '../schema.ts';
import { notFound, now } from './errors.ts';
import { parseSteps, toStepRecord, type StepRecord } from './scenarios.ts';

/** Reusable step groups such as "Login as Admin", used by `util.useBlock`. */
export type Block = typeof blocks.$inferSelect & { steps: StepRecord[] };

const BlockInput = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(2000).default(''),
});

function blockRow(db: StepForgeDb, id: string) {
  const b = db.select().from(blocks).where(eq(blocks.id, id)).get();
  if (!b) throw notFound('Block', id);
  return b;
}

export function getBlock(db: StepForgeDb, id: string): Block {
  const b = blockRow(db, id);
  return {
    ...b,
    steps: db
      .select()
      .from(blockSteps)
      .where(eq(blockSteps.blockId, id))
      .orderBy(blockSteps.position)
      .all()
      .map(toStepRecord),
  };
}

export function listBlocks(
  db: StepForgeDb,
  applicationId: string,
): (typeof blocks.$inferSelect & { stepCount: number })[] {
  return db
    .select()
    .from(blocks)
    .where(eq(blocks.applicationId, applicationId))
    .orderBy(blocks.name)
    .all()
    .map((b) => ({
      ...b,
      stepCount: db.select().from(blockSteps).where(eq(blockSteps.blockId, b.id)).all().length,
    }));
}

export function saveBlockSteps(db: StepForgeDb, id: string, input: (StepInput & { id?: string })[]): Block {
  blockRow(db, id);
  const parsed = parseSteps(input);
  db.transaction(() => {
    db.delete(blockSteps).where(eq(blockSteps.blockId, id)).run();
    if (parsed.length) {
      db.insert(blockSteps)
        .values(
          parsed.map((s, position) => ({
            id: newId(),
            blockId: id,
            position,
            type: s.type,
            label: s.label ?? '',
            paramsJson: s.params,
            locatorsJson: s.locators,
            assertionsJson: s.assertions,
            enabled: s.enabled,
            continueOnFail: s.continueOnFail,
            timeoutMs: s.timeoutMs ?? null,
            retries: s.retries,
            captureAs: s.captureAs ?? null,
          })),
        )
        .run();
    }
    db.update(blocks).set({ updatedAt: now() }).where(eq(blocks.id, id)).run();
  });
  return getBlock(db, id);
}

export function createBlock(
  db: StepForgeDb,
  applicationId: string,
  input: z.input<typeof BlockInput> & { steps?: (StepInput & { id?: string })[] },
): Block {
  if (
    !db.select({ id: applications.id }).from(applications).where(eq(applications.id, applicationId)).get()
  ) {
    throw notFound('Application', applicationId);
  }
  const d = BlockInput.parse(input);
  const id = newId();
  db.insert(blocks)
    .values({ id, applicationId, ...d })
    .run();
  return input.steps?.length ? saveBlockSteps(db, id, input.steps) : getBlock(db, id);
}

export function updateBlock(db: StepForgeDb, id: string, input: Partial<z.input<typeof BlockInput>>): Block {
  blockRow(db, id);
  const d = BlockInput.partial().parse(input);
  db.update(blocks)
    .set({ ...d, updatedAt: now() })
    .where(eq(blocks.id, id))
    .run();
  return getBlock(db, id);
}

export function deleteBlock(db: StepForgeDb, id: string): void {
  blockRow(db, id);
  db.delete(blocks).where(eq(blocks.id, id)).run();
}
