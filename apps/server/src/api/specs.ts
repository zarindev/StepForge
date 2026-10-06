import { newId } from '@stepforge/core';
import { schema, type StepForgeDb } from '@stepforge/db';
import * as repo from '@stepforge/db/repos';
import { validateSchema, type ContractCheck } from '@stepforge/executor-api';
import {
  listOperations,
  loadOpenApi,
  matchOperation,
  parseSpecText,
  responseFor,
  responseSchema,
  type OpenApiDoc,
} from '@stepforge/importers';
import { desc, eq } from 'drizzle-orm';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type SpecSummary = { title: string; version: string; operations: ReturnType<typeof listOperations> };

/** Stores OpenAPI documents per application and validates live responses against them (contract checks). */
export class SpecService {
  private cache = new Map<string, OpenApiDoc>();

  constructor(
    private readonly db: StepForgeDb,
    private readonly dir: string,
  ) {
    mkdirSync(dir, { recursive: true });
  }

  list(applicationId: string) {
    return this.db
      .select({
        id: schema.apiSpecs.id,
        name: schema.apiSpecs.name,
        source: schema.apiSpecs.source,
        version: schema.apiSpecs.version,
        parsedJson: schema.apiSpecs.parsedJson,
        createdAt: schema.apiSpecs.createdAt,
      })
      .from(schema.apiSpecs)
      .where(eq(schema.apiSpecs.applicationId, applicationId))
      .orderBy(desc(schema.apiSpecs.createdAt))
      .all();
  }

  get(id: string) {
    const row = this.db.select().from(schema.apiSpecs).where(eq(schema.apiSpecs.id, id)).get();
    if (!row) throw repo.notFound('API spec', id);
    return row;
  }

  raw(id: string): unknown {
    return JSON.parse(readFileSync(this.get(id).rawPath, 'utf8'));
  }

  async add(applicationId: string, input: { name?: string; content: unknown }) {
    repo.getApplication(this.db, applicationId);
    const raw = typeof input.content === 'string' ? parseSpecText(input.content) : input.content;
    let doc: OpenApiDoc;
    try {
      doc = await loadOpenApi(raw);
    } catch (err) {
      throw new repo.RepoError(
        400,
        'invalid_spec',
        `Not a valid OpenAPI/Swagger document: ${(err as Error).message}`,
      );
    }
    const id = newId();
    const rawPath = join(this.dir, `${id}.json`);
    writeFileSync(rawPath, JSON.stringify(raw));
    const summary: SpecSummary = {
      title: doc.info?.title ?? 'API',
      version: doc.info?.version ?? '',
      operations: listOperations(doc),
    };
    this.db
      .insert(schema.apiSpecs)
      .values({
        id,
        applicationId,
        name: input.name || summary.title,
        source: 'openapi',
        rawPath,
        parsedJson: summary,
        version: summary.version,
      })
      .run();
    this.cache.set(id, doc);
    return this.list(applicationId).find((s) => s.id === id)!;
  }

  delete(id: string): void {
    const row = this.get(id);
    rmSync(row.rawPath, { force: true });
    this.cache.delete(id);
    this.db.delete(schema.apiSpecs).where(eq(schema.apiSpecs.id, id)).run();
  }

  private async doc(id: string): Promise<OpenApiDoc> {
    let d = this.cache.get(id);
    if (!d) {
      d = await loadOpenApi(this.raw(id));
      this.cache.set(id, d);
    }
    return d;
  }

  /** Validates a response against the operation in the spec (status documented + body schema). */
  async check(
    specId: string,
    req: { method: string; url: string },
    res: { status: number; headers: Record<string, string>; body: unknown },
  ): Promise<ContractCheck> {
    const doc = await this.doc(specId);
    const m = matchOperation(doc, req.method, req.url);
    const path = (() => {
      try {
        return new URL(req.url).pathname;
      } catch {
        return req.url;
      }
    })();
    if (!m) return { ok: false, errors: [`${req.method} ${path} is not described in the spec`] };
    const operation = `${req.method.toUpperCase()} ${m.path}`;
    const def = responseFor(m.op, res.status);
    if (!def) {
      return {
        ok: false,
        operation,
        errors: [
          `status ${res.status} is not documented (documented: ${Object.keys(m.op.responses ?? {}).join(', ')})`,
        ],
      };
    }
    const sch = responseSchema(m.op, res.status);
    if (sch && res.body !== '' && res.body !== null && res.body !== undefined) {
      const r = validateSchema(sch, res.body);
      if (!r.ok) return { ok: false, operation, errors: r.errors };
    }
    return { ok: true, operation, errors: [] };
  }

  /** Default spec of an application (latest), used when a contract check names no spec. */
  latestFor(applicationId: string): string | undefined {
    return this.list(applicationId)[0]?.id;
  }
}
