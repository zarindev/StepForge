import { newId } from '@stepforge/core';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { StepForgeDb } from '../index.ts';
import { bugs } from '../schema.ts';
import { notFound, now } from './errors.ts';

export type Bug = typeof bugs.$inferSelect;
export const BUG_STATUSES = ['open', 'in_progress', 'fixed', 'wont_fix', 'duplicate'] as const;
export const BUG_SEVERITIES = ['critical', 'major', 'minor', 'trivial'] as const;

export const BugUpdate = z.object({
  title: z.string().trim().min(1).max(300).optional(),
  summary: z.string().max(10_000).optional(),
  severity: z.enum(BUG_SEVERITIES).optional(),
  priority: z.enum(['P1', 'P2', 'P3', 'P4']).optional(),
  status: z.enum(BUG_STATUSES).optional(),
  expected: z.string().max(5000).optional(),
  actual: z.string().max(5000).optional(),
  preconditions: z.string().max(5000).optional(),
});

/** Same scenario + failing step + diagnosis category = the same bug (occurrences are counted). */
export function bugFingerprint(scenarioId: string, failedStepId: string, category: string): string {
  return createHash('sha1').update(`${scenarioId}|${failedStepId}|${category}`).digest('hex').slice(0, 16);
}

export type BugFilters = { status?: string[]; severity?: string[]; owner?: string[] };

export function listBugs(db: StepForgeDb, applicationId: string, f: BugFilters = {}): Bug[] {
  return db
    .select()
    .from(bugs)
    .where(
      and(
        eq(bugs.applicationId, applicationId),
        f.status?.length ? inArray(bugs.status, f.status as Bug['status'][]) : undefined,
        f.severity?.length ? inArray(bugs.severity, f.severity as Bug['severity'][]) : undefined,
        f.owner?.length ? inArray(bugs.ownerHint, f.owner as NonNullable<Bug['ownerHint']>[]) : undefined,
      ),
    )
    .orderBy(desc(bugs.updatedAt))
    .all();
}

export function getBug(db: StepForgeDb, id: string): Bug {
  const b = db.select().from(bugs).where(eq(bugs.id, id)).get();
  if (!b) throw notFound('Bug', id);
  return b;
}

export function updateBug(db: StepForgeDb, id: string, input: z.input<typeof BugUpdate>): Bug {
  getBug(db, id);
  const d = BugUpdate.parse(input);
  db.update(bugs)
    .set({ ...d, updatedAt: now() })
    .where(eq(bugs.id, id))
    .run();
  return getBug(db, id);
}

export function deleteBug(db: StepForgeDb, id: string): void {
  getBug(db, id);
  db.delete(bugs).where(eq(bugs.id, id)).run();
}

function nextCode(db: StepForgeDb, applicationId: string): string {
  const row = db
    .select({ n: sql<number>`MAX(CAST(SUBSTR(${bugs.code}, 5) AS INTEGER))` })
    .from(bugs)
    .where(eq(bugs.applicationId, applicationId))
    .get();
  return `BUG-${String((row?.n ?? 0) + 1).padStart(3, '0')}`;
}

export type FailureReport = {
  applicationId: string;
  runItemId: string;
  scenarioId: string;
  testCaseId: string | null;
  failedStepId: string;
  category: string;
  title: string;
  summary: string;
  severity: Bug['severity'];
  priority: Bug['priority'];
  environment: Record<string, unknown>;
  preconditions: string;
  stepsToReproduce: string[];
  expected: string;
  actual: string;
  diagnosis: unknown;
  owner: NonNullable<Bug['ownerHint']>;
};

/**
 * Files a bug for a failure, or counts another occurrence of an existing one. A bug that was fixed and fails again
 * is reopened; bugs marked won't-fix or duplicate keep their status (only the count grows).
 */
export function recordFailure(
  db: StepForgeDb,
  r: FailureReport,
): { bug: Bug; created: boolean; reopened: boolean } {
  const fingerprint = bugFingerprint(r.scenarioId, r.failedStepId, r.category);
  const existing = db
    .select()
    .from(bugs)
    .where(and(eq(bugs.applicationId, r.applicationId), eq(bugs.fingerprint, fingerprint)))
    .orderBy(desc(bugs.createdAt))
    .get();
  const at = now();
  if (existing) {
    const reopened = existing.status === 'fixed';
    db.update(bugs)
      .set({
        occurrences: existing.occurrences + 1,
        runItemId: r.runItemId,
        actual: r.actual,
        environmentJson: r.environment,
        diagnosisJson: r.diagnosis,
        lastSeenAt: at,
        updatedAt: at,
        ...(reopened && { status: 'open' as const }),
      })
      .where(eq(bugs.id, existing.id))
      .run();
    return { bug: getBug(db, existing.id), created: false, reopened };
  }
  const id = newId();
  db.insert(bugs)
    .values({
      id,
      applicationId: r.applicationId,
      runItemId: r.runItemId,
      code: nextCode(db, r.applicationId),
      title: r.title,
      summary: r.summary,
      severity: r.severity,
      priority: r.priority,
      environmentJson: r.environment,
      preconditions: r.preconditions,
      stepsToReproduceJson: r.stepsToReproduce,
      expected: r.expected,
      actual: r.actual,
      diagnosisJson: r.diagnosis,
      ownerHint: r.owner,
      fingerprint,
      scenarioId: r.scenarioId,
      testCaseId: r.testCaseId,
      failedStepId: r.failedStepId,
      category: r.category,
      lastSeenAt: at,
    })
    .run();
  return { bug: getBug(db, id), created: true, reopened: false };
}
