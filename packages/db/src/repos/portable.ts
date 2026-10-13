import { newId, type StepInput } from '@stepforge/core';
import { eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import type { StepForgeDb } from '../index.ts';
import { datasets, environments, modules, scenarios, secrets, tags } from '../schema.ts';
import { createApplication, getApplication, getApplicationBySlug } from './applications.ts';
import { createBlock, getBlock, listBlocks, saveBlockSteps } from './blocks.ts';
import { listCampaigns, saveCampaign } from './campaigns.ts';
import { createElement, listElements } from './elements.ts';
import { createEnvironment, listEnvironments } from './environments.ts';
import { invalid } from './errors.ts';
import { createModule } from './modules.ts';
import { createScenario, createTestCase, getScenario, saveSteps } from './scenarios.ts';
import { createTag, setScenarioTags } from './tags.ts';

/**
 * Applications as a portable JSON file (CLI `export`/`import`, Settings → Import/export).
 * Secret values are never exported: environments list only the names of their secrets.
 * Database connections and mail inboxes are not included (they hold credentials); steps refer to them
 * by name, so recreate them with the same names after importing.
 */
export const EXPORT_FORMAT = 'stepforge.application';
export const EXPORT_VERSION = 1;

type AnyStep = StepInput & { id?: string; params?: Record<string, unknown> };

const StepList = z.array(z.record(z.string(), z.unknown()));
export const ApplicationExport = z.object({
  format: z.literal(EXPORT_FORMAT),
  version: z.literal(EXPORT_VERSION),
  exportedAt: z.string(),
  generator: z.string().optional(),
  application: z.object({
    name: z.string(),
    slug: z.string(),
    description: z.string().default(''),
    icon: z.string().optional(),
    color: z.string().optional(),
    category: z.string().optional(),
    tags: z.array(z.string()).default([]),
  }),
  environments: z
    .array(
      z.object({
        name: z.string(),
        baseUrl: z.string(),
        isProduction: z.boolean().default(false),
        variables: z.record(z.string(), z.string()).default({}),
        browserDefaults: z.record(z.string(), z.unknown()).optional(),
        /** Names only; the values must be entered again after importing. */
        secretKeys: z.array(z.string()).default([]),
      }),
    )
    .default([]),
  tags: z.array(z.object({ name: z.string(), color: z.string().optional() })).default([]),
  modules: z
    .array(
      z.object({
        ref: z.string(),
        parentRef: z.string().nullable(),
        name: z.string(),
        description: z.string().default(''),
        sortOrder: z.number().int().default(0),
      }),
    )
    .default([]),
  blocks: z
    .array(
      z.object({
        ref: z.string(),
        name: z.string(),
        description: z.string().default(''),
        inputs: z
          .array(
            z.object({
              name: z.string(),
              default: z.string().optional(),
              description: z.string().optional(),
            }),
          )
          .default([]),
        steps: StepList,
      }),
    )
    .default([]),
  elements: z
    .array(
      z.object({
        ref: z.string(),
        name: z.string(),
        page: z.string().default(''),
        description: z.string().default(''),
        locators: z.array(z.record(z.string(), z.unknown())).min(1),
      }),
    )
    .default([]),
  /** Campaigns refer to environments and tags by name, and to modules and scenarios by their export refs. */
  campaigns: z
    .array(
      z.object({
        name: z.string(),
        description: z.string().default(''),
        all: z.boolean().default(true),
        moduleRefs: z.array(z.string()).default([]),
        tags: z.array(z.string()).default([]),
        scenarioRefs: z.array(z.string()).default([]),
        environments: z.array(z.string()).min(1),
        browsers: z.array(z.string()).default(['chromium']),
        viewports: z.array(z.string()).default(['desktop']),
        options: z.record(z.string(), z.unknown()).default({}),
      }),
    )
    .default([]),
  datasets: z
    .array(
      z.object({
        name: z.string(),
        kind: z.enum(['table', 'csv', 'sql', 'api']).default('table'),
        description: z.string().default(''),
        /** csv / sql / api settings (no credentials: secrets stay as {{secret.…}} placeholders). */
        config: z.record(z.string(), z.unknown()).default({}),
        columns: z.array(z.string()).default([]),
        rows: z.array(z.record(z.string(), z.unknown())).default([]),
      }),
    )
    .default([]),
  scenarios: z
    .array(
      z.object({
        ref: z.string(),
        moduleRef: z.string(),
        name: z.string(),
        description: z.string().default(''),
        priority: z.enum(['P1', 'P2', 'P3', 'P4']).default('P2'),
        status: z.enum(['draft', 'ready', 'deprecated']).default('draft'),
        owner: z.string().default(''),
        preconditions: z.string().default(''),
        setupBlockRef: z.string().nullable().default(null),
        teardownBlockRef: z.string().nullable().default(null),
        tags: z.array(z.string()).default([]),
        steps: StepList,
        testCases: z
          .array(
            z.object({
              code: z.string(),
              title: z.string(),
              data: z.record(z.string(), z.unknown()).default({}),
              expectedResult: z.string().default(''),
              priority: z.enum(['P1', 'P2', 'P3', 'P4']).default('P2'),
              technique: z.string().default('positive'),
              status: z.enum(['active', 'skipped']).default('active'),
            }),
          )
          .default([]),
      }),
    )
    .default([]),
});
export type ApplicationExport = z.infer<typeof ApplicationExport>;

/** Drops step ids (they are global) and rewrites block/scenario references, including nested steps. */
const callsScenario = (list: AnyStep[]): boolean =>
  list.some(
    (s) =>
      s.type === 'util.callScenario' ||
      (['steps', 'else'] as const).some(
        (k) => Array.isArray(s.params?.[k]) && callsScenario(s.params[k] as AnyStep[]),
      ),
  );

type RefMap = { blocks: Map<string, string>; scenarios: Map<string, string>; elements: Map<string, string> };

function portableSteps(list: AnyStep[], map?: RefMap) {
  return list.map((raw): AnyStep => {
    const { id: _id, ...s } = raw;
    const params = { ...(s.params ?? {}) };
    for (const key of ['steps', 'else'] as const)
      if (Array.isArray(params[key])) params[key] = portableSteps(params[key] as AnyStep[], map);
    if (map && s.type === 'util.useBlock' && typeof params.blockId === 'string')
      params.blockId = map.blocks.get(params.blockId) ?? params.blockId;
    if (map && s.type === 'util.callScenario' && typeof params.scenarioId === 'string')
      params.scenarioId = map.scenarios.get(params.scenarioId) ?? params.scenarioId;
    const locators = Array.isArray(s.locators)
      ? s.locators.map((l) =>
          map && l.strategy === 'element' && l.value
            ? { ...l, value: map.elements.get(l.value) ?? l.value }
            : l,
        )
      : s.locators;
    return { ...s, params, ...(locators !== undefined && { locators }) };
  });
}

const SECRET_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function exportApplication(
  db: StepForgeDb,
  applicationId: string,
  generator?: string,
): ApplicationExport {
  const app = getApplication(db, applicationId);
  const envs = db.select().from(environments).where(eq(environments.applicationId, applicationId)).all();
  const mods = db.select().from(modules).where(eq(modules.applicationId, applicationId)).all();
  const appTags = db.select().from(tags).where(eq(tags.applicationId, applicationId)).all();
  const tagName = new Map(appTags.map((t) => [t.id, t.name]));
  const scenarioIds = mods.length
    ? db
        .select({ id: scenarios.id })
        .from(scenarios)
        .where(
          inArray(
            scenarios.moduleId,
            mods.map((m) => m.id),
          ),
        )
        .orderBy(scenarios.createdAt)
        .all()
        .map((s) => s.id)
    : [];
  return {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    ...(generator && { generator }),
    application: {
      name: app.name,
      slug: app.slug,
      description: app.description,
      icon: app.icon,
      color: app.color,
      category: app.category,
      tags: app.tagsJson,
    },
    environments: envs.map((e) => ({
      name: e.name,
      baseUrl: e.baseUrl,
      isProduction: e.isProduction,
      variables: e.variablesJson,
      browserDefaults: e.browserDefaultsJson,
      secretKeys: db
        .select({ key: secrets.key })
        .from(secrets)
        .where(eq(secrets.environmentId, e.id))
        .all()
        .map((s) => s.key)
        .filter((k) => SECRET_NAME.test(k))
        .sort(),
    })),
    tags: appTags.map((t) => ({ name: t.name, color: t.color })),
    modules: mods.map((m) => ({
      ref: m.id,
      parentRef: m.parentId,
      name: m.name,
      description: m.description,
      sortOrder: m.sortOrder,
    })),
    elements: listElements(db, applicationId).map((e) => ({
      ref: e.id,
      name: e.name,
      page: e.page,
      description: e.description,
      locators: e.locatorsJson,
    })),
    blocks: listBlocks(db, applicationId).map((b) => ({
      ref: b.id,
      name: b.name,
      description: b.description,
      inputs: b.inputsJson,
      steps: portableSteps(getBlock(db, b.id).steps as AnyStep[]) as Record<string, unknown>[],
    })),
    campaigns: listCampaigns(db, applicationId).map((c) => {
      const sel = c.selectionJson as {
        all?: boolean;
        modules?: string[];
        tags?: string[];
        scenarios?: string[];
      };
      const envName = new Map(envs.map((e) => [e.id, e.name]));
      return {
        name: c.name,
        description: c.description,
        all: !!sel.all,
        moduleRefs: sel.modules ?? [],
        tags: (sel.tags ?? []).map((t) => tagName.get(t)).filter((t): t is string => !!t),
        scenarioRefs: sel.scenarios ?? [],
        environments: c.environmentIdsJson.map((id) => envName.get(id)).filter((n): n is string => !!n),
        browsers: c.browsersJson,
        viewports: c.viewportsJson,
        options: c.optionsJson,
      };
    }),
    datasets: db
      .select()
      .from(datasets)
      .where(eq(datasets.applicationId, applicationId))
      .all()
      .map((d) => ({
        name: d.name,
        kind: d.kind,
        description: d.description,
        config: d.configJson,
        columns: d.columnsJson,
        rows: d.rowsJson,
      })),
    scenarios: scenarioIds.map((id) => {
      const s = getScenario(db, id);
      return {
        ref: s.id,
        moduleRef: s.moduleId,
        name: s.name,
        description: s.description,
        priority: s.priority,
        status: s.status,
        owner: s.owner,
        preconditions: s.preconditions,
        setupBlockRef: s.setupBlockId,
        teardownBlockRef: s.teardownBlockId,
        tags: s.tagIds.map((t) => tagName.get(t)!).filter(Boolean),
        steps: portableSteps(s.steps as AnyStep[]) as Record<string, unknown>[],
        testCases: s.testCases.map((t) => ({
          code: t.code,
          title: t.title,
          data: t.dataJson,
          expectedResult: t.expectedResult,
          priority: t.priority,
          technique: t.technique,
          status: t.status,
        })),
      };
    }),
  };
}

export type ImportResult = {
  applicationId: string;
  slug: string;
  counts: {
    environments: number;
    modules: number;
    scenarios: number;
    testCases: number;
    blocks: number;
    elements: number;
    campaigns: number;
  };
  /** Secrets to enter again, per environment. */
  missingSecrets: { environment: string; keys: string[] }[];
};

/** Creates a new application from an export, in one transaction. `slug` overrides the exported one. */
export function importApplication(
  db: StepForgeDb,
  input: unknown,
  opts: { slug?: string; name?: string } = {},
) {
  const parsed = ApplicationExport.safeParse(input);
  if (!parsed.success)
    throw invalid(
      `Not a StepForge application export: ${parsed.error.issues
        .slice(0, 3)
        .map((i) => `${i.path.join('.') || '(root)'} ${i.message}`)
        .join('; ')}`,
    );
  const d = parsed.data;
  const slug = opts.slug ?? d.application.slug;
  if (getApplicationBySlug(db, slug))
    throw invalid(`An application with slug "${slug}" already exists. Import it under another slug.`);

  return db.transaction((): ImportResult => {
    const app = createApplication(db, {
      ...d.application,
      name: opts.name ?? d.application.name,
      slug,
    });
    for (const e of d.environments)
      createEnvironment(db, app.id, {
        name: e.name,
        baseUrl: e.baseUrl,
        isProduction: e.isProduction,
        variables: e.variables,
        ...(e.browserDefaults && { browserDefaults: e.browserDefaults as never }),
      });
    const tagIds = new Map(d.tags.map((t) => [t.name, createTag(db, app.id, t).id]));

    // Parents first (an export lists modules in creation order, but don't rely on it).
    const moduleIds = new Map<string, string>();
    let pending = [...d.modules];
    while (pending.length) {
      const ready = pending.filter((m) => !m.parentRef || moduleIds.has(m.parentRef));
      if (!ready.length) throw invalid('The export has modules whose parent is missing');
      for (const m of ready)
        moduleIds.set(
          m.ref,
          createModule(db, app.id, {
            name: m.name,
            description: m.description,
            parentId: m.parentRef ? moduleIds.get(m.parentRef)! : null,
            sortOrder: m.sortOrder,
          }).id,
        );
      pending = pending.filter((m) => !ready.includes(m));
    }

    // Elements and blocks first, so steps can point at their new ids.
    const map: RefMap = { blocks: new Map(), scenarios: new Map(), elements: new Map() };
    for (const e of d.elements)
      map.elements.set(
        e.ref,
        createElement(db, app.id, {
          name: e.name,
          page: e.page,
          description: e.description,
          locators: e.locators as never,
        }).id,
      );
    for (const b of d.blocks)
      map.blocks.set(
        b.ref,
        createBlock(db, app.id, { name: b.name, description: b.description, inputs: b.inputs }).id,
      );
    for (const b of d.blocks)
      if (b.steps.length)
        saveBlockSteps(db, map.blocks.get(b.ref)!, portableSteps(b.steps as AnyStep[], map));
    for (const ds of d.datasets)
      db.insert(datasets)
        .values({
          id: newId(),
          applicationId: app.id,
          name: ds.name,
          kind: ds.kind,
          description: ds.description,
          configJson: ds.config,
          columnsJson: ds.columns,
          rowsJson: ds.rows,
        })
        .run();

    let testCases = 0;
    for (const s of d.scenarios) {
      const moduleId = moduleIds.get(s.moduleRef);
      if (!moduleId) throw invalid(`Scenario "${s.name}" belongs to a module that is not in the export`);
      const { id } = createScenario(db, moduleId, {
        name: s.name,
        description: s.description,
        priority: s.priority,
        status: s.status,
        owner: s.owner,
        preconditions: s.preconditions,
        steps: portableSteps(s.steps as AnyStep[], map),
      });
      map.scenarios.set(s.ref, id);
      db.update(scenarios)
        .set({
          setupBlockId: s.setupBlockRef ? (map.blocks.get(s.setupBlockRef) ?? null) : null,
          teardownBlockId: s.teardownBlockRef ? (map.blocks.get(s.teardownBlockRef) ?? null) : null,
        })
        .where(eq(scenarios.id, id))
        .run();
      setScenarioTags(
        db,
        app.id,
        id,
        s.tags.map((t) => tagIds.get(t)).filter((t): t is string => !!t),
      );
      for (const t of s.testCases) {
        createTestCase(db, id, { ...t, technique: t.technique as never });
        testCases++;
      }
    }
    // Campaigns last: they point at environments, tags, modules and scenarios that now exist.
    const envIds = new Map(listEnvironments(db, app.id).map((e) => [e.name, e.id]));
    for (const c of d.campaigns)
      saveCampaign(db, app.id, {
        name: c.name,
        description: c.description,
        selection: c.all
          ? { all: true }
          : {
              modules: c.moduleRefs.map((r) => moduleIds.get(r)).filter(Boolean),
              tags: c.tags.map((t) => tagIds.get(t)).filter(Boolean),
              scenarios: c.scenarioRefs.map((r) => map.scenarios.get(r)).filter(Boolean),
            },
        environmentIds: c.environments.map((n) => envIds.get(n)).filter(Boolean),
        browsers: c.browsers,
        viewports: c.viewports,
        options: c.options,
      });
    // A scenario may call one that was created after it: rewrite those references now that all ids exist.
    for (const s of d.scenarios)
      if (callsScenario(s.steps as AnyStep[]))
        saveSteps(db, map.scenarios.get(s.ref)!, portableSteps(s.steps as AnyStep[], map));

    return {
      applicationId: app.id,
      slug,
      counts: {
        environments: d.environments.length,
        modules: d.modules.length,
        scenarios: d.scenarios.length,
        testCases,
        blocks: d.blocks.length,
        elements: d.elements.length,
        campaigns: d.campaigns.length,
      },
      missingSecrets: d.environments
        .filter((e) => e.secretKeys.length)
        .map((e) => ({ environment: e.name, keys: e.secretKeys })),
    };
  });
}
