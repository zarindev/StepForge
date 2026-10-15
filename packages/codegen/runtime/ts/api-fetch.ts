// HTTP calls for tests exported by StepForge (by Md Zarin Tasnim), with Node's fetch.
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

/** Cookies set by responses, sent back on later requests of the same test run (like a browser session). */
const jar = new Map<string, string>();

/** Sends a request and returns status, headers, parsed body, text, time and size. */
export async function api(o: Options): Promise<ApiResult> {
  const started = Date.now();
  const url = new URL(o.url);
  for (const [k, v] of Object.entries(o.params ?? {})) url.searchParams.set(k, String(v));
  const headers: Record<string, string> = { ...(o.headers ?? {}) };
  if (jar.size && !Object.keys(headers).some((h) => h.toLowerCase() === 'cookie'))
    headers.Cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
  let body: BodyInit | undefined;
  if (o.json !== undefined) {
    body = JSON.stringify(o.json);
    headers['Content-Type'] ??= 'application/json';
  } else if (o.form) {
    body = new URLSearchParams(Object.entries(o.form).map(([k, v]) => [k, String(v)]));
  } else if (o.multipart) {
    const form = new FormData();
    for (const [k, v] of Object.entries(o.multipart)) form.append(k, String(v));
    body = form;
  } else if (o.data !== undefined) body = o.data;
  const res = await fetch(url, { method: o.method, headers, body });
  for (const c of res.headers.getSetCookie?.() ?? []) {
    const [pair] = c.split(';');
    const i = pair!.indexOf('=');
    if (i > 0) jar.set(pair!.slice(0, i).trim(), pair!.slice(i + 1).trim());
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  const text = buffer.toString('utf8');
  let parsed: unknown = text;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    // not JSON: keep the text
  }
  return {
    status: res.status,
    headers: Object.fromEntries(res.headers),
    body: parsed,
    text,
    ms: Date.now() - started,
    size: buffer.length,
  };
}

export const basicAuth = (user: string, password: string) =>
  `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
