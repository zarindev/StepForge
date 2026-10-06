import SwaggerParser from '@apidevtools/swagger-parser';
import type { Assertion } from '@stepforge/core';
import YAML from 'yaml';
import {
  blockRef,
  type ImportPlan,
  type PlannedModule,
  type PlannedScenario,
  type PlannedStep,
} from './plan.ts';

type Schema = {
  type?: string | string[];
  properties?: Record<string, Schema>;
  required?: string[];
  items?: Schema;
  enum?: unknown[];
  example?: unknown;
  default?: unknown;
  format?: string;
  allOf?: Schema[];
  oneOf?: Schema[];
  anyOf?: Schema[];
  nullable?: boolean;
  minimum?: number;
  pattern?: string;
};
type MediaType = { schema?: Schema; example?: unknown; examples?: Record<string, { value?: unknown }> };
type Parameter = { name: string; in: string; required?: boolean; schema?: Schema; example?: unknown };
type Operation = {
  operationId?: string;
  summary?: string;
  tags?: string[];
  parameters?: Parameter[];
  requestBody?: { required?: boolean; content?: Record<string, MediaType> };
  responses?: Record<string, { description?: string; content?: Record<string, MediaType> }>;
  security?: Record<string, string[]>[];
  deprecated?: boolean;
};
export type OpenApiDoc = {
  openapi?: string;
  swagger?: string;
  info?: { title?: string; version?: string };
  servers?: { url: string }[];
  basePath?: string;
  host?: string;
  security?: Record<string, string[]>[];
  paths?: Record<string, Record<string, Operation | Parameter[]>>;
  components?: {
    securitySchemes?: Record<string, { type: string; scheme?: string; in?: string; name?: string }>;
  };
  securityDefinitions?: Record<string, { type: string; in?: string; name?: string }>;
};

export type OpenApiOperation = {
  method: string;
  path: string;
  operationId?: string;
  summary?: string;
  tags: string[];
  secured: boolean;
};
export type OpenApiOptions = {
  /** Generate negative tests (missing field, wrong type, invalid enum, unauthorized, not found). Default true. */
  negative?: boolean;
  /** Generate happy-path DELETE tests (they destroy data). Default false. */
  destructive?: boolean;
  /** Spec id stored by StepForge: enables `contract` checks on generated steps. */
  specId?: string;
  maxRequiredFieldTests?: number;
  responseTimeMs?: number;
};

const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];
const SECRET_FIELD = /pass(word)?|secret|token|api[-_]?key/i;

/** Parses JSON or YAML text. */
export function parseSpecText(text: string): unknown {
  const t = text.trim();
  return t.startsWith('{') || t.startsWith('[') ? JSON.parse(t) : YAML.parse(t);
}

/** Validates and fully dereferences an OpenAPI 3 / Swagger 2 document (circular refs left as-is). */
export async function loadOpenApi(input: unknown): Promise<OpenApiDoc> {
  const doc = typeof input === 'string' ? parseSpecText(input) : structuredClone(input);
  return (await SwaggerParser.dereference(doc as never, {
    dereference: { circular: 'ignore' },
  })) as OpenApiDoc;
}

export function listOperations(doc: OpenApiDoc): OpenApiOperation[] {
  const out: OpenApiOperation[] = [];
  for (const [path, item] of Object.entries(doc.paths ?? {})) {
    for (const method of METHODS) {
      const op = item[method] as Operation | undefined;
      if (!op) continue;
      out.push({
        method: method.toUpperCase(),
        path,
        operationId: op.operationId,
        summary: op.summary,
        tags: op.tags ?? [],
        secured: isSecured(doc, op),
      });
    }
  }
  return out;
}

function isSecured(doc: OpenApiDoc, op: Operation): boolean {
  const sec = op.security ?? doc.security ?? [];
  return sec.length > 0 && sec.some((s) => Object.keys(s).length > 0);
}

/** Base path prefix from servers[0] (OpenAPI 3) or basePath (Swagger 2), as used after {{env.baseUrl}}. */
function basePath(doc: OpenApiDoc): string {
  const raw = doc.servers?.[0]?.url ?? doc.basePath ?? '';
  try {
    return new URL(raw).pathname.replace(/\/$/, '');
  } catch {
    return raw.replace(/\/$/, '');
  }
}

function merged(s: Schema | undefined): Schema | undefined {
  if (!s?.allOf) return s;
  return s.allOf.reduce<Schema>(
    (acc, part) => {
      const p = merged(part) ?? {};
      return {
        ...acc,
        ...p,
        properties: { ...acc.properties, ...p.properties },
        required: [...(acc.required ?? []), ...(p.required ?? [])],
      };
    },
    { ...s, allOf: undefined },
  );
}

/** Builds a plausible value for a schema (examples first, then formats/types). */
export function sample(schemaIn: Schema | undefined, depth = 0): unknown {
  const schema = merged(schemaIn);
  if (!schema || depth > 6) return null;
  if (schema.example !== undefined) return schema.example;
  if (schema.default !== undefined) return schema.default;
  if (schema.enum?.length) return schema.enum[0];
  if (schema.oneOf?.[0] || schema.anyOf?.[0])
    return sample(schema.oneOf?.[0] ?? schema.anyOf?.[0], depth + 1);
  const type = Array.isArray(schema.type) ? schema.type.find((t) => t !== 'null') : schema.type;
  switch (type ?? (schema.properties ? 'object' : undefined)) {
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(schema.properties ?? {})) out[k] = sample(v, depth + 1);
      return out;
    }
    case 'array':
      return [sample(schema.items, depth + 1)];
    case 'integer':
      return Math.max(1, schema.minimum ?? 1);
    case 'number':
      return Math.max(1, schema.minimum ?? 1);
    case 'boolean':
      return true;
    case 'string':
      if (schema.format === 'date') return '2026-01-15';
      if (schema.format === 'date-time') return '2026-01-15T10:00:00Z';
      if (schema.format === 'email') return 'test@example.test';
      if (schema.format === 'uuid') return '00000000-0000-4000-8000-000000000001';
      if (schema.format === 'uri') return 'https://example.test';
      return 'example';
    default:
      return null;
  }
}

function jsonMedia(content: Record<string, MediaType> | undefined): MediaType | undefined {
  if (!content) return undefined;
  const key = Object.keys(content).find((k) => /json/i.test(k)) ?? Object.keys(content)[0];
  return key ? content[key] : undefined;
}

function mediaExample(m: MediaType | undefined): unknown {
  if (!m) return undefined;
  if (m.example !== undefined) return m.example;
  const first = m.examples ? Object.values(m.examples)[0]?.value : undefined;
  return first ?? sample(m.schema);
}

/** Replaces password-like example values with secrets so credentials never live in steps. */
function secretize(body: unknown, needed: Set<string>): unknown {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) {
    if (SECRET_FIELD.test(k) && typeof v === 'string') {
      const key = `api${k[0]!.toUpperCase()}${k.slice(1).replace(/[^A-Za-z0-9]/g, '')}`;
      needed.add(key);
      out[k] = `{{secret.${key}}}`;
    } else out[k] = v;
  }
  return out;
}

function wrongTypeValue(s: Schema | undefined): unknown {
  const type = Array.isArray(s?.type) ? s?.type[0] : s?.type;
  if (type === 'string') return 12345;
  if (type === 'integer' || type === 'number') return 'not-a-number';
  if (type === 'boolean') return 'yes';
  if (type === 'array') return 'not-an-array';
  if (type === 'object') return 'not-an-object';
  return 12345;
}

function pickStatus(
  responses: Operation['responses'],
  prefer: string[],
  fallbackPrefix: string,
  fallback: number,
): number {
  const codes = Object.keys(responses ?? {});
  for (const p of prefer) if (codes.includes(p)) return Number(p);
  const any = codes.find((c) => c.startsWith(fallbackPrefix));
  return any ? Number(any) : fallback;
}

type LoginInfo = { method: string; path: string; body: unknown; tokenField: string };

/** Finds a login operation: POST to an auth-ish path whose success response carries a token field. */
function detectLogin(doc: OpenApiDoc, needed: Set<string>): LoginInfo | null {
  for (const [path, item] of Object.entries(doc.paths ?? {})) {
    const op = item.post as Operation | undefined;
    if (!op || !/(auth|login|token|session|signin)/i.test(path)) continue;
    const ok = Object.entries(op.responses ?? {}).find(([c]) => c.startsWith('2'))?.[1];
    const schema = merged(jsonMedia(ok?.content)?.schema);
    const tokenField = Object.keys(schema?.properties ?? {}).find((k) =>
      /^(access_?token|token|jwt|id_?token)$/i.test(k),
    );
    if (!tokenField) continue;
    return {
      method: 'POST',
      path,
      body: secretize(mediaExample(jsonMedia(op.requestBody?.content)), needed),
      tokenField,
    };
  }
  return null;
}

/**
 * Generates an API test suite from an OpenAPI document: per operation a happy-path test (spec examples,
 * status + JSON Schema + response time) and rule-based negative tests. Secured operations authenticate
 * through a generated "Authenticate" block when a login operation is detected.
 */
export async function importOpenApi(input: unknown, opts: OpenApiOptions = {}): Promise<ImportPlan> {
  const doc = await loadOpenApi(input);
  const negative = opts.negative ?? true;
  const maxRequired = opts.maxRequiredFieldTests ?? 3;
  const timeMs = opts.responseTimeMs ?? 2000;
  const prefix = basePath(doc);
  const warnings: string[] = [];
  const needed = new Set<string>();
  const login = detectLogin(doc, needed);
  const ops = listOperations(doc);
  const anySecured = ops.some((o) => o.secured);
  const authHeaders: Record<string, string> = {};
  const blocks: ImportPlan['blocks'] = [];

  if (anySecured && login) {
    blocks.push({
      key: 'auth',
      name: 'Authenticate (API)',
      description: `Generated from ${login.method} ${login.path}`,
      steps: [
        {
          type: 'api.request',
          label: 'Get a bearer token',
          params: { method: login.method, url: `{{env.baseUrl}}${prefix}${login.path}`, body: login.body },
          assertions: [{ target: 'status', operator: 'lt', expected: 300 }],
          captureAs: 'auth',
        },
      ],
    });
    authHeaders.authorization = `Bearer {{vars.auth.${login.tokenField}}}`;
  } else if (anySecured) {
    const schemes = doc.components?.securitySchemes ?? doc.securityDefinitions ?? {};
    const apiKey = Object.values(schemes).find((s) => s.type === 'apiKey' && s.in === 'header');
    if (apiKey?.name) {
      authHeaders[apiKey.name.toLowerCase()] = '{{secret.apiKey}}';
      needed.add('apiKey');
    } else {
      authHeaders.authorization = 'Bearer {{secret.apiToken}}';
      needed.add('apiToken');
    }
    warnings.push('No login operation found: secured requests use a secret token. Set it per environment.');
  }

  const modules = new Map<string, PlannedModule>();
  const moduleFor = (tag: string) => {
    let m = modules.get(tag);
    if (!m) modules.set(tag, (m = { name: tag, scenarios: [] }));
    return m;
  };
  let happy = 0;
  let neg = 0;
  let skippedDestructive = 0;

  for (const [path, item] of Object.entries(doc.paths ?? {})) {
    const shared = (Array.isArray(item.parameters) ? item.parameters : []) as Parameter[];
    for (const method of METHODS) {
      const op = item[method] as Operation | undefined;
      if (!op) continue;
      if (op.deprecated) {
        warnings.push(`${method.toUpperCase()} ${path} is deprecated: skipped`);
        continue;
      }
      const M = method.toUpperCase();
      const title = `${M} ${path}`;
      const mod = moduleFor(
        op.tags?.[0] ??
          path
            .split('/')
            .filter(Boolean)
            .find((s) => !/^(api|v\d+)$/i.test(s) && !s.startsWith('{')) ??
          'default',
      );
      const secured = isSecured(doc, op);
      const params = [...shared, ...(op.parameters ?? [])];
      const pathParams = params.filter((p) => p.in === 'path');
      const query: Record<string, unknown> = {};
      for (const p of params.filter((x) => x.in === 'query' && (x.required || x.example !== undefined)))
        query[p.name] = p.example ?? sample(p.schema);
      const urlFor = (overrides: Record<string, unknown> = {}) =>
        `{{env.baseUrl}}${prefix}${path.replace(/\{([^}]+)\}/g, (_m, n: string) => {
          const p = pathParams.find((x) => x.name === n);
          return encodeURIComponent(String(overrides[n] ?? p?.example ?? sample(p?.schema) ?? 1));
        })}`;
      const media = jsonMedia(op.requestBody?.content);
      const bodySchema = merged(media?.schema);
      const exampleBody = op.requestBody ? secretize(mediaExample(media), needed) : undefined;
      const okEntry = Object.entries(op.responses ?? {}).find(([c]) => /^2/.test(c));
      const okStatus = okEntry ? Number(okEntry[0]) : 200;
      const okSchema = jsonMedia(okEntry?.[1].content)?.schema;

      const steps = (
        request: Record<string, unknown>,
        assertions: Assertion[],
        withAuth = secured,
      ): PlannedStep[] => [
        ...(withAuth && login
          ? [{ type: 'util.useBlock', label: 'Authenticate', params: { blockId: blockRef('auth') } }]
          : []),
        {
          type: 'api.request',
          params: {
            method: M,
            ...request,
            headers: {
              ...(withAuth ? authHeaders : {}),
              ...((request.headers as Record<string, string>) ?? {}),
            },
            ...(opts.specId ? { contract: { specId: opts.specId } } : {}),
          },
          assertions,
        },
      ];
      const add = (s: PlannedScenario) => mod.scenarios.push(s);
      const base = {
        url: urlFor(),
        ...(Object.keys(query).length && { query }),
        ...(exampleBody !== undefined && { body: exampleBody }),
      };

      if (M === 'DELETE' && !opts.destructive) {
        skippedDestructive++;
      } else {
        happy++;
        add({
          name: `${title} — happy path`,
          description: op.summary,
          priority: M === 'GET' ? 'P2' : 'P1',
          tags: ['api', 'happy-path', ...(M === 'DELETE' ? ['destructive'] : [])],
          steps: steps(base, [
            { target: 'status', operator: 'equals', expected: okStatus },
            ...(okSchema ? [{ target: 'body', operator: 'matchesSchema' as const, expected: okSchema }] : []),
            { target: 'time', operator: 'lt', expected: timeMs },
          ]),
        });
      }
      if (!negative) continue;

      if (secured) {
        neg++;
        add({
          name: `${title} — unauthorized`,
          priority: 'P1',
          tags: ['api', 'negative', 'security'],
          steps: steps(
            { ...base, cookies: false },
            [
              {
                target: 'status',
                operator: 'equals',
                expected: pickStatus(op.responses, ['401', '403'], '4', 401),
              },
            ],
            false,
          ),
        });
      }
      const idParam = pathParams.find((p) => /id$/i.test(p.name));
      if (idParam && Object.keys(op.responses ?? {}).includes('404')) {
        neg++;
        add({
          name: `${title} — not found`,
          priority: 'P3',
          tags: ['api', 'negative'],
          steps: steps({ ...base, url: urlFor({ [idParam.name]: 999999 }) }, [
            { target: 'status', operator: 'equals', expected: 404 },
          ]),
        });
      }
      if (bodySchema?.properties && exampleBody && typeof exampleBody === 'object') {
        const badStatus = pickStatus(op.responses, ['422', '400'], '4', 400);
        for (const field of (bodySchema.required ?? []).slice(0, maxRequired)) {
          const body = { ...(exampleBody as Record<string, unknown>) };
          delete body[field];
          neg++;
          add({
            name: `${title} — missing ${field}`,
            priority: 'P2',
            tags: ['api', 'negative', 'validation'],
            steps: steps({ ...base, body }, [{ target: 'status', operator: 'equals', expected: badStatus }]),
          });
        }
        const firstRequired = bodySchema.required?.[0];
        if (firstRequired) {
          neg++;
          add({
            name: `${title} — wrong type for ${firstRequired}`,
            priority: 'P3',
            tags: ['api', 'negative', 'validation'],
            steps: steps(
              {
                ...base,
                body: {
                  ...(exampleBody as Record<string, unknown>),
                  [firstRequired]: wrongTypeValue(bodySchema.properties[firstRequired]),
                },
              },
              [{ target: 'status', operator: 'equals', expected: badStatus }],
            ),
          });
        }
        const enumField = Object.entries(bodySchema.properties).find(([, s]) => merged(s)?.enum?.length)?.[0];
        if (enumField) {
          neg++;
          add({
            name: `${title} — invalid ${enumField}`,
            priority: 'P3',
            tags: ['api', 'negative', 'validation'],
            steps: steps(
              {
                ...base,
                body: { ...(exampleBody as Record<string, unknown>), [enumField]: 'INVALID_ENUM_VALUE' },
              },
              [{ target: 'status', operator: 'equals', expected: badStatus }],
            ),
          });
        }
      }
    }
  }
  if (skippedDestructive)
    warnings.push(
      `${skippedDestructive} DELETE operation(s): only negative tests generated (enable destructive tests to include happy paths).`,
    );

  const title = doc.info?.title ?? 'API';
  return {
    root: {
      name: `${title} (OpenAPI)`,
      description: `Generated from ${title} ${doc.info?.version ?? ''}`.trim(),
      scenarios: [],
      children: [...modules.values()],
    },
    blocks,
    secretsNeeded: [...needed],
    variables: { baseUrl: '' },
    warnings,
    stats: { operations: ops.length, happyPath: happy, negative: neg },
  };
}

/** Finds the operation matching a concrete request, for contract checks. */
export function matchOperation(
  doc: OpenApiDoc,
  method: string,
  url: string,
): { path: string; op: Operation } | null {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    pathname = url.split('?')[0]!;
  }
  const prefix = basePath(doc);
  if (prefix && pathname.startsWith(prefix)) pathname = pathname.slice(prefix.length) || '/';
  const candidates = Object.keys(doc.paths ?? {}).sort(
    (a, b) => (a.match(/\{/g)?.length ?? 0) - (b.match(/\{/g)?.length ?? 0),
  );
  for (const path of candidates) {
    const re = new RegExp(
      `^${path.replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/\\?\{[^}]+\\?\}/g, '[^/]+')}/?$`,
    );
    const op = doc.paths![path]![method.toLowerCase()] as Operation | undefined;
    if (op && re.test(pathname)) return { path, op };
  }
  return null;
}

/** Expected response definition for a status ("201", then "2XX", then "default"). */
export function responseFor(op: Operation, status: number) {
  const r = op.responses ?? {};
  return r[String(status)] ?? r[`${String(status)[0]}XX`] ?? r.default;
}

export function responseSchema(op: Operation, status: number): Schema | undefined {
  return jsonMedia(responseFor(op, status)?.content)?.schema;
}
