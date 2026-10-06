import type { StepInput } from '@stepforge/core';

export type CapturedRequest = {
  id: number;
  method: string;
  url: string;
  status: number;
  contentType: string;
  requestHeaders: Record<string, string>;
  requestBody?: unknown;
  responseBody?: unknown;
  durationMs?: number;
  at: number;
};

/** Third-party noise that never belongs in API tests. */
const NOISE =
  /google-analytics|googletagmanager|doubleclick|facebook\.|hotjar|segment\.(io|com)|sentry\.io|mixpanel|amplitude|clarity\.ms|intercom|fullstory|newrelic|datadoghq|fonts\.(googleapis|gstatic)/i;
const STATIC = /\.(png|jpe?g|gif|svg|webp|ico|woff2?|ttf|css|js|map)(\?|$)/i;

export function isNoise(url: string): boolean {
  return NOISE.test(url) || STATIC.test(url);
}

const ID_SEGMENT =
  /^(\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{24}|[0-9A-HJKMNP-TV-Z]{26})$/i;

/** `/api/patients/42/notes` → `/api/patients/{id}/notes` */
export function pathTemplate(pathname: string): string {
  return pathname
    .split('/')
    .map((seg) => (ID_SEGMENT.test(seg) ? '{id}' : seg))
    .join('/');
}

/** Requests worth keeping as headers in an API test (others are browser noise or secrets). */
const KEEP_HEADERS = new Set(['content-type', 'accept', 'x-requested-with']);

/**
 * Turns captured XHR/fetch traffic into API steps: one per unique method + path template, with the
 * observed status as an assertion. Same-origin URLs become `{{env.baseUrl}}…`; auth headers become variables.
 */
export function networkToApiSteps(
  requests: CapturedRequest[],
  baseUrl: string,
): (StepInput & { label: string })[] {
  const origin = (() => {
    try {
      return new URL(baseUrl).origin;
    } catch {
      return '';
    }
  })();
  const seen = new Set<string>();
  const steps: (StepInput & { label: string })[] = [];
  for (const r of requests) {
    let u: URL;
    try {
      u = new URL(r.url);
    } catch {
      continue;
    }
    const key = `${r.method} ${u.origin}${pathTemplate(u.pathname)}`;
    if (seen.has(key) || isNoise(r.url)) continue;
    seen.add(key);
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(r.requestHeaders)) {
      const lk = k.toLowerCase();
      if (KEEP_HEADERS.has(lk)) headers[lk] = v;
      if (lk === 'authorization')
        headers.authorization = /^bearer /i.test(v)
          ? 'Bearer {{secret.apiToken}}'
          : '{{secret.apiAuthorization}}';
    }
    const url = (u.origin === origin ? '{{env.baseUrl}}' : u.origin) + u.pathname + u.search;
    steps.push({
      type: 'api.request',
      label: `${r.method} ${pathTemplate(u.pathname)}`,
      params: { method: r.method, url, headers, ...(r.requestBody !== undefined && { body: r.requestBody }) },
      assertions: [
        { target: 'status', operator: 'equals', expected: r.status },
        ...(r.durationMs !== undefined
          ? [
              {
                target: 'time',
                operator: 'lt' as const,
                expected: Math.max(1000, Math.ceil(r.durationMs * 3)),
              },
            ]
          : []),
      ],
    });
  }
  return steps;
}
