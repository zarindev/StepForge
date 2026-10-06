import Ajv, { type ErrorObject } from 'ajv';
import addFormats from 'ajv-formats';

const ajv = new Ajv({ allErrors: true, strict: false, validateFormats: true });
addFormats(ajv);
// OpenAPI keywords that are not JSON Schema: tolerated, not enforced.
for (const k of [
  'example',
  'xml',
  'externalDocs',
  'discriminator',
  'nullable',
  'deprecated',
  'readOnly',
  'writeOnly',
]) {
  try {
    ajv.addKeyword(k);
  } catch {
    // already known to Ajv
  }
}

export type SchemaResult = { ok: boolean; errors: string[] };

/** Converts OpenAPI 3.0 `nullable: true` into JSON Schema so null values validate. */
export function normalizeOpenApiSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(normalizeOpenApiSchema);
  if (!schema || typeof schema !== 'object') return schema;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(schema)) out[k] = normalizeOpenApiSchema(v);
  if (out.nullable === true && typeof out.type === 'string') out.type = [out.type, 'null'];
  return out;
}

function formatError(e: ErrorObject): string {
  const at = e.instancePath ? e.instancePath.replace(/^\//, '').replace(/\//g, '.') : 'body';
  if (e.keyword === 'required')
    return `${at === 'body' ? '' : `${at}.`}${String(e.params.missingProperty)} is required but missing`;
  if (e.keyword === 'type') return `${at} should be ${String(e.params.type)}`;
  if (e.keyword === 'enum') return `${at} should be one of ${JSON.stringify(e.params.allowedValues)}`;
  if (e.keyword === 'additionalProperties')
    return `${at} has unexpected property "${String(e.params.additionalProperty)}"`;
  return `${at} ${e.message ?? 'is invalid'}`;
}

/** Validates a value against a JSON Schema, returning field-level messages. */
export function validateSchema(schema: unknown, value: unknown): SchemaResult {
  let validate;
  try {
    validate = ajv.compile(normalizeOpenApiSchema(schema) as object);
  } catch (err) {
    return { ok: false, errors: [`Invalid schema: ${(err as Error).message}`] };
  }
  const ok = validate(value) as boolean;
  return { ok, errors: ok ? [] : (validate.errors ?? []).slice(0, 10).map(formatError) };
}
