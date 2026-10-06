import { setSetting } from '@stepforge/db';
import * as repo from '@stepforge/db/repos';
import { LIGHTHOUSE_CATEGORIES, LOAD_PROFILES, PROFILE_HELP, toK6Script, LOAD_LIMITS } from '@stepforge/perf';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.ts';
import { AUTHORIZATION_STATEMENT } from '../perf/service.ts';

type P<T extends string> = { Params: Record<T, string> };

const LoadParams = z
  .object({
    requests: z
      .array(
        z.object({
          method: z.string().default('GET'),
          url: z.string().min(1),
          headers: z.record(z.string(), z.string()).optional(),
          body: z.unknown().optional(),
          auth: z.record(z.string(), z.unknown()).optional(),
        }),
      )
      .min(1)
      .max(50),
    profile: z.enum(LOAD_PROFILES).default('load'),
    vus: z.number().int().min(1).max(LOAD_LIMITS.maxVus).default(10),
    durationS: z.number().int().min(1).max(LOAD_LIMITS.maxDurationS).default(30),
    rampS: z.number().int().min(0).max(600).optional(),
    thresholds: z
      .object({
        p95Ms: z.number().positive().optional(),
        p99Ms: z.number().positive().optional(),
        avgMs: z.number().positive().optional(),
        maxErrorRatePct: z.number().min(0).max(100).optional(),
        minRps: z.number().positive().optional(),
      })
      .default({}),
    engine: z.enum(['builtin', 'k6']).default('builtin'),
  })
  .passthrough();

export function registerPerfRoutes(app: FastifyInstance, ctx: AppContext) {
  const perf = ctx.perf;

  app.get('/api/perf/info', async () => ({
    profiles: LOAD_PROFILES.map((p) => ({ id: p, help: PROFILE_HELP[p] })),
    limits: LOAD_LIMITS,
    lighthouseCategories: LIGHTHOUSE_CATEGORIES,
    authorizationStatement: AUTHORIZATION_STATEMENT,
    k6: perf.k6Status(),
  }));

  // Load-test authorization per application (stored with its timestamp).
  app.get<P<'id'>>('/api/applications/:id/load-authorization', async (req) => {
    repo.getApplication(ctx.db, req.params.id);
    return { authorization: perf.authorization(req.params.id) };
  });
  app.post<P<'id'>>('/api/applications/:id/load-authorization', async (req) => {
    z.object({ confirm: z.literal(true) }).parse(req.body);
    return { authorization: perf.authorize(req.params.id) };
  });
  app.delete<P<'id'>>('/api/applications/:id/load-authorization', async (req, reply) => {
    perf.revoke(req.params.id);
    return reply.code(204).send();
  });

  // Load Designer
  app.post('/api/perf/load', async (req, reply) => {
    const b = z
      .object({
        applicationId: z.string(),
        environmentId: z.string(),
        params: LoadParams,
        confirm: z.string().max(200).optional(),
      })
      .parse(req.body);
    return reply.code(202).send(perf.startLoad(b));
  });
  app.get<P<'id'>>('/api/perf/load/:id', async (req) => perf.getLoad(req.params.id));
  app.post<P<'id'>>('/api/perf/load/:id/cancel', async (req) => perf.cancelLoad(req.params.id));

  // k6
  app.post('/api/perf/k6-export', async (req) => {
    const b = z
      .object({
        environmentId: z.string().optional(),
        name: z.string().max(200).optional(),
        params: LoadParams,
      })
      .parse(req.body);
    const env = b.environmentId ? repo.getEnvironment(ctx.db, b.environmentId) : undefined;
    const requests = b.params.requests.map((r) => {
      const headers: Record<string, string> = { ...(r.headers ?? {}) };
      const auth = r.auth as { type?: string; token?: string; name?: string; value?: string } | undefined;
      if (auth?.type === 'bearer') headers.authorization = `Bearer ${auth.token ?? ''}`;
      if (auth?.type === 'apiKey') headers[auth.name ?? 'x-api-key'] = auth.value ?? '';
      const body =
        r.body === undefined || r.body === ''
          ? undefined
          : typeof r.body === 'string'
            ? r.body
            : JSON.stringify(r.body);
      if (body && typeof r.body !== 'string') headers['content-type'] ??= 'application/json';
      // Relative URLs are relative to the environment's base URL.
      const url =
        /^https?:\/\//.test(r.url) || r.url.startsWith('{{')
          ? r.url
          : `{{env.baseUrl}}${r.url.startsWith('/') ? '' : '/'}${r.url}`;
      return { method: r.method, url, headers, ...(body !== undefined && { body }) };
    });
    return {
      script: toK6Script({ ...b.params, requests, name: b.name, baseUrl: env?.baseUrl }),
    };
  });
  app.get('/api/perf/k6', async () => perf.k6Status());
  app.post('/api/perf/k6/install', async () => {
    try {
      return await perf.installK6();
    } catch (err) {
      throw new repo.RepoError(502, 'install_failed', (err as Error).message);
    }
  });
  app.put('/api/perf/k6/path', async (req) => {
    const { path } = z.object({ path: z.string().max(1000) }).parse(req.body);
    setSetting(ctx.db, 'k6Path', path.trim());
    return perf.k6Status();
  });

  // Lighthouse on demand
  app.post('/api/perf/lighthouse', async (req) => {
    const b = z
      .object({
        environmentId: z.string(),
        url: z.string().max(2000).default('/'),
        categories: z.array(z.enum(LIGHTHOUSE_CATEGORIES)).optional(),
        formFactor: z.enum(['desktop', 'mobile']).optional(),
      })
      .parse(req.body);
    return perf.lighthouse(b);
  });
}
