import fastifyStatic from '@fastify/static';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AppContext } from '../context.ts';

const TOKEN_PLACEHOLDER = '<!--STEPFORGE_SESSION-->';

/** Serves the built dashboard with the session token injected into index.html. */
export async function registerStaticRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const indexFile = join(ctx.config.webDist, 'index.html');
  if (!existsSync(indexFile)) {
    app.log.warn(
      `Dashboard build not found at ${ctx.config.webDist}. Run "npm run build" (setup does this).`,
    );
    app.get('/', async (_req, reply) =>
      reply
        .type('text/html')
        .send(
          '<h1>StepForge</h1><p>The dashboard is not built yet. Run <code>npm run build</code> and restart.</p>',
        ),
    );
    return;
  }

  const html = readFileSync(indexFile, 'utf8').replace(
    TOKEN_PLACEHOLDER,
    `<script>window.__STEPFORGE__=${JSON.stringify({ token: ctx.token })}</script>`,
  );
  const sendIndex = (reply: FastifyReply) =>
    reply.header('cache-control', 'no-store').type('text/html').send(html);

  await app.register(fastifyStatic, {
    root: ctx.config.webDist,
    index: false,
    wildcard: false,
    decorateReply: false,
  });
  app.get('/', async (_req, reply) => sendIndex(reply));
  app.setNotFoundHandler(async (req, reply) => {
    if (req.url.startsWith('/api/') || req.url.startsWith('/trace-viewer/'))
      return reply.code(404).send({ error: 'not_found', message: 'No such endpoint' });
    // Static assets are served by @fastify/static; everything else is a client-side route.
    if (req.method === 'GET' && !/\.[a-z0-9]+$/i.test(req.url.split('?')[0] ?? '')) return sendIndex(reply);
    return reply.code(404).send('Not found');
  });
}
