// JSON Schema checks for tests exported by StepForge (by Md Zarin Tasnim), with Ajv as StepForge uses it.
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

/** OpenAPI 3.0 `nullable: true` becomes JSON Schema, so null values validate. */
function normalize(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(normalize);
  if (!schema || typeof schema !== 'object') return schema;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(schema)) out[k] = normalize(v);
  if (out.nullable === true && typeof out.type === 'string') out.type = [out.type, 'null'];
  return out;
}

function message(e: ErrorObject): string {
  const at = e.instancePath ? e.instancePath.replace(/^\//, '').replace(/\//g, '.') : 'body';
  if (e.keyword === 'required')
    return `${at === 'body' ? '' : `${at}.`}${String(e.params.missingProperty)} is required but missing`;
  if (e.keyword === 'additionalProperties')
    return `${at} has unexpected property "${String(e.params.additionalProperty)}"`;
  return `${at} ${e.message ?? 'is invalid'}`;
}

/** Fails the test unless the value matches the JSON Schema, naming the fields that do not. */
export function expectSchema(value: unknown, schema: object, what: string): void {
  const validate = ajv.compile(normalize(schema) as object);
  if (!validate(value))
    throw new Error(`${what}: ${(validate.errors ?? []).slice(0, 10).map(message).join('; ')}`);
}
