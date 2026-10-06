import {
  deriveScenarioKind,
  newId,
  ScenarioInput,
  ScenarioUpdate,
  Step,
  type StepInput,
  TestCaseInput,
  TestCaseUpdate,
  ULID_REGEX,
} from '@stepforge/core';
import { and, desc, eq, inArray, like, or } from 'drizzle-orm';
import type { z } from 'zod';
import type { StepForgeDb } from '../index.ts';
import {
  applications,
  modules,
  scenarios,
  scenarioTags,
  scenarioVersions,
  steps,
  testCases,
} from '../schema.ts';
import { invalid, notFound, now } from './errors.ts';
import { getModule } from './modules.ts';
import { tagIdsForScenarios } from './tags.ts';

export type ScenarioRow = typeof scenarios.$inferSelect;
export type StepRow = typeof steps.$inferSelect;
export type TestCaseRow = typeof testCases.$inferSelect;

/** A step as exchanged with the UI: the unified step model plus its stable id. */
export type StepRecord = Step & { id: string };
export type ScenarioDetail = ScenarioRow & {
  applicationId: string;
  steps: StepRecord[];
  testCases: TestCaseRow[];
  tagIds: string[];
};
export type ScenarioSnapshot = Pick<
  ScenarioRow,
  'name' | 'description' | 'priority' | 'status' | 'owner' | 'preconditions'
> & { steps: StepRecord[]; restoredFrom?: number; note?: string };

// ─── Mapping ───────────────────────────────────────────────────────────────

export const toStepRecord = (r: Omit<StepRow, 'scenarioId'>): StepRecord => ({
  id: r.id,
  type: r.type,
  label: r.label || undefined,
  params: r.paramsJson,
  locators: r.locatorsJson as StepRecord['locators'],
  assertions: r.assertionsJson as StepRecord['assertions'],
  enabled: r.enabled,
  continueOnFail: r.continueOnFail,
  timeoutMs: r.timeoutMs ?? undefined,
  retries: r.retries,
  captureAs: r.captureAs ?? undefined,
});

function scenarioRow(db: StepForgeDb, id: string): ScenarioRow {
  const s = db.select().from(scenarios).where(eq(scenarios.id, id)).get();
  if (!s) throw notFound('Scenario', id);
  return s;
}

export function applicationIdForScenario(db: StepForgeDb, id: string): string {
  return getModule(db, scenarioRow(db, id).moduleId).applicationId;
}

export function getScenario(db: StepForgeDb, id: string): ScenarioDetail {
  const s = scenarioRow(db, id);
  return {
    ...s,
    applicationId: getModule(db, s.moduleId).applicationId,
    steps: db
      .select()
      .from(steps)
      .where(eq(steps.scenarioId, id))
      .orderBy(steps.position)
      .all()
      .map(toStepRecord),
    testCases: db.select().from(testCases).where(eq(testCases.scenarioId, id)).orderBy(testCases.code).all(),
    tagIds: tagIdsForScenarios(db, [id]).get(id) ?? [],
  };
}

function snapshotOf(detail: ScenarioDetail, extra: Partial<ScenarioSnapshot> = {}): ScenarioSnapshot {
  const { name, description, priority, status, owner, preconditions, steps: st } = detail;
  return { name, description, priority, status, owner, preconditions, steps: st, ...extra };
}

function recordVersion(db: StepForgeDb, id: string, extra: Partial<ScenarioSnapshot> = {}): void {
  const detail = getScenario(db, id);
  db.insert(scenarioVersions)
    .values({ id: newId(), scenarioId: id, version: detail.version, snapshotJson: snapshotOf(detail, extra) })
    .run();
}

function bumpVersion(db: StepForgeDb, id: string): void {
  const s = scenarioRow(db, id);
  db.update(scenarios)
    .set({ version: s.version + 1, updatedAt: now() })
    .where(eq(scenarios.id, id))
    .run();
}

/** Validates the nested step lists of control-flow steps (`util.if` then/else, `util.loop`). */
function validateNested(step: Step, where: string): void {
  const p = step.params as Record<string, unknown>;
  for (const key of ['steps', 'else'] as const) {
    if (p[key] === undefined) continue;
    if (!Array.isArray(p[key])) throw invalid(`${where}: "${key}" must be a list of steps`);
    (p[key] as unknown[]).forEach((child, i) => {
      const r = Step.safeParse(child);
      const at = `${where}.${key === 'else' ? 'else.' : ''}${i + 1}`;
      if (!r.success)
        throw invalid(
          `Step ${at}: ${r.error.issues.map((x) => `${x.path.join('.')} ${x.message}`).join('; ')}`,
        );
      validateNested(r.data, at);
    });
  }
}

/** Validates an ordered step list (including nested control flow) and assigns ids. */
export function parseSteps(input: (StepInput & { id?: string })[]): (Step & { id: string })[] {
  return input.map((raw, i) => {
    const r = Step.safeParse(raw);
    if (!r.success)
      throw invalid(
        `Step ${i + 1}: ${r.error.issues.map((x) => `${x.path.join('.')} ${x.message}`).join('; ')}`,
      );
    validateNested(r.data, String(i + 1));
    return { ...r.data, id: raw.id && ULID_REGEX.test(raw.id) ? raw.id : newId() };
  });
}

function writeSteps(db: StepForgeDb, scenarioId: string, input: (StepInput & { id?: string })[]): void {
  const parsed = parseSteps(input);
  const ids = parsed.map((p) => p.id);
  if (new Set(ids).size !== ids.length) throw invalid('Duplicate step ids');
  db.delete(steps).where(eq(steps.scenarioId, scenarioId)).run();
  if (parsed.length) {
    db.insert(steps)
      .values(
        parsed.map((s, position) => ({
          id: s.id,
          scenarioId,
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
  db.update(scenarios)
    .set({ kind: deriveScenarioKind(parsed.map((p) => p.type)) })
    .where(eq(scenarios.id, scenarioId))
    .run();
}

// ─── Scenarios ─────────────────────────────────────────────────────────────

export function createScenario(
  db: StepForgeDb,
  moduleId: string,
  input: z.input<typeof ScenarioInput> & { steps?: (StepInput & { id?: string })[] },
): ScenarioDetail {
  getModule(db, moduleId);
  const d = ScenarioInput.parse(input);
  const id = newId();
  db.transaction(() => {
    db.insert(scenarios)
      .values({ id, moduleId, ...d })
      .run();
    writeSteps(db, id, input.steps ?? []);
    recordVersion(db, id, { note: 'Created' });
  });
  return getScenario(db, id);
}

export function updateScenario(
  db: StepForgeDb,
  id: string,
  input: z.input<typeof ScenarioUpdate>,
): ScenarioDetail {
  const current = scenarioRow(db, id);
  const { moduleId, ...meta } = ScenarioUpdate.parse(input);
  if (moduleId && moduleId !== current.moduleId) moveScenarios(db, [id], moduleId);
  const changed = Object.entries(meta).some(([k, v]) => current[k as keyof ScenarioRow] !== v);
  if (changed) {
    db.transaction(() => {
      db.update(scenarios)
        .set({ ...meta, updatedAt: now() })
        .where(eq(scenarios.id, id))
        .run();
      bumpVersion(db, id);
      recordVersion(db, id, { note: 'Details changed' });
    });
  }
  return getScenario(db, id);
}

/** Replaces the ordered step list (ids are kept when provided, so run history stays linked). */
export function saveSteps(
  db: StepForgeDb,
  id: string,
  input: (StepInput & { id?: string })[],
): ScenarioDetail {
  scenarioRow(db, id);
  db.transaction(() => {
    writeSteps(db, id, input);
    bumpVersion(db, id);
    recordVersion(db, id, { note: 'Steps changed' });
  });
  return getScenario(db, id);
}

export function deleteScenarios(db: StepForgeDb, ids: string[]): void {
  if (ids.length) db.delete(scenarios).where(inArray(scenarios.id, ids)).run();
}

export function moveScenarios(db: StepForgeDb, ids: string[], moduleId: string): void {
  const target = getModule(db, moduleId);
  for (const id of ids) {
    if (applicationIdForScenario(db, id) !== target.applicationId) {
      throw invalid('Scenarios can only be moved within the same application');
    }
  }
  if (ids.length)
    db.update(scenarios).set({ moduleId, updatedAt: now() }).where(inArray(scenarios.id, ids)).run();
}

export function duplicateScenario(db: StepForgeDb, id: string): ScenarioDetail {
  const src = getScenario(db, id);
  const copy = createScenario(db, src.moduleId, {
    name: `${src.name} (copy)`,
    description: src.description,
    priority: src.priority,
    status: 'draft',
    owner: src.owner,
    preconditions: src.preconditions,
    steps: src.steps.map(({ id: _id, ...s }) => s),
  });
  for (const tc of src.testCases) {
    db.insert(testCases)
      .values({ ...tc, id: newId(), scenarioId: copy.id, createdAt: now(), updatedAt: now() })
      .run();
  }
  if (src.tagIds.length) {
    db.insert(scenarioTags)
      .values(src.tagIds.map((tagId) => ({ scenarioId: copy.id, tagId })))
      .run();
  }
  return getScenario(db, copy.id);
}

// ─── Versions ──────────────────────────────────────────────────────────────

export function listVersions(db: StepForgeDb, id: string) {
  scenarioRow(db, id);
  return db
    .select()
    .from(scenarioVersions)
    .where(eq(scenarioVersions.scenarioId, id))
    .orderBy(desc(scenarioVersions.version))
    .all()
    .map((v) => ({ ...v, snapshotJson: v.snapshotJson as ScenarioSnapshot }));
}

export function getVersion(db: StepForgeDb, id: string, version: number) {
  const v = db
    .select()
    .from(scenarioVersions)
    .where(and(eq(scenarioVersions.scenarioId, id), eq(scenarioVersions.version, version)))
    .get();
  if (!v) throw notFound('Scenario version', `${id}@${version}`);
  return { ...v, snapshotJson: v.snapshotJson as ScenarioSnapshot };
}

/** Restores a past version by creating a new version with its content (history is never rewritten). */
export function restoreVersion(db: StepForgeDb, id: string, version: number): ScenarioDetail {
  const snap = getVersion(db, id, version).snapshotJson;
  db.transaction(() => {
    db.update(scenarios)
      .set({
        name: snap.name,
        description: snap.description,
        priority: snap.priority,
        status: snap.status,
        owner: snap.owner,
        preconditions: snap.preconditions,
      })
      .where(eq(scenarios.id, id))
      .run();
    writeSteps(db, id, snap.steps);
    bumpVersion(db, id);
    recordVersion(db, id, { restoredFrom: version, note: `Restored v${version}` });
  });
  return getScenario(db, id);
}

// ─── Test cases ────────────────────────────────────────────────────────────

function testCaseRow(db: StepForgeDb, id: string): TestCaseRow {
  const t = db.select().from(testCases).where(eq(testCases.id, id)).get();
  if (!t) throw notFound('Test case', id);
  return t;
}

/** Generates the next free code like TC-PAT-001 for the scenario's module, unique within the application. */
export function nextTestCaseCode(db: StepForgeDb, scenarioId: string): string {
  const s = scenarioRow(db, scenarioId);
  const mod = getModule(db, s.moduleId);
  const prefix =
    mod.name
      .normalize('NFKD')
      .replace(/[^A-Za-z]/g, '')
      .slice(0, 3)
      .toUpperCase() || 'GEN';
  const moduleIds = db
    .select({ id: modules.id })
    .from(modules)
    .where(eq(modules.applicationId, mod.applicationId))
    .all()
    .map((m) => m.id);
  const used = db
    .select({ code: testCases.code })
    .from(testCases)
    .innerJoin(scenarios, eq(scenarios.id, testCases.scenarioId))
    .where(and(inArray(scenarios.moduleId, moduleIds), like(testCases.code, `TC-${prefix}-%`)))
    .all()
    .map((r) => Number(r.code.split('-').pop()))
    .filter(Number.isFinite);
  const next = (used.length ? Math.max(...used) : 0) + 1;
  return `TC-${prefix}-${String(next).padStart(3, '0')}`;
}

export function createTestCase(
  db: StepForgeDb,
  scenarioId: string,
  input: z.input<typeof TestCaseInput>,
): TestCaseRow {
  scenarioRow(db, scenarioId);
  const d = TestCaseInput.parse(input);
  const id = newId();
  db.insert(testCases)
    .values({
      id,
      scenarioId,
      code: d.code ?? nextTestCaseCode(db, scenarioId),
      title: d.title,
      dataJson: d.data,
      expectedResult: d.expectedResult,
      priority: d.priority,
      technique: d.technique,
      status: d.status,
    })
    .run();
  return testCaseRow(db, id);
}

export function updateTestCase(
  db: StepForgeDb,
  id: string,
  input: z.input<typeof TestCaseUpdate>,
): TestCaseRow {
  testCaseRow(db, id);
  const { data, ...rest } = TestCaseUpdate.parse(input);
  db.update(testCases)
    .set({ ...rest, ...(data !== undefined && { dataJson: data }), updatedAt: now() })
    .where(eq(testCases.id, id))
    .run();
  return testCaseRow(db, id);
}

export function deleteTestCase(db: StepForgeDb, id: string): void {
  testCaseRow(db, id);
  db.delete(testCases).where(eq(testCases.id, id)).run();
}

export function applicationIdForTestCase(db: StepForgeDb, id: string): string {
  return applicationIdForScenario(db, testCaseRow(db, id).scenarioId);
}

// ─── Tree + search ─────────────────────────────────────────────────────────

/** Everything the Test Explorer needs for one application, in three flat lists. */
export function getTree(db: StepForgeDb, applicationId: string) {
  if (
    !db.select({ id: applications.id }).from(applications).where(eq(applications.id, applicationId)).get()
  ) {
    throw notFound('Application', applicationId);
  }
  const mods = db
    .select({
      id: modules.id,
      parentId: modules.parentId,
      name: modules.name,
      description: modules.description,
      sortOrder: modules.sortOrder,
    })
    .from(modules)
    .where(eq(modules.applicationId, applicationId))
    .orderBy(modules.sortOrder, modules.name)
    .all();
  const modIds = mods.map((m) => m.id);
  const scen = modIds.length
    ? db
        .select({
          id: scenarios.id,
          moduleId: scenarios.moduleId,
          name: scenarios.name,
          kind: scenarios.kind,
          priority: scenarios.priority,
          status: scenarios.status,
          owner: scenarios.owner,
          version: scenarios.version,
        })
        .from(scenarios)
        .where(inArray(scenarios.moduleId, modIds))
        .orderBy(scenarios.name)
        .all()
    : [];
  const scenIds = scen.map((s) => s.id);
  const tagMap = tagIdsForScenarios(db, scenIds);
  const stepCounts = new Map<string, number>();
  if (scenIds.length) {
    for (const r of db
      .select({ s: steps.scenarioId })
      .from(steps)
      .where(inArray(steps.scenarioId, scenIds))
      .all()) {
      stepCounts.set(r.s, (stepCounts.get(r.s) ?? 0) + 1);
    }
  }
  const tcs = scenIds.length
    ? db
        .select({
          id: testCases.id,
          scenarioId: testCases.scenarioId,
          code: testCases.code,
          title: testCases.title,
          status: testCases.status,
          priority: testCases.priority,
          technique: testCases.technique,
        })
        .from(testCases)
        .where(inArray(testCases.scenarioId, scenIds))
        .orderBy(testCases.code)
        .all()
    : [];
  return {
    modules: mods,
    scenarios: scen.map((s) => ({
      ...s,
      tagIds: tagMap.get(s.id) ?? [],
      stepCount: stepCounts.get(s.id) ?? 0,
    })),
    testCases: tcs,
  };
}

export type SearchHit = {
  kind: 'application' | 'scenario' | 'testCase';
  id: string;
  title: string;
  subtitle: string;
  applicationId: string;
  scenarioId?: string;
};

export function search(db: StepForgeDb, q: string, limit = 20): SearchHit[] {
  const term = `%${q.replace(/[%_]/g, '')}%`;
  const apps = db
    .select()
    .from(applications)
    .where(or(like(applications.name, term), like(applications.slug, term)))
    .limit(limit)
    .all()
    .map<SearchHit>((a) => ({
      kind: 'application',
      id: a.id,
      title: a.name,
      subtitle: a.slug,
      applicationId: a.id,
    }));
  const scen = db
    .select({ id: scenarios.id, name: scenarios.name, mod: modules.name, app: modules.applicationId })
    .from(scenarios)
    .innerJoin(modules, eq(modules.id, scenarios.moduleId))
    .where(like(scenarios.name, term))
    .limit(limit)
    .all()
    .map<SearchHit>((s) => ({
      kind: 'scenario',
      id: s.id,
      title: s.name,
      subtitle: s.mod,
      applicationId: s.app,
      scenarioId: s.id,
    }));
  const tcs = db
    .select({
      id: testCases.id,
      code: testCases.code,
      title: testCases.title,
      sid: scenarios.id,
      app: modules.applicationId,
    })
    .from(testCases)
    .innerJoin(scenarios, eq(scenarios.id, testCases.scenarioId))
    .innerJoin(modules, eq(modules.id, scenarios.moduleId))
    .where(or(like(testCases.code, term), like(testCases.title, term)))
    .limit(limit)
    .all()
    .map<SearchHit>((t) => ({
      kind: 'testCase',
      id: t.id,
      title: `${t.code} · ${t.title}`,
      subtitle: 'Test case',
      applicationId: t.app,
      scenarioId: t.sid,
    }));
  return [...apps, ...scen, ...tcs].slice(0, limit);
}
