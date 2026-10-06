import { Assertion, VariableResolver } from '@stepforge/core';
import * as repo from '@stepforge/db/repos';
import { checkAssertions, send, type RequestSpec } from '@stepforge/executor-api';
import {
  importCurl,
  importHar,
  importOpenApi,
  importPostman,
  parseSpecText,
  type ImportPlan,
} from '@stepforge/importers';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { materializePlan } from '../api/materialize.ts';
import type { AppContext } from '../context.ts';

type P<T extends string> = { Params: Record<T, string> };

const SpecInput = z.object({
  name: z.string().max(120).optional(),
  content: z.unknown().optional(),
  /** Absolute URL, or a path resolved against `environmentId`'s base URL (e.g. /api/openapi.json). */
  url: z.string().optional(),
  environmentId: z.string().optional(),
});

const ImportInput = z.object({
  kind: z.enum(['openapi', 'postman', 'curl', 'har']),
  content: z.unknown().optional(),
  specId: z.string().optional(),
  parentModuleId: z.string().nullable().optional(),
  name: z.string().max(200).optional(),
  options: z
    .object({
      negative: z.boolean().optional(),
      destructive: z.boolean().optional(),
      contract: z.boolean().optional(),
    })
    .default({}),
});

const SendInput = z.object({
  environmentId: z.string(),
  request: z.object({
    method: z.string().default('GET'),
    url: z.string().min(1),
    headers: z.record(z.string(), z.string()).default({}),
    query: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
    body: z.unknown().optional(),
    bodyType: z.enum(['json', 'form', 'multipart', 'raw', 'none']).optional(),
    auth: z.record(z.string(), z.unknown()).optional(),
  }),
  assertions: z.array(Assertion).default([]),
  specId: z.string().optional(),
  timeoutMs: z.number().int().min(100).max(120_000).default(30_000),
});

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new repo.RepoError(400, 'fetch_failed', `Could not download ${url} (${res.status})`);
  return res.text();
}

/** API specs, imports (OpenAPI / Postman / cURL / HAR) and the API Client. */
export function registerApiRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db, specs } = ctx;

  app.get<P<'id'>>('/api/applications/:id/api-specs', async (req) => specs.list(req.params.id));
  app.get<P<'id'>>('/api/api-specs/:id', async (req) => {
    const s = specs.get(req.params.id);
    return { id: s.id, name: s.name, version: s.version, parsedJson: s.parsedJson, raw: specs.raw(s.id) };
  });
  app.post<P<'id'>>('/api/applications/:id/api-specs', async (req, reply) => {
    const d = SpecInput.parse(req.body);
    let content = d.content;
    if (d.url) {
      let url = d.url;
      if (!/^https?:\/\//.test(url)) {
        if (!d.environmentId)
          throw new repo.RepoError(400, 'invalid', 'A relative spec URL needs an environment');
        const env = repo.getEnvironment(db, d.environmentId);
        url = new URL(
          url.replace(/^\//, ''),
          env.baseUrl.endsWith('/') ? env.baseUrl : `${env.baseUrl}/`,
        ).toString();
      }
      content = await fetchText(url);
    }
    if (content === undefined) throw new repo.RepoError(400, 'invalid', 'Provide the spec content or a URL');
    return reply.code(201).send(await specs.add(req.params.id, { name: d.name, content }));
  });
  app.delete<P<'id'>>('/api/api-specs/:id', async (req, reply) => {
    specs.delete(req.params.id);
    return reply.code(204).send();
  });

  app.post<P<'id'>>('/api/applications/:id/import', async (req, reply) => {
    const appId = req.params.id;
    repo.getApplication(db, appId);
    const d = ImportInput.parse(req.body);
    let plan: ImportPlan;
    try {
      if (d.kind === 'openapi') {
        const raw = d.specId
          ? specs.raw(d.specId)
          : typeof d.content === 'string'
            ? parseSpecText(d.content)
            : d.content;
        plan = await importOpenApi(raw, {
          negative: d.options.negative,
          destructive: d.options.destructive,
          specId: d.options.contract && d.specId ? d.specId : undefined,
        });
      } else if (d.kind === 'postman') plan = importPostman(d.content);
      else if (d.kind === 'har') plan = importHar(d.content);
      else {
        const step = importCurl(String(d.content ?? ''));
        plan = {
          root: {
            name: d.name || 'Imported requests',
            scenarios: [{ name: step.label ?? 'cURL request', tags: ['api'], steps: [step] }],
          },
          blocks: [],
          secretsNeeded: [],
          variables: {},
          warnings: [],
          stats: { requests: 1 },
        };
      }
    } catch (err) {
      if ((err as Error).name === 'RepoError') throw err;
      throw new repo.RepoError(400, 'import_failed', (err as Error).message);
    }
    if (d.name && d.kind !== 'curl') plan.root.name = d.name;
    const result = materializePlan(db, appId, plan, { parentModuleId: d.parentModuleId ?? null });
    ctx.bus.publish({ type: 'tree.changed', applicationId: appId });
    return reply.code(201).send({ ...result, stats: plan.stats, variables: plan.variables });
  });

  /** Sends one request for the API Client with environment variables and secrets resolved. */
  app.post('/api/api-client/send', async (req) => {
    const d = SendInput.parse(req.body);
    const env = repo.getEnvironment(db, d.environmentId);
    const resolver = new VariableResolver({
      env: { ...env.variablesJson, baseUrl: env.baseUrl, name: env.name },
      secret: repo.resolveSecrets(db, ctx.masterKey, env.id),
      data: {},
      run: { id: 'api-client' },
      vars: {},
    });
    const mask = <T>(v: T): T => (v === undefined ? v : (JSON.parse(resolver.mask(JSON.stringify(v))) as T));
    let spec: RequestSpec;
    try {
      spec = resolver.resolve(d.request) as RequestSpec;
    } catch (err) {
      return { error: { kind: 'variable', message: (err as Error).message } };
    }
    try {
      const { request, response } = await send(spec, { baseUrl: env.baseUrl, timeoutMs: d.timeoutMs });
      const specId = d.specId ?? specs.latestFor(env.applicationId);
      const contract = specId ? await specs.check(specId, request, response).catch(() => null) : null;
      const assertions = checkAssertions(response, resolver.resolve(d.assertions) as Assertion[]);
      const { text: _t, ...res } = response;
      return {
        request: mask(request),
        response: mask(res),
        contract,
        assertions: mask(assertions),
        specId: specId ?? null,
      };
    } catch (err) {
      const e = err as { kind?: string; message: string };
      return { error: { kind: e.kind ?? 'unknown', message: resolver.mask(e.message) } };
    }
  });
}
