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
