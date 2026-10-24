// HTTP calls for tests exported by StepForge (by Md Zarin Tasnim), on Playwright's request context.
import type { APIRequestContext } from '@playwright/test';
import type { ApiLike } from './helpers';

export type ApiResult = ApiLike;

type Options = {
  method: string;
  url: string;
  headers?: Record<string, string>;
  params?: Record<string, string | number | boolean>;
  json?: unknown;
  form?: Record<string, string | number | boolean>;
  multipart?: Record<string, string | number | boolean>;
  data?: string;
};

/** Sends a request and returns status, headers, parsed body, text, time and size. */
export async function api(request: APIRequestContext, o: Options): Promise<ApiResult> {
  const started = Date.now();
  const res = await request.fetch(o.url, {
    method: o.method,
    headers: o.headers,
    params: o.params,
    ...(o.json !== undefined && { data: o.json }),
    ...(o.form && { form: o.form }),
    ...(o.multipart && { multipart: o.multipart }),
    ...(o.data !== undefined && { data: o.data }),
    failOnStatusCode: false,
  });
  const buffer = await res.body();
  const text = buffer.toString('utf8');
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // not JSON: keep the text
  }
  return {
    status: res.status(),
    headers: res.headers(),
    body,
    text,
    ms: Date.now() - started,
    size: buffer.length,
  };
}

export const basicAuth = (user: string, password: string) =>
  `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;

const tokens = new Map<string, { token: string; expires: number }>();

/**
 * An OAuth2 access token (client-credentials grant), as StepForge fetches it: the client id and secret as Basic
 * auth, `grant_type` and `scope` as a form; kept until shortly before it expires.
 */
export async function oauth2Token(
  request: APIRequestContext,
  o: { tokenUrl: string; clientId: string; clientSecret: string; scope?: string },
): Promise<string> {
  const key = `${o.tokenUrl}|${o.clientId}|${o.scope ?? ''}`;
  const hit = tokens.get(key);
  if (hit && hit.expires > Date.now()) return hit.token;
  const res = await request.post(o.tokenUrl, {
    headers: { Authorization: basicAuth(o.clientId, o.clientSecret) },
    form: { grant_type: 'client_credentials', ...(o.scope && { scope: o.scope }) },
    failOnStatusCode: false,
  });
  const json = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number };
  if (!res.ok() || !json.access_token) throw new Error(`OAuth2 token request failed with ${res.status()}`);
  tokens.set(key, {
    token: json.access_token,
    expires: Date.now() + Math.max(30, (json.expires_in ?? 300) - 30) * 1000,
  });
  return json.access_token;
}
