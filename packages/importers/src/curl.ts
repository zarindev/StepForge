import type { PlannedStep } from './plan.ts';

/** Shell-like tokenizer: single/double quotes, backslash escapes and line continuations. */
export function tokenize(cmd: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  let has = false;
  const s = cmd.replace(/\\\r?\n/g, ' ');
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (quote === "'") {
      if (c === "'") quote = null;
      else cur += c;
    } else if (quote === '"') {
      if (c === '"') quote = null;
      else if (c === '\\' && i + 1 < s.length && '"\\$`'.includes(s[i + 1]!)) cur += s[++i];
      else cur += c;
    } else if (c === "'" || c === '"') {
      quote = c;
      has = true;
    } else if (c === '\\' && i + 1 < s.length) {
      cur += s[++i];
      has = true;
    } else if (/\s/.test(c)) {
      if (cur || has) out.push(cur);
      cur = '';
      has = false;
    } else {
      cur += c;
      has = true;
    }
  }
  if (quote) throw new Error('Unterminated quote in cURL command');
  if (cur || has) out.push(cur);
  return out;
}

/** Converts a cURL command (as copied from browser devtools) into an `api.request` step. */
export function importCurl(cmd: string): PlannedStep {
  const t = tokenize(cmd.trim());
  if (t[0] !== 'curl') throw new Error('Paste a command starting with "curl"');
  let method: string | undefined;
  let url = '';
  const headers: Record<string, string> = {};
  const data: string[] = [];
  const form: Record<string, unknown> = {};
  let auth: Record<string, string> | undefined;
  let get = false;
  let json = false;
  for (let i = 1; i < t.length; i++) {
    const a = t[i]!;
    const next = () => t[++i] ?? '';
    if (a === '-X' || a === '--request') method = next().toUpperCase();
    else if (a === '-H' || a === '--header') {
      const h = next();
      const idx = h.indexOf(':');
      if (idx > 0) headers[h.slice(0, idx).trim().toLowerCase()] = h.slice(idx + 1).trim();
    } else if (
      ['-d', '--data', '--data-raw', '--data-binary', '--data-ascii', '--data-urlencode'].includes(a)
    )
      data.push(next());
    else if (a === '--json') {
      data.push(next());
      json = true;
    } else if (a === '-F' || a === '--form') {
      const f = next();
      const idx = f.indexOf('=');
      const v = f.slice(idx + 1);
      form[f.slice(0, idx)] = v.startsWith('@') ? { file: v.slice(1) } : v;
    } else if (a === '-u' || a === '--user') {
      const [username, ...rest] = next().split(':');
      auth = { type: 'basic', username: username ?? '', password: rest.join(':') };
    } else if (a === '-b' || a === '--cookie') headers.cookie = next();
    else if (a === '-A' || a === '--user-agent') headers['user-agent'] = next();
    else if (a === '-e' || a === '--referer') headers.referer = next();
    else if (a === '-G' || a === '--get') get = true;
    else if (a === '-I' || a === '--head') method = 'HEAD';
    else if (a === '--url') url = next();
    else if (['-o', '--output', '-w', '--write-out', '-m', '--max-time', '--connect-timeout'].includes(a))
      next();
    else if (a.startsWith('-'))
      continue; // -L, -k, -s, --compressed and other flags without values
    else url = a;
  }
  if (!url) throw new Error('No URL found in the cURL command');
  if (json) {
    headers['content-type'] ??= 'application/json';
    headers.accept ??= 'application/json';
  }
  const params: Record<string, unknown> = {
    method: method ?? (data.length || Object.keys(form).length ? 'POST' : 'GET'),
    url,
    headers,
  };
  if (get && data.length) {
    const u = new URL(url);
    for (const d of data) new URLSearchParams(d).forEach((v, k) => u.searchParams.append(k, v));
    params.url = u.toString();
    params.method = method ?? 'GET';
  } else if (Object.keys(form).length) {
    params.body = form;
    params.bodyType = 'multipart';
  } else if (data.length) {
    const raw = data.join('&');
    try {
      params.body = JSON.parse(raw);
      params.bodyType = 'json';
    } catch {
      if (/x-www-form-urlencoded/.test(headers['content-type'] ?? '') || /^[\w.%-]+=/.test(raw)) {
        params.body = Object.fromEntries(new URLSearchParams(raw));
        params.bodyType = 'form';
      } else {
        params.body = raw;
        params.bodyType = 'raw';
      }
    }
  }
  if (auth) params.auth = auth;
  const path = (() => {
    try {
      return new URL(String(params.url)).pathname;
    } catch {
      return String(params.url);
    }
  })();
  return {
    type: 'api.request',
    label: `${String(params.method)} ${path}`,
    params,
    assertions: [{ target: 'status', operator: 'lt', expected: 400 }],
  };
}
