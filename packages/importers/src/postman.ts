import type { Assertion } from '@stepforge/core';
import type { ImportPlan, PlannedModule, PlannedStep } from './plan.ts';

type KV = { key: string; value?: string; disabled?: boolean; type?: string; src?: string };
type PmUrl = string | { raw?: string; host?: string[] | string; path?: string[] | string; query?: KV[] };
type PmAuth = { type: string; bearer?: KV[]; basic?: KV[]; apikey?: KV[] };
type PmRequest = {
  method?: string;
  header?: KV[];
  url?: PmUrl;
  body?: {
    mode?: string;
    raw?: string;
    urlencoded?: KV[];
    formdata?: KV[];
    graphql?: { query?: string; variables?: string };
    options?: { raw?: { language?: string } };
  };
  auth?: PmAuth;
};
type PmItem = {
  name: string;
  item?: PmItem[];
  request?: PmRequest | string;
  event?: { listen: string; script?: { exec?: string[] | string } }[];
};
type Collection = {
  info?: { name?: string; schema?: string };
  item?: PmItem[];
  variable?: KV[];
  auth?: PmAuth;
};

const kv = (list: KV[] | undefined, key: string) => list?.find((x) => x.key === key)?.value ?? '';

/** Postman `{{var}}` → StepForge `{{env.var}}` (keeps StepForge scopes untouched). */
function convertVars(s: string, vars: Set<string>): string {
  return s.replace(/\{\{\s*([A-Za-z_][\w.-]*)\s*\}\}/g, (m, name: string) => {
    if (/^(env|secret|data|vars|run|random)\./.test(name)) return m;
    vars.add(name);
    return `{{env.${name}}}`;
  });
}

function deepConvert<T>(v: T, vars: Set<string>): T {
  if (typeof v === 'string') return convertVars(v, vars) as T;
  if (Array.isArray(v)) return v.map((x) => deepConvert(x, vars)) as T;
  if (v && typeof v === 'object')
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, deepConvert(x, vars)])) as T;
  return v;
}

function urlOf(u: PmUrl | undefined): string {
  if (!u) return '';
  if (typeof u === 'string') return u;
  if (u.raw) return u.raw;
  const host = Array.isArray(u.host) ? u.host.join('.') : (u.host ?? '');
  const path = Array.isArray(u.path) ? u.path.join('/') : (u.path ?? '');
  const q = (u.query ?? [])
    .filter((x) => !x.disabled)
    .map((x) => `${x.key}=${x.value ?? ''}`)
    .join('&');
  return `${host}/${path}${q ? `?${q}` : ''}`;
}

/** Turns simple Postman test scripts into assertions; the rest is reported. */
function assertionsFrom(item: PmItem): { assertions: Assertion[]; unconverted: boolean } {
  const script = item.event?.find((e) => e.listen === 'test')?.script?.exec;
  const code = Array.isArray(script) ? script.join('\n') : (script ?? '');
  const assertions: Assertion[] = [];
  for (const m of code.matchAll(
    /to\.have\.status\((\d{3})\)|response\.code\)\.to\.(?:eql|equal)\((\d{3})\)/g,
  )) {
    assertions.push({ target: 'status', operator: 'equals', expected: Number(m[1] ?? m[2]) });
  }
  for (const m of code.matchAll(/responseTime\)\.to\.be\.below\((\d+)\)/g))
    assertions.push({ target: 'time', operator: 'lt', expected: Number(m[1]) });
  const other = code.replace(/\s/g, '').length > 0 && assertions.length === 0;
  return { assertions, unconverted: other };
}

function authParams(auth: PmAuth | undefined): Record<string, unknown> | undefined {
  if (!auth || auth.type === 'noauth') return undefined;
  if (auth.type === 'bearer') return { type: 'bearer', token: kv(auth.bearer, 'token') };
  if (auth.type === 'basic')
    return { type: 'basic', username: kv(auth.basic, 'username'), password: kv(auth.basic, 'password') };
  if (auth.type === 'apikey')
    return {
      type: 'apiKey',
      in: kv(auth.apikey, 'in') === 'query' ? 'query' : 'header',
      name: kv(auth.apikey, 'key'),
      value: kv(auth.apikey, 'value'),
    };
  return undefined;
}

/** Imports a Postman v2.0/v2.1 collection: folders → modules, requests → API scenarios. */
export function importPostman(input: unknown): ImportPlan {
  const col = (typeof input === 'string' ? JSON.parse(input) : input) as Collection;
  if (!col?.item || !col.info) throw new Error('Not a Postman collection (missing info/item)');
  const vars = new Set<string>();
  const warnings: string[] = [];
  let requests = 0;
  let unconvertedScripts = 0;

  const walk = (items: PmItem[], name: string, inherited: PmAuth | undefined): PlannedModule => {
    const mod: PlannedModule = { name, scenarios: [], children: [] };
    for (const it of items) {
      if (it.item) {
        mod.children!.push(walk(it.item, it.name, inherited));
        continue;
      }
      const req: PmRequest = typeof it.request === 'string' ? { url: it.request } : (it.request ?? {});
      requests++;
      const headers: Record<string, string> = {};
      for (const h of req.header ?? []) if (!h.disabled) headers[h.key.toLowerCase()] = h.value ?? '';
      let body: unknown;
      let bodyType: string | undefined;
      const b = req.body;
      if (b?.mode === 'raw' && b.raw) {
        try {
          body = JSON.parse(b.raw);
          bodyType = 'json';
        } catch {
          body = b.raw;
          bodyType = 'raw';
        }
      } else if (b?.mode === 'urlencoded') {
        body = Object.fromEntries(
          (b.urlencoded ?? []).filter((x) => !x.disabled).map((x) => [x.key, x.value ?? '']),
        );
        bodyType = 'form';
      } else if (b?.mode === 'formdata') {
        body = Object.fromEntries(
          (b.formdata ?? [])
            .filter((x) => !x.disabled)
            .map((x) => [x.key, x.type === 'file' ? { file: x.src ?? '' } : (x.value ?? '')]),
        );
        bodyType = 'multipart';
      }
      const { assertions, unconverted } = assertionsFrom(it);
      if (unconverted) unconvertedScripts++;
      const isGraphql = b?.mode === 'graphql';
      const step: PlannedStep = isGraphql
        ? {
            type: 'api.graphql',
            params: deepConvert(
              {
                url: urlOf(req.url),
                query: b?.graphql?.query ?? '',
                ...(b?.graphql?.variables ? { variables: JSON.parse(b.graphql.variables) } : {}),
                headers,
                ...(authParams(req.auth ?? inherited) && { auth: authParams(req.auth ?? inherited) }),
              },
              vars,
            ),
            assertions,
          }
        : {
            type: 'api.request',
            params: deepConvert(
              {
                method: (req.method ?? 'GET').toUpperCase(),
                url: urlOf(req.url),
                headers,
                ...(body !== undefined && { body, bodyType }),
                ...(authParams(req.auth ?? inherited) && { auth: authParams(req.auth ?? inherited) }),
              },
              vars,
            ),
            assertions: assertions.length
              ? assertions
              : [{ target: 'status', operator: 'lt', expected: 400 }],
          };
      mod.scenarios.push({ name: it.name, tags: ['api', 'postman'], steps: [step] });
    }
    return mod;
  };

  const root = walk(col.item, `${col.info.name ?? 'Postman collection'} (Postman)`, col.auth);
  if (unconvertedScripts)
    warnings.push(
      `${unconvertedScripts} request(s) had Postman test scripts that were not converted; review their assertions.`,
    );
  const variables: Record<string, string> = {};
  for (const name of vars) variables[name] = kv(col.variable, name);
  return { root, blocks: [], secretsNeeded: [], variables, warnings, stats: { requests } };
}
