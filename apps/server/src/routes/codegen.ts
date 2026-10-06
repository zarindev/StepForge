import { TARGETS } from '@stepforge/codegen';
import * as repo from '@stepforge/db/repos';
import type { FastifyInstance } from 'fastify';
import { createReadStream, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { AppContext } from '../context.ts';

type P<T extends string> = { Params: Record<T, string> };

const TYPE = (name: string) =>
  name.endsWith('.zip')
    ? 'application/zip'
    : name.endsWith('.xlsx')
      ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      : name.endsWith('.json')
        ? 'application/json'
        : 'text/plain; charset=utf-8';

export function registerCodegenRoutes(app: FastifyInstance, ctx: AppContext) {
  const { codegen } = ctx;
  app.get('/api/codegen/targets', async () => TARGETS);
  app.post<P<'id'>>('/api/applications/:id/codegen/preview', async (req) =>
    codegen.preview(req.params.id, req.body),
  );
  app.post<P<'id'>>('/api/applications/:id/codegen/download', async (req, reply) => {
    const r = await codegen.download(req.params.id, req.body);
    return reply
      .header('content-type', TYPE(r.filename))
      .header('content-disposition', `attachment; filename="${r.filename.replace(/[^\w.-]+/g, '_')}"`)
      .header('x-export-id', r.id)
      .send(r.data);
  });
  app.get<{ Querystring: { applicationId?: string } }>('/api/exports', async (req) =>
    codegen.list(req.query.applicationId || undefined),
  );
  /** Downloads an earlier export again. */
  app.get<P<'id'>>('/api/exports/:id/file', async (req, reply) => {
    const e = codegen.list().find((x) => x.id === req.params.id);
    if (!e) throw repo.notFound('Export', req.params.id);
    const file = join(ctx.config.artifactsDir, e.path);
    if (!existsSync(file)) throw new repo.RepoError(404, 'not_found', 'The export file was deleted');
    const name = String((e.optionsJson as { filename?: string }).filename ?? 'export.zip');
    return reply
      .header('content-type', TYPE(name))
      .header('content-disposition', `attachment; filename="${name.replace(/[^\w.-]+/g, '_')}"`)
      .send(createReadStream(file));
  });
}
