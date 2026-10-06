import {
  generate,
  TARGETS,
  zipProject,
  type CodegenInput,
  type CodegenStep,
  type TargetId,
} from '@stepforge/codegen';
import { newId } from '@stepforge/core';
import { schema, type StepForgeDb } from '@stepforge/db';
import * as repo from '@stepforge/db/repos';
import { desc, eq } from 'drizzle-orm';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { branding } from '../diagnosis/report-data.ts';

export const CodegenRequest = z.object({
  target: z.enum(TARGETS.map((t) => t.id) as [TargetId, ...TargetId[]]),
  environmentId: z.string().optional(),
  /** Which tests: all, a module (with sub-modules), a tag or picked scenarios. */
  scope: z
    .discriminatedUnion('type', [
      z.object({ type: z.literal('application') }),
      z.object({ type: z.literal('module'), id: z.string() }),
      z.object({ type: z.literal('tag'), id: z.string() }),
      z.object({ type: z.literal('scenarios'), ids: z.array(z.string()).min(1) }),
    ])
    .default({ type: 'application' }),
  pom: z.boolean().default(false),
  ci: z.array(z.enum(['github', 'gitlab'])).default([]),
});
export type CodegenRequest = z.input<typeof CodegenRequest>;

const SECRET_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Gathers what the code generators need. Secret values are never read, only their names. */
export function codegenInput(
  db: StepForgeDb,
  applicationId: string,
  req: z.infer<typeof CodegenRequest>,
): CodegenInput {
  const app = repo.getApplication(db, applicationId);
  const envs = repo.listEnvironments(db, applicationId);
  const env = req.environmentId ? envs.find((e) => e.id === req.environmentId) : envs[0];
  if (!env) throw new repo.RepoError(400, 'invalid', 'The application needs an environment to export from');
  const tree = repo.getTree(db, applicationId);
  const moduleById = new Map(tree.modules.map((m) => [m.id, m]));
  const pathOf = (id: string): string[] => {
    const m = moduleById.get(id);
    return m ? [...(m.parentId ? pathOf(m.parentId) : []), m.name] : [];
  };
  const tags = new Map(repo.listTags(db, applicationId).map((t) => [t.id, t.name]));
  const scope = req.scope;
  const allowedModules =
    scope.type === 'module' ? new Set([scope.id, ...repo.descendantIds(db, scope.id)]) : null;
  const picked = tree.scenarios.filter((s) => {
    if (scope.type === 'module') return allowedModules!.has(s.moduleId);
    if (scope.type === 'scenarios') return scope.ids.includes(s.id);
    return true;
  });
  const details = picked
    .map((s) => repo.getScenario(db, s.id))
    .filter((s) => scope.type !== 'tag' || s.tagIds.includes(scope.id));
  if (!details.length) throw new repo.RepoError(400, 'invalid', 'No scenarios match this selection');
  const steps = (list: unknown[]) => list as CodegenStep[];
  const library = Object.fromEntries(
    tree.scenarios.map((s) => {
      const d = details.find((x) => x.id === s.id) ?? repo.getScenario(db, s.id);
      return [s.id, { name: d.name, steps: steps(d.steps) }];
    }),
  );
  const blocks = Object.fromEntries(
    repo
      .listBlocks(db, applicationId)
      .map((b) => [b.id, { name: b.name, steps: steps(repo.getBlock(db, b.id).steps) }]),
  );
  return {
    application: { name: app.name, slug: app.slug },
    environment: {
      name: env.name,
      baseUrl: env.baseUrl,
      variables: env.variablesJson,
      secretKeys: repo
        .listSecrets(db, env.id)
        .map((s) => s.key)
        .filter((k) => SECRET_NAME.test(k)),
    },
    connections: repo
      .listConnections(db, applicationId)
      .filter((c) => c.environmentId === env.id)
      .map((c) => ({ name: c.name, engine: c.engine })),
    inboxes: repo.listInboxes(db, applicationId).map((i) => ({ name: i.name, kind: i.kind })),
    scenarios: details.map((d) => ({
      id: d.id,
      name: d.name,
      description: d.description,
      modulePath: pathOf(d.moduleId),
      priority: d.priority,
      tags: d.tagIds.map((t) => tags.get(t) ?? '').filter(Boolean),
      preconditions: d.preconditions,
      steps: steps(d.steps),
      testCases: d.testCases
        .filter((t) => t.status === 'active')
        .map((t) => ({
          code: t.code,
          title: t.title,
          data: t.dataJson,
          expectedResult: t.expectedResult,
          priority: t.priority,
        })),
    })),
    blocks,
    library,
    author: branding(db).author,
    generatedAt: new Date().toISOString(),
  };
}

const TEXT_LIMIT = 200_000;

export class CodegenService {
  constructor(
    private readonly db: StepForgeDb,
    private readonly artifactsDir: string,
  ) {}

  async build(applicationId: string, body: unknown) {
    const req = CodegenRequest.parse(body);
    const input = codegenInput(this.db, applicationId, req);
    const project = await generate(input, { target: req.target, pom: req.pom, ci: req.ci });
    return { req, input, project };
  }

  /** Files (text shown in the dialog), warnings and how to run it. */
  async preview(applicationId: string, body: unknown) {
    const { project, input } = await this.build(applicationId, body);
    return {
      target: project.target,
      run: project.run,
      warnings: project.warnings,
      scenarios: input.scenarios.length,
      files: Object.entries(project.files)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([path, content]) =>
          typeof content === 'string'
            ? {
                path,
                size: Buffer.byteLength(content),
                content: content.length > TEXT_LIMIT ? `${content.slice(0, TEXT_LIMIT)}\n…` : content,
              }
            : { path, size: content.length, binary: true },
        ),
    };
  }

  /** The project as a zip; the export is recorded (Exports page history) and kept in the artifacts folder. */
  async download(applicationId: string, body: unknown) {
    const { req, project, input } = await this.build(applicationId, body);
    const folder = `${input.application.slug}-${req.target}`;
    const single = Object.keys(project.files);
    // A single document (e.g. the Excel test cases) downloads as-is.
    const asFile = single.length === 1 && req.target.startsWith('docs-');
    const data = asFile ? Buffer.from(project.files[single[0]!]!) : await zipProject(project, folder);
    const filename = asFile ? single[0]! : `${folder}.zip`;
    const id = newId();
    const rel = join('exports', `${id}-${filename}`);
    mkdirSync(join(this.artifactsDir, 'exports'), { recursive: true });
    writeFileSync(join(this.artifactsDir, rel), data);
    this.db
      .insert(schema.exportsTable)
      .values({
        id,
        applicationId,
        kind: req.target,
        optionsJson: {
          ...req,
          scenarios: input.scenarios.length,
          warnings: project.warnings.length,
          filename,
        },
        path: rel,
      })
      .run();
    return { id, data, filename };
  }

  list(applicationId?: string) {
    const q = this.db.select().from(schema.exportsTable);
    return (applicationId ? q.where(eq(schema.exportsTable.applicationId, applicationId)) : q)
      .orderBy(desc(schema.exportsTable.createdAt))
      .limit(50)
      .all();
  }
}
