import { Locator, newId } from '@stepforge/core';
import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import type { StepForgeDb } from '../index.ts';
import {
  applications,
  blocks,
  blockSteps,
  elements,
  modules,
  scenarios,
  steps as scenarioSteps,
} from '../schema.ts';
import { invalid, notFound, now } from './errors.ts';

/**
 * Saved UI elements ("Save patient button"). Steps point at one with an `element` locator; at run time it becomes
 * the element's current locators, so fixing an element fixes every step that uses it.
 */
export type ElementRow = typeof elements.$inferSelect;
export type ElementLocator = z.infer<typeof Locator>;

const Concrete = Locator.refine(
  (l) => l.strategy !== 'element',
  'An element cannot point at another element',
);
const ElementInput = z.object({
  name: z.string().trim().min(1).max(120),
  page: z.string().trim().max(120).default(''),
  description: z.string().max(2000).default(''),
  locators: z.array(Concrete).min(1, 'An element needs at least one locator').max(10),
});

function elementRow(db: StepForgeDb, id: string): ElementRow {
  const e = db.select().from(elements).where(eq(elements.id, id)).get();
  if (!e) throw notFound('Element', id);
  return e;
}

export function getElement(db: StepForgeDb, id: string): ElementRow {
  return elementRow(db, id);
}

function assertUniqueName(db: StepForgeDb, applicationId: string, name: string, except?: string) {
  const clash = db
    .select({ id: elements.id })
    .from(elements)
    .where(and(eq(elements.applicationId, applicationId), eq(elements.name, name)))
    .get();
  if (clash && clash.id !== except) throw invalid(`An element named "${name}" already exists`);
}

export function createElement(
  db: StepForgeDb,
  applicationId: string,
  input: z.input<typeof ElementInput>,
): ElementRow {
  if (!db.select({ id: applications.id }).from(applications).where(eq(applications.id, applicationId)).get())
    throw notFound('Application', applicationId);
  const { locators, ...d } = ElementInput.parse(input);
  assertUniqueName(db, applicationId, d.name);
  const id = newId();
  db.insert(elements)
    .values({ id, applicationId, ...d, locatorsJson: locators })
    .run();
  return elementRow(db, id);
}

export function updateElement(
  db: StepForgeDb,
  id: string,
  input: Partial<z.input<typeof ElementInput>>,
): ElementRow {
  const row = elementRow(db, id);
  const { locators, ...d } = ElementInput.partial().parse(input);
  if (d.name) assertUniqueName(db, row.applicationId, d.name, id);
  db.update(elements)
    .set({ ...d, ...(locators && { locatorsJson: locators }), updatedAt: now() })
    .where(eq(elements.id, id))
    .run();
  return elementRow(db, id);
}

export function deleteElement(db: StepForgeDb, id: string): void {
  elementRow(db, id);
  db.delete(elements).where(eq(elements.id, id)).run();
}

// ─── Where elements are used ───────────────────────────────────────────────

type AnyStep = { type?: string; params?: Record<string, unknown>; locators?: unknown };

function countRefs(list: AnyStep[], into: Map<string, number>): void {
  for (const s of list) {
    for (const l of (Array.isArray(s.locators) ? s.locators : []) as { strategy?: string; value?: string }[])
      if (l.strategy === 'element' && l.value) into.set(l.value, (into.get(l.value) ?? 0) + 1);
    for (const key of ['steps', 'else']) {
      const nested = s.params?.[key];
      if (Array.isArray(nested)) countRefs(nested as AnyStep[], into);
    }
  }
}

type Usage = { scenarios: Map<string, number>; blocks: Map<string, number> };

/** Every element of an application → the scenarios and blocks whose steps use it (with step counts). */
function usageIndex(db: StepForgeDb, applicationId: string): Map<string, Usage> {
  const index = new Map<string, Usage>();
  const at = (id: string) => {
    let u = index.get(id);
    if (!u) index.set(id, (u = { scenarios: new Map(), blocks: new Map() }));
    return u;
  };
  const scen = db
    .select({ id: scenarios.id })
    .from(scenarios)
    .innerJoin(modules, eq(scenarios.moduleId, modules.id))
    .where(eq(modules.applicationId, applicationId))
    .all();
  for (const sc of scen) {
    const counts = new Map<string, number>();
    countRefs(
      db
        .select()
        .from(scenarioSteps)
        .where(eq(scenarioSteps.scenarioId, sc.id))
        .all()
        .map((r) => ({ params: r.paramsJson, locators: r.locatorsJson })),
      counts,
    );
    for (const [el, n] of counts) at(el).scenarios.set(sc.id, n);
  }
  for (const b of db
    .select({ id: blocks.id })
    .from(blocks)
    .where(eq(blocks.applicationId, applicationId))
    .all()) {
    const counts = new Map<string, number>();
    countRefs(
      db
        .select()
        .from(blockSteps)
        .where(eq(blockSteps.blockId, b.id))
        .all()
        .map((r) => ({ params: r.paramsJson, locators: r.locatorsJson })),
      counts,
    );
    for (const [el, n] of counts) at(el).blocks.set(b.id, n);
  }
  return index;
}

export function listElements(
  db: StepForgeDb,
  applicationId: string,
): (ElementRow & { usedBySteps: number; usedBy: number })[] {
  const usage = usageIndex(db, applicationId);
  return db
    .select()
    .from(elements)
    .where(eq(elements.applicationId, applicationId))
    .orderBy(elements.page, elements.name)
    .all()
    .map((e) => {
      const u = usage.get(e.id);
      const steps = [...(u?.scenarios.values() ?? []), ...(u?.blocks.values() ?? [])].reduce(
        (a, b) => a + b,
        0,
      );
      return { ...e, usedBySteps: steps, usedBy: (u?.scenarios.size ?? 0) + (u?.blocks.size ?? 0) };
    });
}

export type ElementUsage = {
  scenarios: { id: string; name: string; steps: number }[];
  blocks: { id: string; name: string; steps: number }[];
  steps: number;
};

/** Where an element is used: changing its locators changes all of these steps. */
export function elementUsage(db: StepForgeDb, id: string): ElementUsage {
  const e = elementRow(db, id);
  const u = usageIndex(db, e.applicationId).get(id);
  const sIds = [...(u?.scenarios.keys() ?? [])];
  const bIds = [...(u?.blocks.keys() ?? [])];
  const scen = sIds.length ? db.select().from(scenarios).where(inArray(scenarios.id, sIds)).all() : [];
  const blk = bIds.length ? db.select().from(blocks).where(inArray(blocks.id, bIds)).all() : [];
  return {
    scenarios: scen
      .map((s) => ({ id: s.id, name: s.name, steps: u!.scenarios.get(s.id)! }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    blocks: blk.map((b) => ({ id: b.id, name: b.name, steps: u!.blocks.get(b.id)! })),
    steps: [...(u?.scenarios.values() ?? []), ...(u?.blocks.values() ?? [])].reduce((a, b) => a + b, 0),
  };
}

/** All elements of an application as id → locators, for expanding `element` locators at run or export time. */
export function elementLocatorMap(db: StepForgeDb, applicationId: string): Record<string, ElementLocator[]> {
  return Object.fromEntries(
    db
      .select()
      .from(elements)
      .where(eq(elements.applicationId, applicationId))
      .all()
      .map((e) => [e.id, e.locatorsJson as ElementLocator[]]),
  );
}

/** The suggested locator becomes the element's primary one (the old ones stay as fallbacks). */
export function acceptElementLocator(db: StepForgeDb, id: string, locator: unknown): ElementRow {
  const e = elementRow(db, id);
  const current = e.locatorsJson as unknown[];
  return updateElement(db, id, {
    locators: [locator, ...current.filter((l) => JSON.stringify(l) !== JSON.stringify(locator))] as never,
  });
}

const sameLocator = (a?: { strategy?: string; value?: string; name?: string }, b?: typeof a) =>
  !!a && !!b && a.strategy === b.strategy && a.value === b.value && (a.name ?? '') === (b.name ?? '');

/**
 * Recorded steps whose best locator matches a saved element's best locator point at the element instead, so a
 * recording reuses the shared definition (and gets its future fixes). Nested steps are linked too.
 */
export function linkKnownElements<T extends AnyStep>(db: StepForgeDb, applicationId: string, list: T[]): T[] {
  const known = db.select().from(elements).where(eq(elements.applicationId, applicationId)).all();
  if (!known.length) return list;
  const link = (steps: AnyStep[]): AnyStep[] =>
    steps.map((s) => {
      const params = { ...(s.params ?? {}) };
      for (const key of ['steps', 'else'])
        if (Array.isArray(params[key])) params[key] = link(params[key] as AnyStep[]);
      const first = (Array.isArray(s.locators) ? s.locators[0] : undefined) as Parameters<
        typeof sameLocator
      >[0];
      const match = first && known.find((e) => sameLocator((e.locatorsJson as never[])[0], first));
      return { ...s, params, ...(match && { locators: [{ strategy: 'element', value: match.id }] }) };
    });
  return link(list) as T[];
}
