// Web Crypto (Node 22+ and browsers) so this module also runs in the dashboard.
const randomUUID = (): string => globalThis.crypto.randomUUID();
const randomInt = (min: number, max: number): number => {
  const buf = new Uint32Array(1);
  globalThis.crypto.getRandomValues(buf);
  return min + ((buf[0] ?? 0) % (max - min));
};

/**
 * Variable resolution for `{{scope.path}}` placeholders (Section 5).
 * Scopes: env, secret, data, run, random, vars.
 */
export type VariableScopes = {
  env?: Record<string, unknown>;
  secret?: Record<string, string>;
  data?: Record<string, unknown>;
  run?: Record<string, unknown>;
  vars?: Record<string, unknown>;
};

export class VariableResolutionError extends Error {
  constructor(
    public readonly expression: string,
    reason: string,
  ) {
    super(`Cannot resolve {{${expression}}}: ${reason}`);
    this.name = 'VariableResolutionError';
  }
}

const PLACEHOLDER = /\{\{\s*([A-Za-z_][\w]*(?:\.[\w-]+)*)\s*\}\}/g;
const WHOLE_PLACEHOLDER = /^\{\{\s*([A-Za-z_][\w]*(?:\.[\w-]+)*)\s*\}\}$/;
export const MASK = '••••';

const RANDOM_GENERATORS: Record<string, () => string | number> = {
  uuid: () => randomUUID(),
  email: () => `sf.${Date.now().toString(36)}${randomInt(1000, 9999)}@example.test`,
  number: () => randomInt(0, 1_000_000),
  digits6: () => String(randomInt(0, 1_000_000)).padStart(6, '0'),
  string: () => Math.random().toString(36).slice(2, 10),
  timestamp: () => Date.now(),
};

export class VariableResolver {
  /** Secret values actually used during resolution; masked in logs/reports. */
  private readonly usedSecrets = new Set<string>();

  constructor(private readonly scopes: VariableScopes) {}

  lookup(expression: string): unknown {
    const [scope, ...path] = expression.split('.');
    if (scope === 'random') {
      const gen = RANDOM_GENERATORS[path.join('.')];
      if (!gen) throw new VariableResolutionError(expression, `unknown random generator "${path.join('.')}"`);
      return gen();
    }
    if (!scope || !['env', 'secret', 'data', 'run', 'vars'].includes(scope)) {
      throw new VariableResolutionError(expression, `unknown scope "${scope}"`);
    }
    if (path.length === 0) throw new VariableResolutionError(expression, 'missing key');
    let current: unknown = this.scopes[scope as keyof VariableScopes];
    for (const segment of path) {
      if (current === null || typeof current !== 'object' || !(segment in current)) {
        throw new VariableResolutionError(expression, 'not defined');
      }
      current = (current as Record<string, unknown>)[segment];
    }
    if (scope === 'secret' && typeof current === 'string' && current.length > 0)
      this.usedSecrets.add(current);
    return current;
  }

  /**
   * Resolves placeholders in any JSON-like value. A string that is exactly one placeholder
   * returns the raw value (so numbers/objects keep their type); otherwise values are interpolated.
   */
  resolve<T>(value: T): T {
    if (typeof value === 'string') return this.resolveString(value) as T;
    if (Array.isArray(value)) return value.map((v) => this.resolve(v)) as T;
    if (value !== null && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) out[k] = this.resolve(v);
      return out as T;
    }
    return value;
  }

  private resolveString(input: string): unknown {
    const whole = WHOLE_PLACEHOLDER.exec(input);
    if (whole?.[1]) return this.lookup(whole[1]);
    return input.replace(PLACEHOLDER, (_m, expr: string) => {
      const v = this.lookup(expr);
      return typeof v === 'string' ? v : JSON.stringify(v);
    });
  }

  setVar(name: string, value: unknown): void {
    this.scopes.vars ??= {};
    this.scopes.vars[name] = value;
  }

  /** Saves variables, to put them back later (a loop's index and item inside another loop). */
  saveVars(names: string[]): () => void {
    const vars = (this.scopes.vars ??= {});
    const saved = names.map((n) => [n, Object.hasOwn(vars, n), vars[n]] as const);
    return () => {
      for (const [n, had, v] of saved) {
        if (had) vars[n] = v;
        else delete vars[n];
      }
    };
  }

  /** Copy of captured variables with secret values masked. */
  snapshotVars(): Record<string, unknown> {
    return this.maskDeep(this.scopes.vars ?? {});
  }

  /**
   * A copy of any value with every secret masked: in strings (and object keys), and numbers or booleans that are a
   * secret themselves (a PIN 1234). Walks the value rather than its JSON text, so secrets with quotes or backslashes
   * are found and the result is never broken JSON.
   */
  maskDeep<T>(value: T): T {
    const secrets = this.secretList();
    if (!secrets.length) return value;
    const maskText = (t: string) => this.mask(t);
    const seen = new WeakMap<object, unknown>();
    const walk = (v: unknown): unknown => {
      if (typeof v === 'string') return maskText(v);
      if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint')
        return secrets.includes(String(v)) ? MASK : v;
      if (!v || typeof v !== 'object') return v;
      if (seen.has(v)) return seen.get(v);
      if (Array.isArray(v)) {
        const out: unknown[] = [];
        seen.set(v, out);
        for (const x of v) out.push(walk(x));
        return out;
      }
      // Plain data only (results are JSON): other objects (dates, buffers) as their JSON form.
      if (Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null)
        return walk(JSON.parse(JSON.stringify(v) ?? 'null'));
      const out: Record<string, unknown> = {};
      seen.set(v, out);
      for (const [k, x] of Object.entries(v)) out[maskText(k)] = walk(x);
      return out;
    };
    return walk(value) as T;
  }

  private secretList(): string[] {
    const secrets = new Set([...this.usedSecrets, ...Object.values(this.scopes.secret ?? {})]);
    return [...secrets]
      .filter((s) => typeof s === 'string' && s.length > 0)
      .sort((a, b) => b.length - a.length);
  }

  /** Replaces every known secret value in `text` with the mask. */
  mask(text: string): string {
    let out = text;
    for (const s of this.secretList()) out = out.split(s).join(MASK);
    return out;
  }
}

/** Lists every placeholder expression referenced in a value (for validation/UI hints). */
export function findPlaceholders(value: unknown): string[] {
  const found = new Set<string>();
  const walk = (v: unknown) => {
    if (typeof v === 'string') {
      for (const m of v.matchAll(PLACEHOLDER)) if (m[1]) found.add(m[1]);
    } else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(value);
  return [...found];
}
