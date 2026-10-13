import { newId, type StepInput } from '@stepforge/core';
import { eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import type { StepForgeDb } from '../index.ts';
import { applications, blocks, blockSteps, modules, scenarios, steps as scenarioSteps } from '../schema.ts';
import { invalid, notFound, now } from './errors.ts';
import {
  getScenario,
  parseSteps,
  saveSteps,
  toStepRecord,
  type ScenarioDetail,
  type StepRecord,
} from './scenarios.ts';

/** Reusable step groups such as "Login as Admin", used by `util.useBlock`. */
export type Block = typeof blocks.$inferSelect & { steps: StepRecord[] };

const InputDef = z.object({
  name: z
    .string()
    .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'Input names use letters, digits and _ (they become {{vars.<name>}})'),
  default: z.string().max(2000).optional(),
  description: z.string().max(500).optional(),
});
const BlockInput = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(2000).default(''),
  /** Values each use passes in; inside the block they are `{{vars.<name>}}`. */
  inputs: z
    .array(InputDef)
    .max(30)
    .default([])
    .refine((a) => new Set(a.map((i) => i.name)).size === a.length, 'Input names must be unique'),
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
): (typeof blocks.$inferSelect & { stepCount: number; usedBy: number })[] {
  const usage = usageIndex(db, applicationId);
  return db
    .select()
    .from(blocks)
    .where(eq(blocks.applicationId, applicationId))
    .orderBy(blocks.name)
    .all()
    .map((b) => ({
      ...b,
      stepCount: db.select().from(blockSteps).where(eq(blockSteps.blockId, b.id)).all().length,
      usedBy: (usage.get(b.id)?.scenarios.size ?? 0) + (usage.get(b.id)?.blocks.size ?? 0),
    }));
}

// ─── Where a block is used ─────────────────────────────────────────────────

type AnyStep = { type: string; params?: Record<string, unknown> };

/** How many times `steps` (including steps nested in conditions and loops) use each block. */
function countUses(list: AnyStep[], into: Map<string, number>): void {
  for (const s of list) {
    if (s.type === 'util.useBlock' && typeof s.params?.blockId === 'string')
      into.set(s.params.blockId, (into.get(s.params.blockId) ?? 0) + 1);
    for (const key of ['steps', 'else']) {
      const nested = s.params?.[key];
      if (Array.isArray(nested)) countUses(nested as AnyStep[], into);
    }
  }
}

type Usage = {
  /** scenario id → uses (as a step, or as its setup/teardown block) */
  scenarios: Map<string, { uses: number; setup: boolean; teardown: boolean }>;
  /** block id → uses */
  blocks: Map<string, number>;
};

/** Every block of an application → the scenarios and blocks that use it. */
function usageIndex(db: StepForgeDb, applicationId: string): Map<string, Usage> {
  const index = new Map<string, Usage>();
  const at = (blockId: string) => {
    let u = index.get(blockId);
    if (!u) index.set(blockId, (u = { scenarios: new Map(), blocks: new Map() }));
    return u;
  };
  const scen = db
    .select({ id: scenarios.id, setup: scenarios.setupBlockId, teardown: scenarios.teardownBlockId })
    .from(scenarios)
    .innerJoin(modules, eq(scenarios.moduleId, modules.id))
    .where(eq(modules.applicationId, applicationId))
    .all();
  for (const sc of scen) {
    const counts = new Map<string, number>();
    countUses(
      db
        .select()
        .from(scenarioSteps)
        .where(eq(scenarioSteps.scenarioId, sc.id))
        .all()
        .map((r) => ({ type: r.type, params: r.paramsJson })),
      counts,
    );
    for (const [blockId, uses] of counts)
      at(blockId).scenarios.set(sc.id, { uses, setup: false, teardown: false });
    for (const [blockId, key] of [
      [sc.setup, 'setup'],
      [sc.teardown, 'teardown'],
    ] as const) {
      if (!blockId) continue;
      const entry = at(blockId).scenarios.get(sc.id) ?? { uses: 0, setup: false, teardown: false };
      entry[key] = true;
      at(blockId).scenarios.set(sc.id, entry);
    }
  }
  for (const b of db
    .select({ id: blocks.id })
    .from(blocks)
    .where(eq(blocks.applicationId, applicationId))
    .all()) {
    const counts = new Map<string, number>();
    countUses(
      db
        .select()
        .from(blockSteps)
        .where(eq(blockSteps.blockId, b.id))
        .all()
        .map((r) => ({ type: r.type, params: r.paramsJson })),
      counts,
    );
    for (const [blockId, uses] of counts) at(blockId).blocks.set(b.id, uses);
  }
  return index;
}

export type BlockUsage = {
  scenarios: {
    id: string;
    name: string;
    moduleId: string;
    uses: number;
    setup: boolean;
    teardown: boolean;
  }[];
  blocks: { id: string; name: string; uses: number }[];
  /** Scenarios that run the block, directly or through another block (what a change to it affects). */
  affectedScenarios: number;
};

/** Where a block is used: a change to it changes all of these. */
export function blockUsage(db: StepForgeDb, id: string): BlockUsage {
  const b = blockRow(db, id);
  const index = usageIndex(db, b.applicationId);
  const u = index.get(id);
  const scenarioIds = [...(u?.scenarios.keys() ?? [])];
  const scen = scenarioIds.length
    ? db.select().from(scenarios).where(inArray(scenarios.id, scenarioIds)).all()
    : [];
  const blockIds = [...(u?.blocks.keys() ?? [])];
  const blk = blockIds.length ? db.select().from(blocks).where(inArray(blocks.id, blockIds)).all() : [];
  // Scenarios reached through blocks that use this block count too.
  const affected = new Set(scenarioIds);
  const seen = new Set([id]);
  const queue = [...blockIds];
  while (queue.length) {
    const next = queue.shift()!;
    if (seen.has(next)) continue;
    seen.add(next);
    for (const sid of index.get(next)?.scenarios.keys() ?? []) affected.add(sid);
    queue.push(...(index.get(next)?.blocks.keys() ?? []));
  }
  return {
    scenarios: scen
      .map((s) => ({ id: s.id, name: s.name, moduleId: s.moduleId, ...u!.scenarios.get(s.id)! }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    blocks: blk.map((x) => ({ id: x.id, name: x.name, uses: u!.blocks.get(x.id)! })),
    affectedScenarios: affected.size,
  };
}

/**
 * Turns consecutive top-level steps of a scenario into a new block, replacing them with one `util.useBlock` step.
 * Returns the block and the updated scenario (a new version).
 */
export function extractBlock(
  db: StepForgeDb,
  scenarioId: string,
  input: { stepIds: string[]; name: string; description?: string },
): { block: Block; scenario: ScenarioDetail } {
  const scenario = getScenario(db, scenarioId);
  const positions = input.stepIds
    .map((sid) => scenario.steps.findIndex((s) => s.id === sid))
    .sort((a, b) => a - b);
  if (!positions.length || positions.includes(-1))
    throw invalid('Choose top-level steps of this scenario to turn into a block');
  if (positions.some((p, i) => i > 0 && p !== positions[i - 1]! + 1))
    throw invalid('The steps must be next to each other');
  const first = positions[0]!;
  const picked = scenario.steps.slice(first, first + positions.length);
  let result!: { block: Block; scenario: ScenarioDetail };
  db.transaction(() => {
    const block = createBlock(db, scenario.applicationId, {
      name: input.name,
      description: input.description ?? `Made from "${scenario.name}"`,
      steps: picked.map(({ id: _id, ...s }) => s),
    });
    const useStep = { type: 'util.useBlock', label: input.name, params: { blockId: block.id } } as StepInput;
    const updated = saveSteps(db, scenarioId, [
      ...scenario.steps.slice(0, first),
      useStep,
      ...scenario.steps.slice(first + positions.length),
    ]);
    result = { block, scenario: updated };
  });
  return result;
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
  const { inputs, ...d } = BlockInput.parse(input);
  const id = newId();
  db.insert(blocks)
    .values({ id, applicationId, ...d, inputsJson: inputs })
    .run();
  return input.steps?.length ? saveBlockSteps(db, id, input.steps) : getBlock(db, id);
}

export function updateBlock(db: StepForgeDb, id: string, input: Partial<z.input<typeof BlockInput>>): Block {
  blockRow(db, id);
  const { inputs, ...d } = BlockInput.partial().parse(input);
  db.update(blocks)
    .set({ ...d, ...(inputs && { inputsJson: inputs }), updatedAt: now() })
    .where(eq(blocks.id, id))
    .run();
  return getBlock(db, id);
}

export function deleteBlock(db: StepForgeDb, id: string): void {
  blockRow(db, id);
  db.delete(blocks).where(eq(blocks.id, id)).run();
}

// ─── Which scenario or block a run step belongs to ─────────────────────────

type OwnedStep = { id?: string; type: string; params?: Record<string, unknown>; locators?: unknown[] };

function findStep(list: OwnedStep[], id: string): OwnedStep | undefined {
  for (const s of list) {
    if (s.id === id) return s;
    for (const key of ['steps', 'else']) {
      const nested = s.params?.[key];
      if (Array.isArray(nested)) {
        const hit = findStep(nested as OwnedStep[], id);
        if (hit) return hit;
      }
    }
  }
  return undefined;
}

export type StepOwner = {
  kind: 'scenario' | 'block';
  id: string;
  name: string;
  /** The step's own id inside its owner. */
  stepId: string;
  /** Blocks (and called scenarios) the run went through to reach it, outermost first. */
  via: { kind: 'scenario' | 'block'; id: string; name: string }[];
  /** For a block: how many scenarios a change to it affects. */
  affectedScenarios?: number;
};

/**
 * Run step ids are chains like `useStep>blockStep` (one `>` per block or called scenario). Follows the chain from
 * the scenario that ran to the scenario or block that owns the step, so a fix lands there.
 */
export function stepOwner(db: StepForgeDb, scenarioId: string, runStepId: string): StepOwner {
  const segments = runStepId.split('>');
  const root = getScenario(db, scenarioId);
  let owner: { kind: 'scenario' | 'block'; id: string; name: string; steps: OwnedStep[] } = {
    kind: 'scenario',
    id: root.id,
    name: root.name,
    steps: root.steps as OwnedStep[],
  };
  const via: StepOwner['via'] = [];
  for (const seg of segments.slice(0, -1)) {
    const call = findStep(owner.steps, seg);
    const targetId = String(call?.params?.blockId ?? call?.params?.scenarioId ?? '');
    if (!call || !targetId || !['util.useBlock', 'util.callScenario'].includes(call.type))
      throw notFound('Step', runStepId);
    if (owner.kind !== 'scenario' || owner.id !== root.id)
      via.push({ kind: owner.kind, id: owner.id, name: owner.name });
    if (call.type === 'util.useBlock') {
      const b = getBlock(db, targetId);
      owner = { kind: 'block', id: b.id, name: b.name, steps: b.steps as OwnedStep[] };
    } else {
      const s = getScenario(db, targetId);
      owner = { kind: 'scenario', id: s.id, name: s.name, steps: s.steps as OwnedStep[] };
    }
  }
  const stepId = segments.at(-1)!;
  if (!findStep(owner.steps, stepId)) throw notFound('Step', runStepId);
  return {
    kind: owner.kind,
    id: owner.id,
    name: owner.name,
    stepId,
    via,
    ...(owner.kind === 'block' && { affectedScenarios: blockUsage(db, owner.id).affectedScenarios }),
  };
}

/**
 * One-click locator fix: the suggestion becomes the step's primary locator (the old ones stay as fallbacks), in
 * whichever scenario or block owns the step — fixing a block fixes every test that uses it.
 */
export function acceptLocator(
  db: StepForgeDb,
  scenarioId: string,
  runStepId: string,
  locator: unknown,
): { owner: StepOwner; scenario?: ScenarioDetail; block?: Block } {
  const owner = stepOwner(db, scenarioId, runStepId);
  const list = structuredClone(
    owner.kind === 'block' ? getBlock(db, owner.id).steps : getScenario(db, owner.id).steps,
  ) as unknown as OwnedStep[];
  const step = findStep(list, owner.stepId)!;
  step.locators = [
    locator,
    ...((step.locators ?? []) as unknown[]).filter((l) => JSON.stringify(l) !== JSON.stringify(locator)),
  ];
  return owner.kind === 'block'
    ? { owner, block: saveBlockSteps(db, owner.id, list as never) }
    : { owner, scenario: saveSteps(db, owner.id, list as never) };
}
