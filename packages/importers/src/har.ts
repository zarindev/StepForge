import { isNoise, networkToApiSteps, pathTemplate, type CapturedRequest } from './network.ts';
import type { ImportPlan } from './plan.ts';

type HarEntry = {
  _resourceType?: string;
  request: {
    method: string;
    url: string;
    headers?: { name: string; value: string }[];
    postData?: { mimeType?: string; text?: string };
  };
  response: { status: number; content?: { mimeType?: string } };
  time?: number;
};

/** Imports a HAR file (browser devtools "Save all as HAR"): XHR/fetch/JSON calls become deduped API tests. */
export function importHar(input: unknown, opts: { baseUrl?: string } = {}): ImportPlan {
  const har = (typeof input === 'string' ? JSON.parse(input) : input) as { log?: { entries?: HarEntry[] } };
  const entries = har.log?.entries;
  if (!entries) throw new Error('Not a HAR file (missing log.entries)');
  const api = entries.filter((e) => {
    if (isNoise(e.request.url)) return false;
    if (e._resourceType) return ['xhr', 'fetch'].includes(e._resourceType);
    return /json|xml|text\/plain/.test(e.response.content?.mimeType ?? '');
  });
  const captured: CapturedRequest[] = api.map((e, i) => {
    let body: unknown = e.request.postData?.text;
    if (typeof body === 'string') {
      try {
        body = JSON.parse(body);
      } catch {
        // keep raw text
      }
    }
    return {
      id: i + 1,
      method: e.request.method,
      url: e.request.url,
      status: e.response.status,
      contentType: e.response.content?.mimeType ?? '',
      requestHeaders: Object.fromEntries(
        (e.request.headers ?? []).map((h) => [h.name.toLowerCase(), h.value]),
      ),
      requestBody: body,
      durationMs: e.time !== undefined ? Math.round(e.time) : undefined,
      at: i,
    };
  });
  const baseUrl = opts.baseUrl ?? (captured[0] ? new URL(captured[0].url).origin : '');
  const steps = networkToApiSteps(captured, baseUrl);
  const byResource = new Map<string, typeof steps>();
  for (const s of steps) {
    const seg =
      pathTemplate(
        new URL(String((s.params as { url: string }).url).replace('{{env.baseUrl}}', baseUrl || 'http://x'))
          .pathname,
      )
        .split('/')
        .filter((x) => x && !/^(api|v\d+|\{id\})$/i.test(x))[0] ?? 'root';
    byResource.set(seg, [...(byResource.get(seg) ?? []), s]);
  }
  return {
    root: {
      name: 'HAR import',
      scenarios: [],
      children: [...byResource].map(([name, list]) => ({
        name,
        scenarios: list.map((s) => ({ name: s.label, tags: ['api', 'har'], steps: [s] })),
      })),
    },
    blocks: [],
    secretsNeeded: [
      ...new Set(
        steps.flatMap(
          (s) =>
            JSON.stringify(s)
              .match(/secret\.(\w+)/g)
              ?.map((m) => m.slice(7)) ?? [],
        ),
      ),
    ],
    variables: { baseUrl },
    warnings:
      entries.length - api.length > 0
        ? [`${entries.length - api.length} non-API entries (pages, images, scripts, analytics) were skipped.`]
        : [],
    stats: { entries: entries.length, requests: steps.length },
  };
}
