import { StepError } from '@stepforge/core';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

export type Auth =
  | { type: 'none' }
  | { type: 'bearer'; token: string }
  | { type: 'basic'; username: string; password: string }
  | { type: 'apiKey'; in?: 'header' | 'query'; name: string; value: string }
  | { type: 'oauth2'; tokenUrl: string; clientId: string; clientSecret: string; scope?: string }
  | { type: 'cookie'; name: string; value: string };

export type RequestSpec = {
  method?: string;
  url: string;
  headers?: Record<string, string>;
  query?: Record<string, string | number | boolean>;
  body?: unknown;
  bodyType?: 'json' | 'form' | 'multipart' | 'raw' | 'none';
  auth?: Auth;
  followRedirects?: boolean;
  /** Send cookies stored from earlier responses in this test (default true). */
  cookies?: boolean;
};

export type HttpResponse = {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: unknown;
  /** Raw text (possibly truncated) for regex checks. */
  text: string;
  timeMs: number;
  size: number;
  url: string;
};

export type SentRequest = { method: string; url: string; headers: Record<string, string>; body?: unknown };

const MAX_STORED_BODY = 64 * 1024;

/** Minimal per-test cookie jar keyed by origin. */
export class CookieJar {
  private jar = new Map<string, Map<string, string>>();
  store(url: string, setCookies: string[]): void {
    const origin = new URL(url).origin;
    const m = this.jar.get(origin) ?? new Map<string, string>();
    for (const c of setCookies) {
      const [pair, ...attrs] = c.split(';');
      const eq = pair!.indexOf('=');
      if (eq < 1) continue;
      const name = pair!.slice(0, eq).trim();
      const value = pair!.slice(eq + 1).trim();
      const expired = attrs.some((a) => /^\s*max-age=0\s*$/i.test(a)) || value === '';
      if (expired) m.delete(name);
      else m.set(name, value);
    }
    this.jar.set(origin, m);
  }
  header(url: string): string | undefined {
    const m = this.jar.get(new URL(url).origin);
    return m && m.size ? [...m].map(([k, v]) => `${k}=${v}`).join('; ') : undefined;
  }
}

export function resolveUrl(url: string, baseUrl?: string, query?: RequestSpec['query']): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    if (!baseUrl)
      throw new StepError('invalid_params', `Relative URL "${url}" needs an environment base URL`);
    u = new URL(url.replace(/^\//, ''), baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
  }
  for (const [k, v] of Object.entries(query ?? {})) u.searchParams.set(k, String(v));
  return u.toString();
}

const oauthCache = new Map<string, { token: string; expires: number }>();

async function oauthToken(a: Extract<Auth, { type: 'oauth2' }>, signal: AbortSignal): Promise<string> {
  const key = `${a.tokenUrl}|${a.clientId}|${a.scope ?? ''}`;
  const hit = oauthCache.get(key);
  if (hit && hit.expires > Date.now()) return hit.token;
  const res = await fetch(a.tokenUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      authorization: `Basic ${Buffer.from(`${a.clientId}:${a.clientSecret}`).toString('base64')}`,
    },
    body: new URLSearchParams({ grant_type: 'client_credentials', ...(a.scope && { scope: a.scope }) }),
    signal,
  });
  const json = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number };
  if (!res.ok || !json.access_token)
    throw new StepError('network', `OAuth2 token request failed with ${res.status}`);
  oauthCache.set(key, {
    token: json.access_token,
    expires: Date.now() + Math.max(30, (json.expires_in ?? 300) - 30) * 1000,
  });
  return json.access_token;
}

function encodeBody(
  spec: RequestSpec,
  headers: Record<string, string>,
): string | URLSearchParams | FormData | undefined {
  const type =
    spec.bodyType ?? (spec.body === undefined ? 'none' : typeof spec.body === 'string' ? 'raw' : 'json');
  if (type === 'none' || spec.body === undefined) return undefined;
  if (type === 'json') {
    headers['content-type'] ??= 'application/json';
    return typeof spec.body === 'string' ? spec.body : JSON.stringify(spec.body);
  }
  if (type === 'form') {
    headers['content-type'] ??= 'application/x-www-form-urlencoded';
    return new URLSearchParams(
      Object.entries(spec.body as Record<string, unknown>).map(([k, v]): [string, string] => [k, String(v)]),
    );
  }
  if (type === 'multipart') {
    const fd = new FormData();
    for (const [k, v] of Object.entries(spec.body as Record<string, unknown>)) {
      if (v && typeof v === 'object' && 'file' in v) {
        const path = String((v as { file: string }).file);
        fd.append(k, new Blob([readFileSync(path)]), basename(path));
      } else fd.append(k, String(v));
    }
    return fd;
  }
  return String(spec.body);
}

/** Sends one HTTP request with auth, cookies, timeout and cancellation; never throws on HTTP status. */
export async function send(
  spec: RequestSpec,
  opts: { baseUrl?: string; timeoutMs: number; signal?: AbortSignal; jar?: CookieJar },
): Promise<{ request: SentRequest; response: HttpResponse }> {
  const method = (spec.method ?? 'GET').toUpperCase();
  const headers: Record<string, string> = Object.fromEntries(
    Object.entries(spec.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)]),
  );
  const query = { ...(spec.query ?? {}) };
  const timeout = AbortSignal.timeout(opts.timeoutMs);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
  const auth = spec.auth ?? { type: 'none' };
  if (auth.type === 'bearer') headers.authorization = `Bearer ${auth.token}`;
  if (auth.type === 'basic')
    headers.authorization = `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString('base64')}`;
  if (auth.type === 'apiKey') {
    if (auth.in === 'query') query[auth.name] = auth.value;
    else headers[auth.name.toLowerCase()] = auth.value;
  }
  if (auth.type === 'oauth2') headers.authorization = `Bearer ${await oauthToken(auth, signal)}`;
  const url = resolveUrl(spec.url, opts.baseUrl, query);
  const jarCookie = spec.cookies === false ? undefined : opts.jar?.header(url);
  const cookieParts = [
    headers.cookie,
    jarCookie,
    auth.type === 'cookie' ? `${auth.name}=${auth.value}` : undefined,
  ].filter(Boolean);
  if (cookieParts.length) headers.cookie = cookieParts.join('; ');
  const body = method === 'GET' || method === 'HEAD' ? undefined : encodeBody(spec, headers);

  const started = performance.now();
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers,
      body,
      redirect: spec.followRedirects === false ? 'manual' : 'follow',
      signal,
    });
  } catch (err) {
    const e = err as Error & { cause?: { code?: string; message?: string } };
    if (opts.signal?.aborted) throw new StepError('aborted', 'Run was cancelled');
    if (e.name === 'TimeoutError' || timeout.aborted)
      throw new StepError('timeout', `${method} ${url} did not respond within ${opts.timeoutMs} ms`);
    const code = e.cause?.code ?? '';
    throw new StepError(
      'network',
      `${method} ${url} failed: ${code ? `${code} ` : ''}${e.cause?.message ?? e.message}`,
      { code },
    );
  }
  const buf = Buffer.from(await res.arrayBuffer());
  const timeMs = Math.round(performance.now() - started);
  const resHeaders: Record<string, string> = {};
  res.headers.forEach((v, k) => (resHeaders[k] = v));
  const setCookies = res.headers.getSetCookie?.() ?? [];
  if (setCookies.length) opts.jar?.store(url, setCookies);
  const text = buf.toString('utf8');
  let parsed: unknown = text;
  if (/json/i.test(resHeaders['content-type'] ?? '') || /^\s*[[{]/.test(text)) {
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }
  }
  const sentBody =
    typeof body === 'string'
      ? (() => {
          try {
            return JSON.parse(body);
          } catch {
            return body;
          }
        })()
      : body instanceof URLSearchParams
        ? Object.fromEntries(body)
        : body
          ? '[multipart]'
          : undefined;
  return {
    request: { method, url, headers, ...(sentBody !== undefined && { body: sentBody }) },
    response: {
      status: res.status,
      statusText: res.statusText,
      headers: resHeaders,
      body:
        text.length > MAX_STORED_BODY && typeof parsed === 'string'
          ? `${text.slice(0, MAX_STORED_BODY)}… [truncated]`
          : parsed,
      text: text.slice(0, MAX_STORED_BODY),
      timeMs,
      size: buf.length,
      url: res.url || url,
    },
  };
}
