import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';

/**
 * Local-only protections (Section 9):
 *  - a random session token per server start, required on every /api request and WebSocket;
 *  - a Host header allow-list, which defeats DNS-rebinding attacks from other websites.
 */

export const TOKEN_HEADER = 'x-stepforge-token';
const PUBLIC_ROUTES = new Set(['/api/health']);

export function generateSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

export function tokensMatch(expected: string, provided: unknown): boolean {
  if (typeof provided !== 'string') return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function isAllowedHost(host: string | undefined): boolean {
  if (!host) return false;
  const name = host.replace(/:\d+$/, '').toLowerCase();
  return name === '127.0.0.1' || name === 'localhost' || name === '[::1]';
}

function tokenFrom(req: FastifyRequest): unknown {
  const header = req.headers[TOKEN_HEADER];
  if (header) return header;
  // WebSockets cannot set headers from the browser, so they pass the token as a query param.
  return (req.query as Record<string, unknown> | undefined)?.token;
}

export function registerSecurity(app: FastifyInstance, token: string): void {
  app.addHook('onRequest', async (req, reply) => {
    if (!isAllowedHost(req.headers.host)) {
      return reply
        .code(403)
        .send({ error: 'forbidden_host', message: 'StepForge only accepts localhost requests' });
    }
    const path = req.url.split('?')[0] ?? '';
    if (!path.startsWith('/api/') || PUBLIC_ROUTES.has(path)) return;
    if (!tokensMatch(token, tokenFrom(req))) {
      return reply.code(401).send({ error: 'unauthorized', message: 'Missing or invalid session token' });
    }
  });
}
